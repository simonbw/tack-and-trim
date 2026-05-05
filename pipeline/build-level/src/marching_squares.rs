use std::collections::{HashMap, HashSet};

use rayon::prelude::*;

use pipeline_core::polygon_math::signed_area_tuples;

/// 2D point as `(x, y)`. Canonical ring representation in build-level.
type Point = (f64, f64);

pub struct ScalarGrid {
    pub width: usize,
    pub height: usize,
    pub values: Vec<f64>,
}

pub struct MarchSegments {
    pub seg_ax: Vec<f64>,
    pub seg_ay: Vec<f64>,
    pub seg_bx: Vec<f64>,
    pub seg_by: Vec<f64>,
    pub seg_a_edge: Vec<i64>,
    pub seg_b_edge: Vec<i64>,
}

pub struct BlockIndex {
    pub block_cols: usize,
    pub block_rows: usize,
    pub block_min: Vec<f64>,
    pub block_max: Vec<f64>,
}

const BLOCK_SIZE: usize = 64;

pub fn build_block_index(grid: &ScalarGrid) -> BlockIndex {
    let block_cols = (grid.width.saturating_sub(1)).div_ceil(BLOCK_SIZE);
    let block_rows = (grid.height.saturating_sub(1)).div_ceil(BLOCK_SIZE);
    let num_blocks = block_cols * block_rows;

    // Each block's min/max is independent — compute all in parallel.
    let mut block_min = vec![f64::INFINITY; num_blocks];
    let mut block_max = vec![f64::NEG_INFINITY; num_blocks];

    block_min
        .par_chunks_mut(block_cols)
        .zip(block_max.par_chunks_mut(block_cols))
        .enumerate()
        .for_each(|(by, (row_min, row_max))| {
            let y_start = by * BLOCK_SIZE;
            let y_end = (y_start + BLOCK_SIZE).min(grid.height - 1);
            for (bx, (bmin_out, bmax_out)) in row_min.iter_mut().zip(row_max.iter_mut()).enumerate()
            {
                let x_start = bx * BLOCK_SIZE;
                let x_end = (x_start + BLOCK_SIZE).min(grid.width - 1);

                let mut bmin = f64::INFINITY;
                let mut bmax = f64::NEG_INFINITY;

                for y in y_start..=y_end {
                    let row = y * grid.width;
                    for x in x_start..=x_end {
                        let v = grid.values[row + x];
                        bmin = bmin.min(v);
                        bmax = bmax.max(v);
                    }
                }

                *bmin_out = bmin;
                *bmax_out = bmax;
            }
        });

    BlockIndex {
        block_cols,
        block_rows,
        block_min,
        block_max,
    }
}

pub fn march_contours(grid: &ScalarGrid, blocks: &BlockIndex, level: f64) -> MarchSegments {
    let mut segments = MarchSegments {
        seg_ax: Vec::new(),
        seg_ay: Vec::new(),
        seg_bx: Vec::new(),
        seg_by: Vec::new(),
        seg_a_edge: Vec::new(),
        seg_b_edge: Vec::new(),
    };

    let block_cols = blocks.block_cols;
    let num_h = ((grid.width - 1) * grid.height) as i64;

    for by in 0..blocks.block_rows {
        let y_start = by * BLOCK_SIZE;
        let y_end = (y_start + BLOCK_SIZE).min(grid.height - 1);

        for bx in 0..block_cols {
            let bi = by * block_cols + bx;
            if blocks.block_min[bi] > level || blocks.block_max[bi] < level {
                continue;
            }
            if (blocks.block_min[bi] - blocks.block_max[bi]).abs() < 1e-12 {
                continue;
            }

            let x_start = bx * BLOCK_SIZE;
            let x_end = (x_start + BLOCK_SIZE).min(grid.width - 1);

            for y in y_start..y_end {
                let row_top = y * grid.width;
                let row_bot = (y + 1) * grid.width;
                for x in x_start..x_end {
                    march_cell(grid, x, y, row_top, row_bot, level, num_h, &mut segments);
                }
            }
        }
    }

    segments
}

fn march_cell(
    grid: &ScalarGrid,
    x: usize,
    y: usize,
    row_top: usize,
    row_bot: usize,
    level: f64,
    num_h: i64,
    segments: &mut MarchSegments,
) {
    let i_tl = row_top + x;
    let i_tr = i_tl + 1;
    let i_bl = row_bot + x;
    let i_br = i_bl + 1;

    let v_tl = grid.values[i_tl];
    let v_tr = grid.values[i_tr];
    let v_br = grid.values[i_br];
    let v_bl = grid.values[i_bl];

    let mask = (if v_tl >= level { 8 } else { 0 })
        | (if v_tr >= level { 4 } else { 0 })
        | (if v_br >= level { 2 } else { 0 })
        | (if v_bl >= level { 1 } else { 0 });

    if mask == 0 || mask == 15 {
        return;
    }

    let x_f = x as f64;
    let y_f = y as f64;

    let interp_top = || {
        let d = v_tr - v_tl;
        let t = if d.abs() < 1e-12 {
            0.5
        } else {
            (level - v_tl) / d
        };
        (x_f + t, y_f, (y * (grid.width - 1) + x) as i64)
    };
    let interp_right = || {
        let d = v_br - v_tr;
        let t = if d.abs() < 1e-12 {
            0.5
        } else {
            (level - v_tr) / d
        };
        (
            x_f + 1.0,
            y_f + t,
            num_h + (y * grid.width + (x + 1)) as i64,
        )
    };
    let interp_bottom = || {
        let d = v_br - v_bl;
        let t = if d.abs() < 1e-12 {
            0.5
        } else {
            (level - v_bl) / d
        };
        (x_f + t, y_f + 1.0, ((y + 1) * (grid.width - 1) + x) as i64)
    };
    let interp_left = || {
        let d = v_bl - v_tl;
        let t = if d.abs() < 1e-12 {
            0.5
        } else {
            (level - v_tl) / d
        };
        (x_f, y_f + t, num_h + (y * grid.width + x) as i64)
    };

    let mut push = |a: (f64, f64, i64), b: (f64, f64, i64)| {
        segments.seg_ax.push(a.0);
        segments.seg_ay.push(a.1);
        segments.seg_a_edge.push(a.2);
        segments.seg_bx.push(b.0);
        segments.seg_by.push(b.1);
        segments.seg_b_edge.push(b.2);
    };

    match mask {
        1 | 14 => {
            push(interp_left(), interp_bottom());
        }
        2 | 13 => {
            push(interp_bottom(), interp_right());
        }
        3 | 12 => {
            push(interp_left(), interp_right());
        }
        4 | 11 => {
            push(interp_top(), interp_right());
        }
        5 => {
            let top = interp_top();
            let right = interp_right();
            let bottom = interp_bottom();
            let left = interp_left();

            // Use level-independent disambiguation based on diagonal dominance.
            // This ensures all contour levels get the same connectivity in a
            // saddle cell, preventing cross-level contour intersections.
            if v_tl + v_br >= v_tr + v_bl {
                push(top, left);
                push(right, bottom);
            } else {
                push(top, right);
                push(left, bottom);
            }
        }
        6 | 9 => {
            push(interp_top(), interp_bottom());
        }
        7 | 8 => {
            push(interp_top(), interp_left());
        }
        10 => {
            let top = interp_top();
            let right = interp_right();
            let bottom = interp_bottom();
            let left = interp_left();

            if v_tl + v_br >= v_tr + v_bl {
                push(top, right);
                push(left, bottom);
            } else {
                push(top, left);
                push(right, bottom);
            }
        }
        _ => {}
    }
}

pub fn build_closed_rings(segs: &MarchSegments) -> Vec<Vec<Point>> {
    let count = segs.seg_ax.len();
    if count == 0 {
        return Vec::new();
    }

    let mut coord_idx: HashMap<i64, usize> = HashMap::new();
    let mut all_coords = vec![0.0; count * 4];
    let mut num_coords = 0usize;
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();

    for i in 0..count {
        let a = segs.seg_a_edge[i];
        let b = segs.seg_b_edge[i];

        coord_idx.entry(a).or_insert_with(|| {
            let idx = num_coords * 2;
            all_coords[idx] = segs.seg_ax[i];
            all_coords[idx + 1] = segs.seg_ay[i];
            num_coords += 1;
            idx
        });

        coord_idx.entry(b).or_insert_with(|| {
            let idx = num_coords * 2;
            all_coords[idx] = segs.seg_bx[i];
            all_coords[idx + 1] = segs.seg_by[i];
            num_coords += 1;
            idx
        });

        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }

    let mut visited: HashSet<i64> = HashSet::new();
    let mut rings = Vec::new();

    for &start_edge in adj.keys() {
        if visited.contains(&start_edge) {
            continue;
        }

        let mut scratch = Vec::new();
        let mut prev: Option<i64> = None;
        let mut curr = start_edge;
        let mut closed = false;

        loop {
            visited.insert(curr);
            let ci = coord_idx[&curr];
            scratch.push((all_coords[ci], all_coords[ci + 1]));

            let neighbors = &adj[&curr];
            let next = match neighbors.as_slice() {
                [] => None,
                [single] => {
                    if Some(*single) == prev {
                        None
                    } else {
                        Some(*single)
                    }
                }
                [n0, n1, ..] => {
                    if Some(*n0) != prev {
                        Some(*n0)
                    } else {
                        Some(*n1)
                    }
                }
            };

            let Some(next_edge) = next else {
                break;
            };

            if next_edge == start_edge {
                closed = true;
                break;
            }

            prev = Some(curr);
            curr = next_edge;

            if visited.contains(&curr) {
                break;
            }
        }

        if closed && scratch.len() >= 3 {
            if signed_area_tuples(&scratch) < 0.0 {
                scratch.reverse();
            }
            // Canonicalize startpoint: rotate so lex-smallest (x, y) is first.
            let min_idx = scratch
                .iter()
                .enumerate()
                .min_by(|(_, a), (_, b)| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)))
                .unwrap()
                .0;
            scratch.rotate_left(min_idx);
            rings.push(scratch);
        }
    }

    // Sort rings by canonical first point for deterministic order.
    rings.sort_by(|a, b| a[0].0.total_cmp(&b[0].0).then(a[0].1.total_cmp(&b[0].1)));

    rings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_closed_ring_for_simple_peak() {
        let grid = ScalarGrid {
            width: 3,
            height: 3,
            values: vec![0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0],
        };

        let blocks = build_block_index(&grid);
        let segs = march_contours(&grid, &blocks, 0.5);
        let rings = build_closed_rings(&segs);

        assert_eq!(rings.len(), 1);
        assert!(rings[0].len() >= 4);
    }

    #[test]
    fn drops_open_paths() {
        let grid = ScalarGrid {
            width: 3,
            height: 3,
            values: vec![1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        };

        let blocks = build_block_index(&grid);
        let segs = march_contours(&grid, &blocks, 0.5);
        let rings = build_closed_rings(&segs);

        assert!(rings.is_empty());
    }
}
