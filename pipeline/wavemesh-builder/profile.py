#!/usr/bin/env python3
"""
Analyze macOS `sample` profiler output for wavemesh-builder.

Usage:
  # Capture and analyze in one step:
  ./pipeline/wavemesh-builder/profile.py

  # Or analyze an existing sample file:
  ./pipeline/wavemesh-builder/profile.py /tmp/wavemesh-sample.txt

When run without arguments, builds the release binary, starts it under
the macOS `sample` profiler (auto-timed to capture san-juan-islands),
and prints a summary.
"""

import re
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

# ---------------------------------------------------------------------------
# Category rules for the "Total number in stack" summary lines.
#
# The summary section uses RECURSIVE (inclusive) counts, so framework
# wrappers like rayon::iter::plumbing show huge numbers that include all
# the real work underneath. We skip those and only count leaf-ish functions.
#
# For terrain, the compiler inlines containment/IDW into
# compute_terrain_height_and_gradient, so we use source line numbers
# to distinguish sub-categories.
# ---------------------------------------------------------------------------

# Functions to skip entirely (inclusive wrappers, not real work)
SKIP_PATTERNS = [
    r"rayon::iter::plumbing",
    r"rayon_core::join",
    r"rayon_core::registry::WorkerThread::wait_until_cold\b.*registry\.rs:800$",
    r"rayon_core::registry::WorkerThread::wait_until_cold\b.*registry\.rs:798$",
    r"rayon_core::registry::WorkerThread::wait_until_cold\b.*registry\.rs:799$",
    r"_\$LT\$rayon_core\.\.job\.\.",
    r"core::ops::function::impls",
    r"std::sys::backtrace",
    r"core::ops::function::FnOnce",
    r"\.1334\)",  # anonymous rayon symbol
]

# Line ranges in terrain.rs for sub-categorization.
# These are approximate and shift when the file is edited — update as needed.
# Phase 1 (containment DFS): lines 678-700
# Phase 2/3 (early return): lines 702-720
# Phase 4 (IDW): lines 722-780
TERRAIN_CONTAINMENT_LINES = range(678, 701)
TERRAIN_IDW_LINES = range(722, 785)


def parse_entry(func_line: str) -> dict:
    """Parse a summary line into structured fields."""
    m = re.match(
        r"(.+?)\s+\(in\s+(.+?)\)\s+\+\s+\S+\s+\[.+?\](?:\s+(\S+):(\d+))?$",
        func_line,
    )
    if not m:
        return {"name": func_line, "module": "", "file": "", "line": 0}
    return {
        "name": m.group(1),
        "module": m.group(2),
        "file": m.group(3) or "",
        "line": int(m.group(4)) if m.group(4) else 0,
    }


def should_skip(func_line: str) -> bool:
    """Check if this entry is an inclusive wrapper we should ignore."""
    for pat in SKIP_PATTERNS:
        if re.search(pat, func_line):
            return True
    return False


def categorize_entry(count: int, func_line: str, entry: dict) -> str | None:
    """Return category name for an entry, or None to skip."""
    if should_skip(func_line):
        return None

    name = entry["name"]
    source_file = entry["file"]
    line = entry["line"]

    # Terrain sub-categories by source line
    if "compute_terrain_height_and_gradient" in name and source_file == "terrain.rs":
        if line in TERRAIN_CONTAINMENT_LINES:
            return "containment"
        if line in TERRAIN_IDW_LINES:
            return "idw_distance"
        return "terrain_other"

    # Explicit function-name matches
    rules = [
        ("containment", ["is_inside_contour", "winding_number_test", "ContainmentGrid"]),
        ("idw_distance", [
            "min_dist_to_contour_with_gradient", "min_dist_with_gradient_grid",
            "min_dist_with_gradient_linear", "point_to_segment_dx_dy",
        ]),
        ("terrain_other", ["compute_terrain_height"]),
        ("marching", ["process_track", "advance_track_segment", "march_wavefronts"]),
        ("refinement", ["refine_wavefront"]),
        ("decimation", ["post_process_segments", "sample_segment_at_t", "decimate"]),
        ("wavefront_ops", [
            "WavefrontSegment::push", "WavefrontSegment::clone",
            r"drop_in_place.*WavefrontSegment",
        ]),
        ("triangulation", ["triangulate", "build_mesh_data"]),
        ("idle_cvwait", ["_pthread_cond_wait", "__psynch_cvwait"]),
        ("idle_yield", ["cthread_yield", "swtch_pri"]),
        ("idle_mutex", [
            "__psynch_mutexwait", "_pthread_mutex_firstfit_lock_wait",
            "_pthread_mutex_firstfit_lock_slow",
        ]),
        ("rayon_overhead", [
            "rayon_core::sleep", "rayon_core::registry",
            "crossbeam_deque", "crossbeam_epoch",
            "__psynch_cvsignal", "pthread_cond_signal",
            "__psynch_mutexdrop", "_pthread_mutex_firstfit_unlock",
            "_pthread_mutex_firstfit_wake",
        ]),
        ("math_library", [
            r"\btanh\b", r"\bexp\b", r"\bsin\b", r"\bsinh\b", r"\bpow\b",
            "__sincos_stret", "DYLD-STUB",
        ]),
        ("memory", [
            "_platform_memmove", "_xzm_xzone_malloc", "_xzm_free",
            "mach_vm_reclaim", "grow_one", r"\brealloc\b",
        ]),
        ("tlv", ["_tlv_get_addr"]),
    ]

    for cat, patterns in rules:
        for pat in patterns:
            if re.search(pat, func_line):
                return cat
    return "other"


# Display grouping for the summary table
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
    ("Idle (total)", ["idle_cvwait", "idle_yield", "idle_mutex"]),
    ("  Sleeping (cvwait)", ["idle_cvwait"]),
    ("  Spinning (yield)", ["idle_yield"]),
    ("  Mutex contention", ["idle_mutex"]),
    ("Rayon overhead", ["rayon_overhead"]),
    ("Math library", ["math_library"]),
    ("Memory ops", ["memory"]),
]


def parse_summary_section(text: str) -> list[tuple[int, str]]:
    """Parse the 'Total number in stack' section."""
    entries = []
    in_section = False
    for line in text.splitlines():
        if "Total number in stack" in line:
            in_section = True
            continue
        if not in_section:
            continue
        m = re.match(r"^\s+(\d+)\s+(.+)$", line)
        if m:
            entries.append((int(m.group(1)), m.group(2).strip()))
    return entries


def parse_threads(text: str) -> list[dict]:
    """Parse per-thread sample counts and idle breakdown from the call graph."""
    threads = []
    thread_re = re.compile(r"^\s+(\d+)\s+(Thread_\d+)")

    lines = text.splitlines()
    i = 0
    while i < len(lines) and "Call graph:" not in lines[i]:
        i += 1
    i += 1

    while i < len(lines):
        if "Total number in stack" in lines[i]:
            break
        m = thread_re.match(lines[i])
        if m:
            total = int(m.group(1))
            thread_id = m.group(2)
            is_main = "main-thread" in lines[i] or "DispatchQueue_1" in lines[i]
            i += 1
            idle_cvwait = 0
            idle_yield = 0
            idle_mutex = 0
            while i < len(lines):
                line = lines[i]
                if thread_re.match(line) or "Total number in stack" in line:
                    break
                sm = re.search(r"(\d+)\s+__psynch_cvwait\b", line)
                if sm:
                    idle_cvwait = max(idle_cvwait, int(sm.group(1)))
                sm = re.search(r"(\d+)\s+swtch_pri\b", line)
                if sm:
                    idle_yield = max(idle_yield, int(sm.group(1)))
                sm = re.search(r"(\d+)\s+__psynch_mutexwait\b", line)
                if sm:
                    idle_mutex = max(idle_mutex, int(sm.group(1)))
                i += 1

            threads.append({
                "id": thread_id,
                "total": total,
                "is_main": is_main,
                "idle_cvwait": idle_cvwait,
                "idle_yield": idle_yield,
                "idle_mutex": idle_mutex,
            })
        else:
            i += 1

    return threads


def categorize_all(entries: list[tuple[int, str]]) -> dict[str, int]:
    """Categorize all summary entries."""
    counts: dict[str, int] = defaultdict(int)
    for count, func_line in entries:
        entry = parse_entry(func_line)
        cat = categorize_entry(count, func_line, entry)
        if cat is not None:
            counts[cat] += count
    return dict(counts)


def print_report(threads: list[dict], categories: dict[str, int]):
    workers = [t for t in threads if not t["is_main"]]
    if not workers:
        print("No worker threads found!")
        return

    total_per_thread = workers[0]["total"]
    n_workers = len(workers)
    total_worker_samples = n_workers * total_per_thread

    # --- Thread utilization ---
    print(f"\n{'='*64}")
    print(f"  THREAD UTILIZATION ({n_workers} workers, {total_per_thread} samples each)")
    print(f"{'='*64}\n")
    print(f"  {'Thread':<12} {'cvwait':>7} {'yield':>7} {'mutex':>7} {'idle':>7} {'work':>7} {'util':>7}")
    print(f"  {'─'*12} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7}")

    total_work = 0
    for t in workers:
        idle = t["idle_cvwait"] + t["idle_yield"] + t["idle_mutex"]
        work = t["total"] - idle
        total_work += work
        util = 100.0 * work / t["total"]
        print(f"  {t['id']:<12} {t['idle_cvwait']:>7} {t['idle_yield']:>7} {t['idle_mutex']:>7} {idle:>7} {work:>7} {util:>6.1f}%")

    effective_cores = total_work / total_per_thread
    overall_util = 100.0 * total_work / total_worker_samples
    print(f"  {'─'*12} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7} {'─'*7}")
    print(f"  Effective cores: {effective_cores:.1f} / {n_workers} ({overall_util:.1f}%)")

    # --- Category breakdown ---
    print(f"\n{'='*64}")
    print(f"  TIME BREAKDOWN (% of {total_worker_samples} worker samples)")
    print(f"{'='*64}\n")
    print(f"  {'Category':<24} {'Samples':>9} {'%':>7}")
    print(f"  {'─'*24} {'─'*9} {'─'*7}")

    for display_name, cat_keys in DISPLAY_GROUPS:
        samples = sum(categories.get(k, 0) for k in cat_keys)
        pct = 100.0 * samples / total_worker_samples if total_worker_samples else 0
        if samples > 0:
            print(f"  {display_name:<24} {samples:>9} {pct:>6.1f}%")

    other = categories.get("other", 0)
    if other > 0:
        pct = 100.0 * other / total_worker_samples
        print(f"  {'Other':<24} {other:>9} {pct:>6.1f}%")


def print_top_functions(entries: list[tuple[int, str]], total_worker_samples: int):
    """Print top application functions, deduped by function+source."""
    app_funcs: dict[str, int] = defaultdict(int)
    for count, func_line in entries:
        if "wavemesh_builder::" not in func_line:
            continue
        entry = parse_entry(func_line)
        fname = entry["name"]
        # Demangle
        fname = re.sub(r"::h[0-9a-f]{16}$", "", fname)
        fname = fname.replace("::_$u7b$$u7b$closure$u7d$$u7d$", "::{closure}")
        source = f"{entry['file']}:{entry['line']}" if entry["file"] else ""
        key = f"{fname}  {source}" if source else fname
        app_funcs[key] += count

    print(f"\n{'='*64}")
    print(f"  TOP 15 APPLICATION FUNCTIONS (by sample count)")
    print(f"{'='*64}\n")
    sorted_funcs = sorted(app_funcs.items(), key=lambda x: -x[1])[:15]
    print(f"  {'Samples':>9} {'%':>6}  Function")
    print(f"  {'─'*9} {'─'*6}  {'─'*40}")
    for name, count in sorted_funcs:
        pct = 100.0 * count / total_worker_samples
        print(f"  {count:>9} {pct:>5.1f}%  {name}")


def run_profiler() -> str:
    """Build, run the wavemesh-builder under `sample`, and return the output file path."""
    project_root = Path(__file__).resolve().parent.parent.parent
    binary = project_root / "pipeline/wavemesh-builder/target/release/wavemesh-builder"
    output_file = "/tmp/wavemesh-sample.txt"

    print("Building release binary...")
    subprocess.run(
        ["cargo", "build", "--release", "--manifest-path", "pipeline/wavemesh-builder/Cargo.toml"],
        cwd=project_root, check=True, capture_output=True,
    )
    print("Done.\n")

    print("Starting wavemesh-builder...")
    proc = subprocess.Popen(
        [str(binary)],
        cwd=project_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    # Wait for san-juan-islands (apostle ~9s + default ~0.3s + isles ~9s ≈ 18-20s)
    print("Waiting for san-juan-islands build to start...")
    time.sleep(20)

    print(f"Sampling PID {proc.pid} for 25 seconds...")
    subprocess.run(
        ["sample", str(proc.pid), "25", "-f", output_file],
        capture_output=True,
    )
    print(f"Profile saved to {output_file}\n")

    stdout, _ = proc.communicate()
    output = stdout.decode()

    for line in output.splitlines():
        if "Total build time" in line or line.startswith("==="):
            print(line)
    print()

    return output_file


def main():
    if len(sys.argv) > 1:
        sample_file = sys.argv[1]
    else:
        sample_file = run_profiler()

    text = Path(sample_file).read_text()

    threads = parse_threads(text)
    entries = parse_summary_section(text)
    categories = categorize_all(entries)

    workers = [t for t in threads if not t["is_main"]]
    total_worker_samples = len(workers) * (workers[0]["total"] if workers else 0)

    print_report(threads, categories)
    print_top_functions(entries, total_worker_samples)
    print()


if __name__ == "__main__":
    main()
