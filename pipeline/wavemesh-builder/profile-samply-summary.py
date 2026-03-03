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
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DEFAULT_PROFILE = SCRIPT_DIR / "profile-samply.json"
DEFAULT_SYMS = SCRIPT_DIR / "profile-samply.syms.json"
MACHO_TEXT_BASE = 0x100000000


WRAPPER_SUBSTRINGS = [
    "<rayon_core::job::HeapJob",
    "<rayon_core::job::StackJob",
    "rayon_core::join::join_context::{{closure}}",
    "rayon_core::join::join_context::",
    "rayon::iter::plumbing::bridge_producer_consumer::helper",
    "core::ops::function::impls::<impl core::ops::function::FnMut",
    "core::ops::function::impls::<impl core::ops::function::FnOnce",
    "core::ops::function::FnOnce::call_once",
    "std::sys::backtrace::__rust_begin_short_backtrace",
]


def load_symbol_table(syms_path):
    """Load the sidecar symbol table and build RVA->name lookup per library."""
    with open(syms_path) as f:
        syms_data = json.load(f)

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


def analyze_profile(profile_path, syms_path):
    with open(profile_path) as f:
        profile = json.load(f)

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
    # Cache RVA -> atos inlined name across threads
    inline_name_cache = {}

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

        # Pre-resolve all function names.
        resolved_names = {}
        for fi in range(func_table["length"]):
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
                resolved_names[fi] = inline_name
            elif resolved:
                resolved_names[fi] = resolved
            else:
                resolved_names[fi] = raw_name

        # Walk each sample
        t_idle = 0
        t_work = 0

        for si in range(n_samples):
            stack_idx = samples["stack"][si]
            weight = samples["weight"][si] if samples.get("weight") else 1

            # Get the leaf (top-of-stack) frame
            if stack_idx is None:
                continue

            leaf_frame = stack_table["frame"][stack_idx]
            leaf_func = frame_table["func"][leaf_frame]
            leaf_name = resolved_names.get(leaf_func, "???")

            # Walk up the stack (leaf -> root) and find first non-wrapper frame.
            effective_name = leaf_name
            cur = stack_idx
            while cur is not None:
                frame_idx = stack_table["frame"][cur]
                func_idx = frame_table["func"][frame_idx]
                name = resolved_names.get(func_idx, "???")
                if not is_wrapper_frame(name):
                    effective_name = name
                    break
                cur = stack_table["prefix"][cur]

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

            total_samples += weight

        thread_stats.append({
            "name": thread["name"],
            "tid": thread["tid"],
            "samples": n_samples,
            "idle": t_idle,
            "work": t_work,
        })

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
    print(f"\n  Effective cores: {effective_cores:.1f}")
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
