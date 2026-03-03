#!/usr/bin/env python3
"""
Summarize dtrace profiling data from wavemesh-builder with inline resolution.

Usage:
  # Summarize raw dtrace output (resolves inlined functions via atos -i):
  python3 pipeline/wavemesh-builder/profile-dtrace-summary.py /tmp/wavemesh-dtrace.out

  # Or summarize collapsed stacks (no inline resolution):
  python3 pipeline/wavemesh-builder/profile-dtrace-summary.py pipeline/wavemesh-builder/dtrace-output.txt

The script auto-detects raw vs collapsed format. Raw dtrace output enables
atos -i inline resolution, which cracks open opaque inlined blobs like
HeapJob::execute to reveal the actual application functions inside.
"""

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

BINARY_PATH = Path(__file__).resolve().parent / "target/release/wavemesh-builder"


# ---------------------------------------------------------------------------
# Raw dtrace parsing + atos resolution
# ---------------------------------------------------------------------------

def parse_raw_dtrace(path: str) -> tuple[list[tuple[list[str], int, int | None]], bool]:
    """Parse raw dtrace output into (stack_frames, count, tid) with bottom-up order.

    With tid: groups are [tid, frame..., count] separated by blank lines.
    Without tid: groups are [frame..., count] separated by blank lines.

    Returns (stacks, has_tid) where stacks is a list of (frames, count, tid).
    tid is None when the format doesn't include thread IDs.
    """
    stacks = []
    current_group: list[str] = []
    has_tid = None

    for line in Path(path).read_text().splitlines():
        stripped = line.strip()
        if not stripped:
            if current_group:
                _parse_dtrace_group(current_group, stacks, has_tid)
                current_group = []
            continue
        current_group.append(stripped)

    if current_group:
        _parse_dtrace_group(current_group, stacks, has_tid)

    # Detect tid presence: if first element of groups is a bare integer
    # and there are stack frames after it, we have tid
    actual_has_tid = len(stacks) > 0 and stacks[0][2] is not None
    return stacks, actual_has_tid


def _parse_dtrace_group(
    group: list[str],
    stacks: list[tuple[list[str], int, int | None]],
    has_tid: bool | None,
) -> None:
    """Parse a single dtrace stack group."""
    if len(group) < 2:
        return

    # Try to parse with tid: [tid, frame..., count]
    # The tid is a bare integer, frames contain ` or + characters
    try:
        maybe_tid = int(group[0])
        count = int(group[-1])
        frames = list(reversed(group[1:-1]))  # caller-first
        if frames:  # Has actual stack frames between tid and count
            stacks.append((frames, count, maybe_tid))
            return
    except ValueError:
        pass

    # Without tid: [frame..., count]
    try:
        count = int(group[-1])
        frames = list(reversed(group[:-1]))  # caller-first
        if frames:
            stacks.append((frames, count, None))
    except ValueError:
        pass


def is_raw_dtrace(path: str) -> bool:
    """Detect if file is raw dtrace output (indented frames) vs collapsed."""
    with open(path) as f:
        for line in f:
            line = line.rstrip()
            if not line:
                continue
            # Raw dtrace has indented lines; collapsed has semicolons
            if line.startswith(" ") or line.startswith("\t"):
                return True
            if ";" in line:
                return False
    return False


def parse_collapsed_stacks(path: str) -> list[tuple[list[str], int]]:
    """Parse collapsed stack file into list of (stack_frames, count)."""
    stacks = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.rsplit(None, 1)
        if len(parts) != 2:
            continue
        try:
            count = int(parts[1])
        except ValueError:
            continue
        frames = parts[0].split(";")
        stacks.append((frames, count))
    return stacks


def build_symbol_table(binary: Path) -> dict[str, int]:
    """Build a map from Rust hash -> symbol base address using nm."""
    symbol_map = {}
    result = subprocess.run(
        ["nm", str(binary)], capture_output=True, text=True
    )
    for line in result.stdout.splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        addr_str, _, name = parts
        # Extract Rust hash
        m = re.search(r"(h[0-9a-f]{16})", name)
        if m:
            try:
                symbol_map[m.group(1)] = int(addr_str, 16)
            except ValueError:
                pass
    return symbol_map


def collect_unique_addresses(
    stacks: list[tuple[list[str], int, int | None]], symbol_map: dict[str, int]
) -> dict[str, tuple[str, int]]:
    """Collect unique (symbol_hash, offset) pairs and compute absolute addresses.

    Returns: {frame_key -> (symbol_display_name, absolute_address)}
    """
    addresses = {}
    frame_re = re.compile(r"^wavemesh-builder`(.+)\+(0x[0-9a-f]+)$")

    for frames, _, _ in stacks:
        for frame in frames:
            if frame in addresses:
                continue
            m = frame_re.match(frame)
            if not m:
                continue
            symbol_name = m.group(1)
            offset = int(m.group(2), 16)
            # Find hash in symbol name
            hm = re.search(r"(h[0-9a-f]{16})", symbol_name)
            if not hm:
                continue
            rust_hash = hm.group(1)
            if rust_hash not in symbol_map:
                continue
            base = symbol_map[rust_hash]
            addresses[frame] = (symbol_name, base + offset)

    return addresses


def resolve_with_atos(
    binary: Path, addresses: dict[str, tuple[str, int]]
) -> dict[str, list[str]]:
    """Resolve addresses via atos -i, returning inline chain per frame.

    Returns: {frame_key -> [innermost_func, ..., outermost_func]}
    Each function string includes source location if available.
    """
    if not addresses:
        return {}

    # Build address list in deterministic order
    frame_keys = list(addresses.keys())
    addr_strs = [hex(addresses[k][1]) for k in frame_keys]

    print(f"  Resolving {len(addr_strs)} unique addresses with atos -i...",
          file=sys.stderr, flush=True)

    result = subprocess.run(
        ["atos", "-i", "-o", str(binary)] + addr_strs,
        capture_output=True, text=True
    )

    # Parse atos output: each input address produces one or more lines.
    # Lines for the same address are consecutive; a new address starts when
    # we see a line that doesn't look like an inline continuation.
    # Actually, atos -i outputs exactly N groups for N input addresses,
    # where each group is the inline chain from innermost to outermost.
    # We detect group boundaries by counting — but since groups vary in
    # length, we need another approach.
    #
    # Approach: feed addresses one at a time? Too slow for 1000+.
    # Better approach: atos outputs are separated by the fact that the
    # outermost frame of each group matches the input symbol.
    #
    # Simplest reliable approach: run atos once per address. But that's slow.
    # Let's try batch and parse by looking for known patterns.

    # Actually, the most reliable way: the output has exactly one group per
    # input address. Each line in the group is a resolved function.
    # The last line of each group is the function containing the address
    # (outermost inliner). We can detect group boundaries because the last
    # line of each group will contain the symbol hash from the corresponding
    # input frame.

    lines = result.stdout.splitlines()
    resolution: dict[str, list[str]] = {}

    # Parse by matching each output line's hash to find group boundaries
    line_idx = 0
    for frame_key in frame_keys:
        # Extract the hash from this frame's symbol
        hm = re.search(r"(h[0-9a-f]{16})", frame_key)
        target_hash = hm.group(1) if hm else None

        group = []
        while line_idx < len(lines):
            group.append(lines[line_idx])
            line_idx += 1
            # Group ends when we hit a line containing the target hash
            if target_hash and target_hash in lines[line_idx - 1]:
                break

        resolution[frame_key] = group

    print(f"  Done. Expanded to {sum(len(g) for g in resolution.values())} "
          f"inline frames.", file=sys.stderr, flush=True)

    return resolution


def extract_resolved_function(atos_line: str) -> str:
    """Extract a clean function name + source from an atos output line."""
    # Format: "func_name (in binary) (source.rs:123)"
    # or: "func_name (in binary) + offset"
    m = re.match(r"^(.+?)\s+\(in .+?\)\s+\((.+?)\)$", atos_line)
    if m:
        func = m.group(1)
        source = m.group(2)
        # Clean Rust name
        func = re.sub(r"::h[0-9a-f]{16}$", "", func)
        func = func.replace("_$u7b$$u7b$closure$u7d$$u7d$", "{closure}")
        func = func.replace("$LT$", "<").replace("$GT$", ">")
        func = func.replace("$u20$", " ")
        func = func.replace("$RF$", "&")
        func = func.replace("$LP$", "(").replace("$RP$", ")")
        func = func.replace("..", "::")
        return f"{func} ({source})"
    return atos_line


def resolve_stacks(
    stacks: list[tuple[list[str], int, int | None]],
    resolution: dict[str, list[str]],
) -> list[tuple[list[str], int, int | None]]:
    """Replace raw frames with resolved inline chains."""
    resolved = []
    for frames, count, tid in stacks:
        new_frames = []
        for frame in frames:
            if frame in resolution:
                # atos gives innermost-first; we want caller-first order
                # so reverse the inline chain, then the innermost is last
                chain = resolution[frame]
                # Extract clean names, reversed so outermost is first
                clean_chain = [extract_resolved_function(l)
                               for l in reversed(chain) if l.strip()]
                new_frames.extend(clean_chain)
            else:
                new_frames.append(frame)
        # Filter out any empty frames
        new_frames = [f for f in new_frames if f.strip()]
        resolved.append((new_frames, count, tid))
    return resolved


# ---------------------------------------------------------------------------
# Categorization
# ---------------------------------------------------------------------------

def clean_frame(frame: str) -> str:
    """Strip library prefix and Rust hash suffix from a frame name."""
    if "`" in frame:
        frame = frame.split("`", 1)[1]
    frame = re.sub(r"::h[0-9a-f]{16}$", "", frame)
    frame = frame.replace("_$u7b$$u7b$closure$u7d$$u7d$", "{closure}")
    frame = frame.replace("{{closure}}", "{closure}")
    return frame


APP_RULES = [
    ("containment", ["is_inside_contour", "winding_number_test",
                     "ContainmentGrid", "ContourLookupGrid"]),
    ("idw_distance", ["min_dist_to_contour_with_gradient", "min_dist_with_gradient_grid",
                      "min_dist_with_gradient_linear", "point_to_segment_dx_dy",
                      "idw_from_grid"]),
    ("terrain_other", ["compute_terrain_height_and_gradient", "compute_terrain_height"]),
    ("marching", ["process_track", "advance_track_segment", "march_wavefronts"]),
    ("refinement", ["refine_wavefront"]),
    ("decimation", ["post_process_segments", "sample_segment_at_t", "decimate",
                    "evaluate_snapshot_removal", "keep_mask_for_track"]),
    ("wavefront_ops", ["WavefrontSegment::push", "WavefrontSegment::clone",
                       "drop_in_place<wavemesh_builder::wavefront::WavefrontSegment",
                       "drop_in_place<wavemesh_builder::wavefront"]),
    ("triangulation", ["triangulate", "build_mesh_data"]),
]


def _matches_any(text: str, patterns: list[str]) -> bool:
    """Check if text contains any of the given patterns."""
    return any(p in text for p in patterns)


def categorize_stack(frames: list[str]) -> str:
    """Categorize a stack by examining all frames for application context.

    Works with both raw frames (library`func+0x...) and resolved frames
    (func_name (source.rs:123)).
    """
    if not frames:
        return "other"

    # Check all frames (not just leaf) for idle/overhead, since atos resolution
    # may expand the leaf into multiple frames with the actual idle call deeper.
    # But idle should still be identified by the true leaf (last frame).
    leaf = frames[-1]

    # Idle / overhead — check last few frames for system calls
    check_frames = frames[-3:] if len(frames) >= 3 else frames
    for f in check_frames:
        if _matches_any(f, ["__psynch_cvwait", "_pthread_cond_wait"]):
            return "idle_cvwait"
        if _matches_any(f, ["cthread_yield", "swtch_pri", "sched_yield",
                            "DYLD-STUB$$sched_yield"]):
            return "idle_yield"
        if _matches_any(f, ["__psynch_mutexwait", "_pthread_mutex_firstfit_lock_wait",
                            "_pthread_mutex_firstfit_lock_slow"]):
            return "idle_mutex"

    # Rayon idle patterns (spinning, waiting for work)
    for f in check_frames:
        if _matches_any(f, ["wait_until_out_of_work", "wait_until_cold",
                            "CoreLatch::probe", "atomic_load"]):
            # Only if no app function deeper in the stack
            has_app = any("wavemesh_builder::" in fr for fr in frames)
            if not has_app:
                return "idle_yield"

    rayon_patterns = [
        "rayon_core::sleep", "crossbeam_deque", "crossbeam_epoch",
        "__psynch_cvsignal", "pthread_cond_signal",
        "__psynch_mutexdrop", "_pthread_mutex_firstfit_unlock",
        "_pthread_mutex_firstfit_wake",
    ]
    for f in check_frames:
        if _matches_any(f, rayon_patterns):
            return "rayon_overhead"

    # Application categories.
    # First pass: check if ANY frame matches a terrain-specific pattern,
    # since terrain calls are often inlined into marching functions.
    all_text = " ".join(frames)
    if _matches_any(all_text, ["winding_number_test", "is_inside_contour",
                                "ContainmentGrid", "ContourLookupGrid"]):
        return "containment"
    if _matches_any(all_text, ["min_dist_to_contour_with_gradient",
                                "min_dist_with_gradient_grid",
                                "min_dist_with_gradient_linear",
                                "point_to_segment_dx_dy", "idw_from_grid"]):
        return "idw_distance"
    if _matches_any(all_text, ["compute_terrain_height_and_gradient",
                                "compute_terrain_height"]):
        return "terrain_other"

    # Second pass: find the deepest match for other categories
    for f in reversed(frames):
        for cat, patterns in APP_RULES:
            if cat in ("containment", "idw_distance", "terrain_other"):
                continue  # already handled above
            if _matches_any(f, patterns):
                return cat

    # System-level categories
    if re.search(r"\b(tanh|exp|sin|sinh|pow|sincos)\b", leaf) or \
       "libsystem_m.dylib" in leaf or "libm.dylib" in leaf:
        return "math_library"

    if _matches_any(leaf, ["libsystem_malloc", "_xzm_", "_platform_memmove",
                           "_platform_memset", "__bzero", "malloc", "free"]):
        return "memory"

    if "_tlv_get_addr" in leaf:
        return "tlv"

    # Rayon wrapper with no app context
    if _matches_any(leaf, ["rayon_core::", "HeapJob", "StackJob",
                           "core::ops::function"]):
        return "rayon_overhead"

    return "other"


# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

DISPLAY_GROUPS = [
    ("Terrain (total)", ["containment", "idw_distance", "terrain_other"]),
    ("  Containment", ["containment"]),
    ("  IDW distance", ["idw_distance"]),
    ("  Other terrain", ["terrain_other"]),
    ("Marching/advancement", ["marching"]),
    ("Refinement", ["refinement"]),
    ("Decimation/post-proc", ["decimation"]),
    ("WavefrontSegment ops", ["wavefront_ops"]),
    ("Triangulation", ["triangulation"]),
    ("Math library", ["math_library"]),
    ("Memory ops", ["memory"]),
]

OVERHEAD_CATS = {"idle_cvwait", "idle_yield", "idle_mutex", "rayon_overhead", "tlv"}


def print_thread_utilization(
    stacks: list[tuple[list[str], int, int | None]],
):
    """Print per-thread utilization breakdown."""
    # Aggregate per-thread totals and idle counts
    thread_total: dict[int, int] = defaultdict(int)
    thread_idle_cvwait: dict[int, int] = defaultdict(int)
    thread_idle_yield: dict[int, int] = defaultdict(int)
    thread_idle_mutex: dict[int, int] = defaultdict(int)

    for frames, count, tid in stacks:
        if tid is None:
            continue
        thread_total[tid] += count
        cat = categorize_stack(frames)
        if cat == "idle_cvwait":
            thread_idle_cvwait[tid] += count
        elif cat == "idle_yield":
            thread_idle_yield[tid] += count
        elif cat == "idle_mutex":
            thread_idle_mutex[tid] += count

    if not thread_total:
        return

    # Sort threads by total samples descending, skip the main thread
    # (main thread typically has the fewest samples in a rayon workload)
    threads = sorted(thread_total.keys(), key=lambda t: -thread_total[t])

    # Identify main thread: it's the one with dyld`start or wavemesh_builder::main
    # in its stacks. As a heuristic, use the thread with the fewest samples.
    main_tid = min(thread_total, key=thread_total.get)
    workers = [t for t in threads if t != main_tid]

    if not workers:
        return

    n_workers = len(workers)
    total_worker_samples = sum(thread_total[t] for t in workers)
    total_work = 0

    print(f"\n{'='*64}")
    print(f"  THREAD UTILIZATION ({n_workers} workers)")
    print(f"{'='*64}\n")
    print(f"  {'Thread':<12} {'cvwait':>7} {'yield':>7} {'mutex':>7} {'idle':>7} {'work':>7} {'util':>7}")
    print(f"  {'─'*12} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7}")

    for tid in workers:
        total = thread_total[tid]
        cvwait = thread_idle_cvwait[tid]
        yield_ = thread_idle_yield[tid]
        mutex = thread_idle_mutex[tid]
        idle = cvwait + yield_ + mutex
        work = total - idle
        total_work += work
        util = 100.0 * work / total if total else 0
        print(f"  {tid:<12} {cvwait:>7} {yield_:>7} {mutex:>7} {idle:>7} {work:>7} {util:>6.1f}%")

    max_thread_samples = max(thread_total[t] for t in workers)
    effective_cores = total_work / max_thread_samples if max_thread_samples else 0
    overall_util = 100.0 * total_work / total_worker_samples if total_worker_samples else 0
    print(f"  {'─'*12} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7}")
    print(f"  Effective cores: {effective_cores:.1f} / {n_workers} ({overall_util:.1f}%)")


def print_report(categories: dict[str, int], total_samples: int):
    overhead_samples = sum(categories.get(k, 0) for k in OVERHEAD_CATS)
    work_samples = total_samples - overhead_samples

    print(f"\n{'='*64}")
    print(f"  TIME BREAKDOWN ({total_samples:,} total samples)")
    print(f"{'='*64}\n")

    print(f"  {'Category':<24} {'Samples':>9} {'% work':>7}")
    print(f"  {'─'*24} {'─'*9} {'─'*7}")
    for display_name, cat_keys in DISPLAY_GROUPS:
        samples = sum(categories.get(k, 0) for k in cat_keys)
        pct = 100.0 * samples / work_samples if work_samples else 0
        if samples > 0:
            print(f"  {display_name:<24} {samples:>9} {pct:>6.1f}%")
    other = categories.get("other", 0)
    if other > 0:
        pct = 100.0 * other / work_samples
        print(f"  {'Other':<24} {other:>9} {pct:>6.1f}%")
    print(f"  {'─'*24} {'─'*9} {'─'*7}")
    print(f"  {'Work total':<24} {work_samples:>9}")

    print()
    print(f"  {'Overhead':<24} {'Samples':>9} {'% total':>7}")
    print(f"  {'─'*24} {'─'*9} {'─'*7}")
    overhead_groups = [
        ("Idle (total)", ["idle_cvwait", "idle_yield", "idle_mutex"]),
        ("  Sleeping (cvwait)", ["idle_cvwait"]),
        ("  Spinning (yield)", ["idle_yield"]),
        ("  Mutex contention", ["idle_mutex"]),
        ("Rayon overhead", ["rayon_overhead"]),
    ]
    for display_name, cat_keys in overhead_groups:
        samples = sum(categories.get(k, 0) for k in cat_keys)
        pct = 100.0 * samples / total_samples if total_samples else 0
        if samples > 0:
            print(f"  {display_name:<24} {samples:>9} {pct:>6.1f}%")


def find_deepest_app_function(frames: list[str]) -> str | None:
    """Find the deepest application function in a resolved stack."""
    for f in reversed(frames):
        if "wavemesh_builder::" in f:
            return clean_frame(f)
    return None


def print_top_functions(stacks: list[tuple[list[str], int, int | None]], total_samples: int):
    """Print top application leaf functions by sample count."""
    func_counts: dict[str, int] = defaultdict(int)
    for frames, count, _ in stacks:
        # Find the deepest app function (the real leaf after inline resolution)
        func = find_deepest_app_function(frames)
        if func:
            func_counts[func] += count

    print(f"\n{'='*64}")
    print(f"  TOP 20 APPLICATION FUNCTIONS (exclusive / self time)")
    print(f"{'='*64}\n")
    sorted_funcs = sorted(func_counts.items(), key=lambda x: -x[1])[:20]
    print(f"  {'Samples':>9} {'%':>6}  Function")
    print(f"  {'─'*9} {'─'*6}  {'─'*44}")
    for name, count in sorted_funcs:
        pct = 100.0 * count / total_samples
        print(f"  {count:>9} {pct:>5.1f}%  {name}")


def print_hot_paths(stacks: list[tuple[list[str], int, int | None]], total_samples: int):
    """For the hottest app functions, show the most common callers."""
    leaf_callers: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    leaf_totals: dict[str, int] = defaultdict(int)

    for frames, count, _ in stacks:
        func = find_deepest_app_function(frames)
        if not func:
            continue
        leaf_totals[func] += count

        # Find the nearest distinct app caller
        found_leaf = False
        for f in reversed(frames):
            fc = clean_frame(f)
            if "wavemesh_builder::" in fc:
                if not found_leaf:
                    found_leaf = True
                    continue
                if fc != func:
                    leaf_callers[func][fc] += count
                    break

    top_leaves = sorted(leaf_totals.items(), key=lambda x: -x[1])[:10]
    if not top_leaves:
        return

    print(f"\n{'='*64}")
    print(f"  HOT CALL PATHS")
    print(f"{'='*64}")

    for leaf, total in top_leaves:
        pct = 100.0 * total / total_samples
        print(f"\n  {leaf}")
        print(f"  {total:,} samples ({pct:.1f}%)")
        callers = sorted(leaf_callers[leaf].items(), key=lambda x: -x[1])[:3]
        if callers:
            for caller, ccount in callers:
                cpct = 100.0 * ccount / total
                print(f"    <- {caller}  ({cpct:.0f}%)")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <dtrace-output-file>")
        print(f"\nAccepts raw dtrace output (with atos -i resolution)")
        print(f"or collapsed stacks (inferno-collapse-dtrace format).")
        sys.exit(1)

    input_path = sys.argv[1]
    raw = is_raw_dtrace(input_path)
    has_tid = False

    if raw:
        print("Parsing raw dtrace output...", file=sys.stderr, flush=True)
        stacks, has_tid = parse_raw_dtrace(input_path)
        if not stacks:
            print("No stacks found in input file.")
            sys.exit(1)

        binary = Path(sys.argv[2]) if len(sys.argv) > 2 else BINARY_PATH
        if not binary.exists():
            print(f"Binary not found: {binary}", file=sys.stderr)
            print("Build first with: cargo build --release", file=sys.stderr)
            sys.exit(1)

        print(f"  {len(stacks)} unique stacks, "
              f"{sum(c for _, c, _ in stacks):,} total samples",
              file=sys.stderr, flush=True)

        # Build symbol table and resolve inlines
        symbol_map = build_symbol_table(binary)
        addresses = collect_unique_addresses(stacks, symbol_map)
        resolution = resolve_with_atos(binary, addresses)
        stacks = resolve_stacks(stacks, resolution)
    else:
        collapsed = parse_collapsed_stacks(input_path)
        if not collapsed:
            print("No stacks found in input file.")
            sys.exit(1)
        # Add None tid to match the expected tuple format
        stacks = [(frames, count, None) for frames, count in collapsed]

    total_samples = sum(count for _, count, _ in stacks)

    # Thread utilization (only if we have thread IDs)
    if has_tid:
        print_thread_utilization(stacks)

    # Categorize
    categories: dict[str, int] = defaultdict(int)
    for frames, count, _ in stacks:
        cat = categorize_stack(frames)
        categories[cat] += count

    print_report(dict(categories), total_samples)
    print_top_functions(stacks, total_samples)
    print_hot_paths(stacks, total_samples)
    print()


if __name__ == "__main__":
    main()
