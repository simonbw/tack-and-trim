# IDW Grid Optimization Tracker

Tracking improvements to the IDW candidate grid used for terrain height queries.
The grid precomputes, for each cell, which polygon edges could be the nearest edge
for any query point within that cell. Fewer entries per cell = faster queries and
less memory.

Grid resolution: 32x32 (1,024 cells per grid).
Build time = "Wrote contours to ..." step (includes containment grids, contour
data, IDW grids, and file I/O — IDW grids dominate for large levels).

## Baseline (center + 1R threshold)

Original implementation: for each cell, measure distance from cell center to all
edges, then include edges within `d_min + cell_half_diagonal` per contour tag.
This threshold is actually too tight — see "Fix: center + 2R" below.

| Level             | Grids | Total Entries | Avg/cell | Median | P95 | Max  | Memory (KB) | Build (s) |
|-------------------|-------|---------------|----------|--------|-----|------|-------------|-----------|
| san-juan-islands  | 1,540 | 72,130,707    | 45.7     | 15     | 170 | 2400 | 287,927     | 12.2      |
| apostle-islands   | 170   | 18,361,042    | 105.5    | 20     | 478 | 5812 | 72,404      | 4.4       |
| isles-of-scilly   | 54    | 605,660       | 11.0     | 4      | 56  | 132  | 2,582       | 0.1       |
| vendovi-island    | 29    | 445,733       | 15.0     | 12     | 37  | 158  | 1,857       | 0.1       |

## Fix: center + 2R threshold

The original `d_min + R` threshold can miss the true nearest edge for query points
at cell corners (false negatives). The correct conservative bound from the triangle
inequality is `d_min + 2R`, where R is the cell circumradius (half-diagonal).

Derivation: for any point P in the cell and center C, `|dist(P,E) - dist(C,E)| ≤ R`.
The nearest edge E* to P satisfies `dist(C, E*) ≤ dist(P, E*) + R ≤ d_min + 2R`.

| Level             | Grids | Total Entries | Avg/cell | Median | P95 | Max  | Memory (KB) | Build (s) | Δ Entries |
|-------------------|-------|---------------|----------|--------|-----|------|-------------|-----------|-----------|
| san-juan-islands  | 1,540 | 120,027,422   | 76.1     | 23     | 305 | 4889 | 475,023     | 12.1      | +66%      |
| apostle-islands   | 170   | 32,654,832    | 187.6    | 38     | 821 | 9387 | 128,239     | 4.5       | +78%      |
| isles-of-scilly   | 54    | 817,645       | 14.8     | 4      | 80  | 196  | 3,410       | 0.1       | +35%      |
| vendovi-island    | 29    | 706,449       | 23.8     | 19     | 60  | 233  | 2,876       | 0.1       | +58%      |

## Rect-segment distance bounds (approach B)

Instead of center-point distances + additive padding, use exact rect-to-segment
distances. For each cell and contour tag:
- `upper_bound(tag)` = min over same-tag edges E' of `max_dist(cell_rect, E')`
- Include edge E if `min_dist(cell_rect, E) ≤ upper_bound(tag)`

No additive padding — the threshold adapts to actual geometry. The `min_dist` uses
Liang-Barsky clipping + corner/endpoint checks. The `max_dist` uses the fact that
`dist(·, segment)` is convex, so the max over a rectangle is at a corner.

~9-12% fewer entries than 2R. Build time ~2x slower after fusing
min/max into a single pass (4 shared corner distances + early exits),
down from 3-4x before fusing.

| Level             | Grids | Total Entries | Avg/cell | Median | P95 | Max  | Memory (KB) | Build (s) | Δ vs 2R |
|-------------------|-------|---------------|----------|--------|-----|------|-------------|-----------|---------|
| san-juan-islands  | 1,540 | 108,669,997   | 68.9     | 21     | 276 | 4560 | 430,658     | 22.9      | -9.5%   |
| apostle-islands   | 170   | 28,746,272    | 165.1    | 32     | 771 | 8854 | 112,971     | 8.7       | -12.0%  |
| isles-of-scilly   | 54    | 776,571       | 14.0     | 4      | 76  | 183  | 3,250       | 0.2       | -5.0%   |
| vendovi-island    | 29    | 651,992       | 22.0     | 17     | 56  | 226  | 2,663       | 0.3       | -7.7%   |

## Sample-point Pareto pruning (approach D)

Post-pass on the B candidate set. For each cell, sample 5 points (4 corners +
center). For each sample point, find the nearest candidate per tag. Keep only
candidates that are nearest at ≥1 sample point. This is O(candidates × 5) per
cell and catches both pairwise dominance and collective dominance (an edge
that's never nearest because different edges win in different parts of the cell).

Nearly exact: the only way an edge is incorrectly pruned is if its Voronoi
region intersects the cell but misses all 5 sample points — astronomically
unlikely for small cells relative to segment lengths. Build time impact is
minimal since the pruning loop is cheap compared to the B-filter's fused
rect-segment distance computations.

| Level             | Grids | Total Entries | Avg/cell | Median | P95 | Max | Memory (KB) | Build (s) | Δ vs B  |
|-------------------|-------|---------------|----------|--------|-----|-----|-------------|-----------|---------|
| san-juan-islands  | 1,540 | 8,307,855     | 5.3      | 5      | 10  | 48  | 38,619      | 25.6      | -92.4%  |
| apostle-islands   | 170   | 880,734       | 5.1      | 4      | 10  | 21  | 4,121       | 9.2       | -96.9%  |
| isles-of-scilly   | 54    | 241,184       | 4.4      | 3      | 14  | 38  | 1,158       | 0.2       | -69.0%  |
| vendovi-island    | 29    | 129,841       | 4.4      | 4      | 8   | 18  | 623         | 0.2       | -80.1%  |
