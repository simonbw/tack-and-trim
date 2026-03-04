#!/usr/bin/env python3
"""
Analyze a samply profile of wavemesh-builder.

Reads the Firefox Profiler JSON (profile-samply.json) and its symbol sidecar
(profile-samply.syms.json), resolves addresses to function names, and prints
a categorized performance summary.
"""

import json
import re
import sys
import os
import subprocess
from bisect import bisect_right
from collections import Counter, defaultdict
from pathlib import Path

try:
    import orjson

    def _json_load(f):
        return orjson.loads(f.read())
except ImportError:
    def _json_load(f):
        return json.load(f)

SCRIPT_DIR = Path(__file__).parent
DEFAULT_PROFILE = SCRIPT_DIR / "profile-samply.json"
DEFAULT_SYMS = SCRIPT_DIR / "profile-samply.syms.json"
MACHO_TEXT_BASE = 0x100000000
ATOS_CACHE_FILE = SCRIPT_DIR / "profile-samply.atos-cache.json"


WRAPPER_SUBSTRINGS = [
    "<rayon_core::job::HeapJob",
    "<rayon_core::job::StackJob",
    "rayon_core::join::join_context::{{closure}}",
    "rayon_core::join::join_context::",
    "rayon::iter::plumbing::bridge_producer_consumer::helper",
    "rayon::iter::plumbing::bridge_producer_consumer",
    "rayon::iter::plumbing::bridge",
    "rayon_core::registry::in_worker",
    "rayon_core::registry::WorkerThread::wait_until",
    "rayon_core::registry::Registry::in_worker_cold",
    "rayon_core::job::JobRef::execute",
    "std::thread::Builder::spawn_unchecked",
    "core::ops::function::impls::<impl core::ops::function::FnMut",
    "core::ops::function::impls::<impl core::ops::function::FnOnce",
    "core::ops::function::impls::_<impl core::ops::function::FnOnce",
    "core::ops::function::impls::_<impl core::ops::function::FnMut",
    "core::ops::function::FnOnce::call_once",
    "_<alloc::boxed::Box<F$C$A> as core::ops::function::FnOnce<Args>>::call_once",
    "std::sys::backtrace::__rust_begin_short_backtrace",
    "_pthread_start",
]


def load_symbol_table(syms_path):
    """Load the sidecar symbol table and build RVA->name lookup per library."""
    with open(syms_path, "rb") as f:
        syms_data = _json_load(f)

    string_table = syms_data["string_table"]
    # Build per-debugName lookup: sorted list of (rva, name)
    lib_symbols = {}
    for entry in syms_data["data"]:
        debug_name = entry["debug_name"]
        symbols = entry.get("symbol_table", [])
        if not symbols:
            continue
        # Sort by rva for binary search
        sorted_syms = sorted(symbols, key=lambda s: s["rva"])
        rvas = [s["rva"] for s in sorted_syms]
        names = [string_table[s["symbol"]] for s in sorted_syms]
        sizes = [s.get("size", 0) for s in sorted_syms]
        lib_symbols[debug_name] = (rvas, names, sizes)

    return lib_symbols


def resolve_address(lib_symbols, lib_name, address):
    """Resolve an address to a function name using binary search."""
    if lib_name not in lib_symbols:
        return None
    rvas, names, sizes = lib_symbols[lib_name]
    idx = bisect_right(rvas, address) - 1
    if idx < 0:
        return None
    # Check if address is within the symbol's range
    if sizes[idx] > 0 and address >= rvas[idx] + sizes[idx]:
        return None
    return names[idx]


def categorize(name):
    """Categorize a function name into a performance bucket."""
    if name is None:
        return "unknown"

    n = name.lower()

    # Idle / scheduling
    if any(k in n for k in ["__psynch_cvwait", "thread_switch", "swtch_pri",
                             "workq_kernreturn", "__semwait", "kevent"]):
        return "idle"

    # Rayon overhead
    if "rayon" in n and any(k in n for k in ["sleep", "wait", "steal", "find_work"]):
        return "idle"
    if "rayon" in n:
        return "rayon-overhead"

    # crossbeam / parking
    if "crossbeam" in n or "parking_lot" in n:
        return "rayon-overhead"

    # Terrain
    if "containment" in n or "winding_number" in n or "rasterize_edge" in n:
        return "terrain-containment"
    if "idw" in n or "terrain_height_and_gradient" in n or "compute_terrain" in n:
        return "terrain-idw"
    if "terrain" in n:
        return "terrain-other"

    # Marching / wavefront
    if "advance_track" in n or "advance_ray" in n:
        return "marching"
    if "split" in n or "merge" in n or "flush" in n:
        return "marching"
    if "wavefront" in n and "drop" not in n:
        return "marching"

    # Refinement
    if "refine" in n:
        return "refinement"

    # Decimation
    if "decimate" in n or "segment_scanner" in n or "douglas_peucker" in n:
        return "decimation"

    # Triangulation
    if "triangulat" in n or "build_mesh" in n or "delaunay" in n:
        return "triangulation"

    # Post-processing (catch-all for post_process)
    if "post_process" in n:
        return "post-processing"

    # Memory
    if any(k in n for k in ["malloc", "free", "realloc", "madvise",
                             "raw_vec", "grow_one", "alloc"]):
        return "memory"

    # Serde / IO
    if "serde" in n or "json" in n:
        return "serde-io"

    # Math libs
    if "libsystem_m" in n or "vdsp" in n or "veclib" in n:
        return "math-lib"

    # Hashing
    if "hash" in n:
        return "hashing"

    # Sort
    if "sort" in n or "driftsort" in n or "quicksort" in n:
        return "sorting"

    # Drop / dealloc
    if "drop_in_place" in n:
        return "drop"

    return "other"


def is_wrapper_frame(name):
    """Heuristic: identify generic scheduler/closure wrappers."""
    if not name:
        return False
    return any(k in name for k in WRAPPER_SUBSTRINGS)


def clean_symbol_name(name):
    """Normalize Rust mangled-ish display into more readable text."""
    if not name:
        return name
    out = re.sub(r"::h[0-9a-f]{16}$", "", name)
    out = out.replace("_$u7b$$u7b$closure$u7d$$u7d$", "{{closure}}")
    out = out.replace("$LT$", "<").replace("$GT$", ">")
    out = out.replace("$u20$", " ")
    out = out.replace("$RF$", "&")
    out = out.replace("$LP$", "(").replace("$RP$", ")")
    out = out.replace("..", "::")
    return out


def extract_atos_innermost_name(atos_group):
    """Pick innermost inline function from one atos -i result group."""
    for line in atos_group:
        line = line.strip()
        if not line:
            continue
        # Format: func (in binary) (...).
        m = re.match(r"^(.+?)\s+\(in .+?\)\s*(?:\(.+\))?$", line)
        if m:
            return clean_symbol_name(m.group(1))
        return clean_symbol_name(line)
    return None


def resolve_inline_names_with_atos(binary_path, rvas):
    """Resolve RVAs to innermost inlined function via atos -i."""
    if not rvas:
        return {}
    if not binary_path or not os.path.exists(binary_path):
        return {}

    rva_list = sorted(rvas)
    abs_addrs = [hex(MACHO_TEXT_BASE + rva) for rva in rva_list]
    cmd = [
        "atos",
        "-i",
        "-o",
        binary_path,
        "-l",
        hex(MACHO_TEXT_BASE),
        *abs_addrs,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        return {}

    # atos emits one group per input address, groups separated by blank lines.
    groups = []
    current = []
    for line in result.stdout.splitlines():
        if line.strip():
            current.append(line)
            continue
        if current:
            groups.append(current)
            current = []
    if current:
        groups.append(current)

    if len(groups) != len(rva_list):
        return {}

    resolved = {}
    for rva, group in zip(rva_list, groups):
        name = extract_atos_innermost_name(group)
        if name:
            resolved[rva] = name
    return resolved


def load_atos_cache(binary_path):
    """Load persisted atos results; returns (cache_dict, binary_mtime)."""
    if not binary_path or not os.path.exists(binary_path):
        return {}, None
    binary_mtime = os.path.getmtime(binary_path)
    if ATOS_CACHE_FILE.exists():
        try:
            with open(ATOS_CACHE_FILE) as f:
                data = json.load(f)
            if data.get("binary_mtime") == binary_mtime and data.get("binary_path") == binary_path:
                # Keys are stored as strings in JSON; convert back to int.
                return {int(k): v for k, v in data["entries"].items()}, binary_mtime
        except Exception:
            pass
    return {}, binary_mtime


def save_atos_cache(binary_path, binary_mtime, cache):
    """Persist atos results to disk for future runs."""
    if not binary_path or binary_mtime is None:
        return
    try:
        with open(ATOS_CACHE_FILE, "w") as f:
            json.dump({"binary_path": binary_path, "binary_mtime": binary_mtime, "entries": cache}, f)
    except Exception:
        pass


CATEGORY_ORDER = [
    "terrain-idw",
    "terrain-containment",
    "terrain-other",
    "marching",
    "refinement",
    "decimation",
    "post-processing",
    "triangulation",
    "sorting",
    "hashing",
    "memory",
    "drop",
    "serde-io",
    "math-lib",
    "rayon-overhead",
    "other",
    "unknown",
    "idle",
]


def is_worker_thread_name(name):
    """Heuristic: Rayon worker threads sampled by samply."""
    return bool(name) and name.startswith("Thread <")


def percentile(values, p):
    """Linear-interpolated percentile for a list of floats."""
    if not values:
        return 0.0
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    rank = (len(xs) - 1) * (p / 100.0)
    lo = int(rank)
    hi = min(lo + 1, len(xs) - 1)
    frac = rank - lo
    return xs[lo] * (1.0 - frac) + xs[hi] * frac


def load_wall_clock_ms(profile_path):
    """Load exact wall-clock from sidecar metadata if present."""
    meta_path = profile_path.replace(".json", ".meta.json")
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path) as f:
            data = json.load(f)
        wall_ms = data.get("wall_clock_ms")
        if wall_ms is None:
            return None
        return float(wall_ms)
    except Exception:
        return None


def analyze_profile(profile_path, syms_path):
    with open(profile_path, "rb") as f:
        profile = _json_load(f)
    wall_clock_ms = load_wall_clock_ms(profile_path)

    lib_symbols = load_symbol_table(syms_path)

    # Find wavemesh binary path from libs (for atos inline expansion).
    wavemesh_binary = None
    for lib in profile.get("libs", []):
        if lib.get("debugName") == "wavemesh-builder":
            wavemesh_binary = lib.get("debugPath") or lib.get("path")
            break

    threads = profile["threads"]
    interval_ms = profile["meta"]["interval"]

    total_samples = 0
    idle_samples = 0
    work_samples = 0

    # Per-function exclusive (self) sample counts
    func_self_counts = Counter()
    # Per-category sample counts (exclusive/self)
    cat_counts = Counter()
    # Per-function de-wrapped sample counts
    func_effective_counts = Counter()
    # Per-thread stats
    thread_stats = []
    # Cache RVA -> atos inlined name across threads (loaded from disk if available)
    inline_name_cache, _atos_binary_mtime = load_atos_cache(wavemesh_binary)
    _atos_cache_size_before = len(inline_name_cache)
    # Immediate non-wrapper caller attribution: leaf -> caller -> samples
    leaf_caller_counts = defaultdict(Counter)
    # First project frame (wavemesh_builder::...) on stack: global and per leaf.
    project_owner_counts = Counter()
    project_owner_by_leaf = defaultdict(Counter)

    # Worker-thread time-binned data for idle-overlap analysis
    worker_seen_by_bin = defaultdict(set)    # bin -> set(tid) with any sample
    worker_active_by_bin = defaultdict(set)  # bin -> set(tid) with non-idle sample
    worker_records_by_bin = defaultdict(list)  # bin -> list[(eff_name, cat, weight)]

    for thread in threads:
        samples = thread["samples"]
        n_samples = samples["length"]
        if n_samples == 0:
            continue

        frame_table = thread["frameTable"]
        func_table = thread["funcTable"]
        stack_table = thread["stackTable"]
        string_array = thread["stringArray"]
        resource_table = thread["resourceTable"]

        # Build resource -> lib name mapping
        resource_lib_names = {}
        for ri in range(resource_table["length"]):
            resource_lib_names[ri] = string_array[resource_table["name"][ri]]

        # Collect unresolved wavemesh RVAs for optional atos -i enrichment.
        missing_inline_rvas = set()
        for fi in range(func_table["length"]):
            resource_idx = func_table["resource"][fi]
            lib_name = resource_lib_names.get(resource_idx, "")
            if lib_name != "wavemesh-builder":
                continue
            address = frame_table["address"][fi]  # rva for samply-presymbolicated
            if address not in inline_name_cache:
                missing_inline_rvas.add(address)

        inline_name_cache.update(
            resolve_inline_names_with_atos(wavemesh_binary, missing_inline_rvas)
        )

        # Pre-resolve all function names and pre-compute per-func flags.
        n_funcs = func_table["length"]
        resolved_names = {}
        func_is_wrapper = [False] * n_funcs
        func_is_project = [False] * n_funcs
        for fi in range(n_funcs):
            raw_name = string_array[func_table["name"][fi]]
            resource_idx = func_table["resource"][fi]
            lib_name = resource_lib_names.get(resource_idx, "")
            address = frame_table["address"][fi]  # frame and func are 1:1 in this format

            resolved = resolve_address(lib_symbols, lib_name, address)
            resolved = clean_symbol_name(resolved) if resolved else None
            raw_name = clean_symbol_name(raw_name)

            inline_name = None
            if lib_name == "wavemesh-builder":
                inline_name = inline_name_cache.get(address)

            if inline_name and (
                resolved is None
                or is_wrapper_frame(resolved)
                or raw_name.startswith("0x")
            ):
                name = inline_name
            elif resolved:
                name = resolved
            else:
                name = raw_name
            resolved_names[fi] = name
            func_is_wrapper[fi] = is_wrapper_frame(name)
            func_is_project[fi] = name.startswith("wavemesh_builder::")

        # Pre-extract hot arrays to avoid repeated dict indexing in the sample loop.
        st_frame = stack_table["frame"]
        st_prefix = stack_table["prefix"]
        ft_func = frame_table["func"]
        s_stack = samples["stack"]
        s_weight = samples["weight"] if samples.get("weight") else None

        # Walk each sample
        t_idle = 0
        t_work = 0
        thread_name = thread["name"]
        thread_tid = thread["tid"]
        worker_thread = is_worker_thread_name(thread_name)
        time_deltas = samples.get("timeDeltas")
        time_ms = 0.0

        for si in range(n_samples):
            dt_ms = time_deltas[si] if time_deltas else interval_ms
            time_ms += dt_ms
            bin_idx = int(time_ms // interval_ms) if interval_ms > 0 else int(time_ms)
            if worker_thread:
                worker_seen_by_bin[bin_idx].add(thread_tid)

            stack_idx = s_stack[si]
            weight = s_weight[si] if s_weight is not None else 1

            # Get the leaf (top-of-stack) frame
            if stack_idx is None:
                continue

            leaf_frame = st_frame[stack_idx]
            leaf_func = ft_func[leaf_frame]
            leaf_name = resolved_names.get(leaf_func, "???")

            # Single combined stack walk: find effective_name, caller_name, project_owner.
            effective_name = leaf_name
            caller_name = None
            project_owner = None
            found_effective = False
            found_caller = False
            found_owner = False
            is_leaf_frame = True
            cur = stack_idx
            while cur is not None:
                func_idx = ft_func[st_frame[cur]]
                name = resolved_names.get(func_idx, "???")
                is_wrap = func_is_wrapper[func_idx]
                if not found_effective and not is_wrap:
                    effective_name = name
                    found_effective = True
                if not is_leaf_frame and not found_caller and not is_wrap:
                    caller_name = name
                    found_caller = True
                if not found_owner and func_is_project[func_idx]:
                    project_owner = name
                    found_owner = True
                if found_effective and found_caller and found_owner:
                    break
                is_leaf_frame = False
                cur = st_prefix[cur]

            cat = categorize(effective_name)

            if cat == "idle":
                t_idle += weight
                idle_samples += weight
            else:
                t_work += weight
                work_samples += weight
                func_self_counts[leaf_name] += weight
                func_effective_counts[effective_name] += weight
                cat_counts[cat] += weight
                if caller_name:
                    leaf_caller_counts[leaf_name][caller_name] += weight
                if project_owner:
                    project_owner_counts[project_owner] += weight
                    project_owner_by_leaf[leaf_name][project_owner] += weight
                if worker_thread:
                    worker_active_by_bin[bin_idx].add(thread_tid)
                    worker_records_by_bin[bin_idx].append((effective_name, cat, weight))

            total_samples += weight

        thread_stats.append({
            "name": thread_name,
            "tid": thread_tid,
            "samples": n_samples,
            "idle": t_idle,
            "work": t_work,
        })

    # Persist atos cache if we resolved new symbols.
    if len(inline_name_cache) > _atos_cache_size_before:
        save_atos_cache(wavemesh_binary, _atos_binary_mtime, inline_name_cache)

    # Print results
    duration_s = total_samples * interval_ms / 1000.0
    work_duration_s = work_samples * interval_ms / 1000.0

    print("=" * 72)
    print("SAMPLY PROFILE SUMMARY")
    print("=" * 72)
    print()
    print(f"Total samples: {total_samples:,}  ({duration_s:.1f}s at {1000/interval_ms:.0f}Hz)")
    print(f"Work samples:  {work_samples:,}  ({work_duration_s:.1f}s)")
    print(f"Idle samples:  {idle_samples:,}")
    if wall_clock_ms is not None:
        print(f"Recorded wall-clock: {wall_clock_ms / 1000.0:.2f}s")
    print()

    # Thread utilization
    print("-" * 72)
    print("THREAD UTILIZATION")
    print("-" * 72)
    active_threads = [t for t in thread_stats if t["samples"] > 0]
    active_threads.sort(key=lambda t: t["work"], reverse=True)
    for t in active_threads:
        total = t["idle"] + t["work"]
        if total == 0:
            continue
        pct = t["work"] / total * 100
        bar_len = int(pct / 2)
        bar = "#" * bar_len + "." * (50 - bar_len)
        print(f"  {t['name']:30s} [{bar}] {pct:5.1f}% work ({t['work']:,} / {total:,})")
    effective_cores = sum(t["work"] for t in active_threads) / max(
        max(t["work"] + t["idle"] for t in active_threads), 1
    )
    max_thread_samples = max((t["work"] + t["idle"] for t in active_threads), default=0)
    max_thread_secs = max_thread_samples * interval_ms / 1000.0
    worker_threads_for_wall = [t for t in active_threads if is_worker_thread_name(t["name"])]
    max_worker_samples = max((t["work"] + t["idle"] for t in worker_threads_for_wall), default=0)
    max_worker_secs = max_worker_samples * interval_ms / 1000.0

    print(f"\n  Effective cores: {effective_cores:.1f}")
    print(f"  Estimated wall-clock (process span): {max_thread_secs:.1f}s")
    if worker_threads_for_wall:
        print(f"  Estimated wall-clock (worker span):  {max_worker_secs:.1f}s")
    print()

    # Worker-only time-binned utilization and idle-overlap attribution.
    worker_threads = [
        t for t in active_threads
        if is_worker_thread_name(t["name"])
    ]
    n_workers = len(worker_threads)
    idle_overlap_func = Counter()
    idle_overlap_cat = Counter()
    util_ratios = []
    active_worker_counts = []
    total_idle_core_samples = 0.0

    if n_workers > 0:
        for bin_idx, seen in worker_seen_by_bin.items():
            total_present = len(seen)
            if total_present == 0:
                continue
            active_present = len(worker_active_by_bin.get(bin_idx, set()))
            idle_present = max(total_present - active_present, 0)

            util_ratios.append(active_present / total_present)
            active_worker_counts.append(active_present)
            total_idle_core_samples += idle_present

            if active_present == 0 or idle_present == 0:
                continue

            # Distribute each bin's idle cores across threads that were working.
            share = idle_present / active_present
            for eff_name, cat, weight in worker_records_by_bin.get(bin_idx, []):
                contrib = weight * share
                idle_overlap_func[eff_name] += contrib
                idle_overlap_cat[cat] += contrib

    print("-" * 72)
    print("WORKER TIMELINE (time-binned utilization)")
    print("-" * 72)
    if n_workers == 0 or not util_ratios:
        print("  No worker-thread timeline data available.")
    else:
        avg_active = sum(active_worker_counts) / len(active_worker_counts)
        p50_active = percentile(active_worker_counts, 50)
        p10_active = percentile(active_worker_counts, 10)
        low_util_bins = sum(1 for u in util_ratios if u < 0.5)
        low_util_pct = 100.0 * low_util_bins / len(util_ratios)
        print(f"  Worker threads detected: {n_workers}")
        print(f"  Avg active workers: {avg_active:.2f} / {n_workers}")
        print(f"  P50 active workers: {p50_active:.1f}, P10 active workers: {p10_active:.1f}")
        print(f"  Time bins below 50% worker utilization: {low_util_pct:.1f}%")
    print()

    print("-" * 72)
    print("IDLE-OVERLAP ATTRIBUTION (worker cores only)")
    print("-" * 72)
    if total_idle_core_samples <= 0:
        print("  No worker idle-overlap samples available.")
    else:
        idle_core_seconds = total_idle_core_samples * interval_ms / 1000.0
        print(f"  Total idle worker core-time: {idle_core_seconds:.1f}s")
        print("  Top categories during idle overlap:")
        for cat, count in idle_overlap_cat.most_common(8):
            pct = 100.0 * count / total_idle_core_samples
            secs = count * interval_ms / 1000.0
            print(f"    {cat:23s} {pct:5.1f}%  ({secs:5.1f}s)")
        print("  Top functions during idle overlap:")
        for name, count in idle_overlap_func.most_common(12):
            pct = 100.0 * count / total_idle_core_samples
            secs = count * interval_ms / 1000.0
            print(f"    {pct:5.1f}%  {secs:5.1f}s  {name}")
    print()

    # Category breakdown
    print("-" * 72)
    print("TIME BREAKDOWN (by category, de-wrapped self time)")
    print("-" * 72)
    for cat in CATEGORY_ORDER:
        count = cat_counts.get(cat, 0)
        if count == 0:
            continue
        pct = count / work_samples * 100
        secs = count * interval_ms / 1000.0
        bar_len = int(pct / 2)
        bar = "#" * bar_len
        print(f"  {cat:25s} {pct:5.1f}%  ({secs:6.1f}s)  {bar}")
    print()

    # Top functions
    print("-" * 72)
    print("TOP 25 FUNCTIONS (by leaf/self samples)")
    print("-" * 72)
    for name, count in func_self_counts.most_common(25):
        pct = count / work_samples * 100
        secs = count * interval_ms / 1000.0
        print(f"  {pct:5.1f}%  {secs:5.1f}s  {name}")
    print()

    print("-" * 72)
    print("TOP 25 FUNCTIONS (by de-wrapped self samples)")
    print("-" * 72)
    for name, count in func_effective_counts.most_common(25):
        pct = count / work_samples * 100
        secs = count * interval_ms / 1000.0
        print(f"  {pct:5.1f}%  {secs:5.1f}s  {name}")
    print()

    print("-" * 72)
    print("TOP PROJECT OWNERS (first wavemesh_builder frame on stack)")
    print("-" * 72)
    for name, count in project_owner_counts.most_common(20):
        pct = count / work_samples * 100
        secs = count * interval_ms / 1000.0
        print(f"  {pct:5.1f}%  {secs:5.1f}s  {name}")
    print()

    print("-" * 72)
    print("CALLER ATTRIBUTION FOR HOT LEAF FUNCTIONS")
    print("-" * 72)
    target_substrings = [
        "core::f64::_<impl f64>::max",
        "core::f64::_<impl f64>::min",
        "SliceIndex",
        "alloc::vec::Vec<T$C$A>::push",
    ]
    target_leafs = []
    for leaf_name, count in func_self_counts.most_common():
        if any(s in leaf_name for s in target_substrings):
            target_leafs.append((leaf_name, count))
    if not target_leafs:
        print("  No matching hot leaf functions found.")
    else:
        for leaf_name, count in target_leafs[:6]:
            pct = count / work_samples * 100
            print(f"  {leaf_name}  ({pct:.1f}% self)")
            callers = leaf_caller_counts.get(leaf_name)
            if callers:
                for caller_name, c in callers.most_common(5):
                    cpct = 100.0 * c / count
                    print(f"    caller {cpct:5.1f}%  {caller_name}")
            else:
                print("    caller (no non-wrapper caller frame found)")

            owners = project_owner_by_leaf.get(leaf_name)
            if owners:
                for owner_name, c in owners.most_common(3):
                    opct = 100.0 * c / count
                    print(f"    owner  {opct:5.1f}%  {owner_name}")
    print()

    # Interactive hint
    print("-" * 72)
    print(f"For interactive flame graph: samply load {profile_path}")
    print("-" * 72)


def main():
    profile_path = sys.argv[1] if len(sys.argv) > 1 else str(DEFAULT_PROFILE)
    syms_path = profile_path.replace(".json", ".syms.json")

    if not os.path.exists(profile_path):
        print(f"ERROR: Profile not found: {profile_path}")
        print(f"Run: npm run profile-wavemesh:samply")
        sys.exit(1)

    if not os.path.exists(syms_path):
        print(f"ERROR: Symbol sidecar not found: {syms_path}")
        print(f"Make sure --unstable-presymbolicate was used")
        sys.exit(1)

    analyze_profile(profile_path, syms_path)


if __name__ == "__main__":
    main()
