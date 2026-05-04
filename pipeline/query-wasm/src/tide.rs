//! Tidal-flow lookup against the packed tide mesh.
//!
//! The mesh is built offline by the tidemesh stage of `mesh-builder` and
//! consumed via shared memory; see `world_state.rs` for the buffer ABI.

const HEADER_TIDE_LEVEL_COUNT: usize = 0;
const HEADER_VERTEX_COUNT: usize = 1;
const HEADER_GRID_COLS: usize = 3;
const HEADER_GRID_ROWS: usize = 4;
const HEADER_GRID_MIN_X: usize = 5;
const HEADER_GRID_MIN_Y: usize = 6;
const HEADER_GRID_CELL_WIDTH: usize = 7;
const HEADER_GRID_CELL_HEIGHT: usize = 8;
const HEADER_TIDE_LEVEL_TABLE_OFFSET: usize = 9;
const HEADER_VERTEX_DATA_OFFSET: usize = 10;
const HEADER_FLOW_DATA_OFFSET: usize = 11;
const HEADER_INDEX_DATA_OFFSET: usize = 12;
const HEADER_GRID_CELL_HEADERS_OFFSET: usize = 13;

#[inline]
fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

/// Compute barycentric coordinates of (px, py) relative to triangle (a, b, c).
/// Returns `[u, v, w]` so that `u*a + v*b + w*c = (px, py)`. Returns
/// `[-1, -1, -1]` for degenerate triangles.
fn barycentric(
    px: f32,
    py: f32,
    ax: f32,
    ay: f32,
    bx: f32,
    by: f32,
    cx: f32,
    cy: f32,
) -> [f32; 3] {
    let v0x = bx - ax;
    let v0y = by - ay;
    let v1x = cx - ax;
    let v1y = cy - ay;
    let v2x = px - ax;
    let v2y = py - ay;

    let d00 = v0x * v0x + v0y * v0y;
    let d01 = v0x * v1x + v0y * v1y;
    let d11 = v1x * v1x + v1y * v1y;
    let d20 = v2x * v0x + v2y * v0y;
    let d21 = v2x * v1x + v2y * v1y;

    let denom = d00 * d11 - d01 * d01;
    if denom.abs() < 1.0e-10 {
        return [-1.0, -1.0, -1.0];
    }
    let inv = 1.0 / denom;
    let v = (d11 * d20 - d01 * d21) * inv;
    let w = (d00 * d21 - d01 * d20) * inv;
    [1.0 - v - w, v, w]
}

/// Returns `(velocity_x, velocity_y)` of the tidal flow at (world_x,
/// world_y), or `(0, 0)` when the point falls outside the tide mesh.
pub fn lookup_tidal_flow(
    world_x: f32,
    world_y: f32,
    packed_tide: &[u32],
    tide_height: f32,
    tidal_phase: f32,
    tidal_strength: f32,
) -> (f32, f32) {
    if packed_tide.len() < 16 {
        return (0.0, 0.0);
    }

    let tide_level_count = packed_tide[HEADER_TIDE_LEVEL_COUNT] as usize;
    if tide_level_count == 0 {
        return (0.0, 0.0);
    }

    let vertex_count = packed_tide[HEADER_VERTEX_COUNT] as usize;
    let grid_cols = packed_tide[HEADER_GRID_COLS] as i32;
    let grid_rows = packed_tide[HEADER_GRID_ROWS] as i32;
    let grid_min_x = read_f32(packed_tide, HEADER_GRID_MIN_X);
    let grid_min_y = read_f32(packed_tide, HEADER_GRID_MIN_Y);
    let grid_cell_w = read_f32(packed_tide, HEADER_GRID_CELL_WIDTH);
    let grid_cell_h = read_f32(packed_tide, HEADER_GRID_CELL_HEIGHT);
    let tide_level_table_offset = packed_tide[HEADER_TIDE_LEVEL_TABLE_OFFSET] as usize;
    let vertex_data_offset = packed_tide[HEADER_VERTEX_DATA_OFFSET] as usize;
    let flow_data_offset = packed_tide[HEADER_FLOW_DATA_OFFSET] as usize;
    let index_data_offset = packed_tide[HEADER_INDEX_DATA_OFFSET] as usize;
    let grid_cell_headers_offset = packed_tide[HEADER_GRID_CELL_HEADERS_OFFSET] as usize;

    let gx = (world_x - grid_min_x) / grid_cell_w;
    let gy = (world_y - grid_min_y) / grid_cell_h;
    let col = gx.floor() as i32;
    let row = gy.floor() as i32;
    if col < 0 || col >= grid_cols || row < 0 || row >= grid_rows {
        return (0.0, 0.0);
    }

    let cell_index = (row * grid_cols + col) as usize;
    let cell_base = grid_cell_headers_offset + cell_index * 2;
    let tri_list_offset = packed_tide[cell_base] as usize;
    let tri_list_count = packed_tide[cell_base + 1] as usize;

    for t in 0..tri_list_count {
        let tri_index = packed_tide[tri_list_offset + t] as usize;
        let idx_base = index_data_offset + tri_index * 3;
        let i0 = packed_tide[idx_base] as usize;
        let i1 = packed_tide[idx_base + 1] as usize;
        let i2 = packed_tide[idx_base + 2] as usize;

        let v0_base = vertex_data_offset + i0 * 2;
        let v1_base = vertex_data_offset + i1 * 2;
        let v2_base = vertex_data_offset + i2 * 2;
        let v0x = read_f32(packed_tide, v0_base);
        let v0y = read_f32(packed_tide, v0_base + 1);
        let v1x = read_f32(packed_tide, v1_base);
        let v1y = read_f32(packed_tide, v1_base + 1);
        let v2x = read_f32(packed_tide, v2_base);
        let v2y = read_f32(packed_tide, v2_base + 1);

        let bary = barycentric(world_x, world_y, v0x, v0y, v1x, v1y, v2x, v2y);
        if bary[0] >= -0.001 && bary[1] >= -0.001 && bary[2] >= -0.001 {
            // Bracket tide levels.
            let mut lower_idx: usize = 0;
            let mut upper_idx: usize = 0;
            let mut interp_t: f32 = 0.0;

            if tide_level_count > 1 {
                let first_level = read_f32(packed_tide, tide_level_table_offset);
                let last_level =
                    read_f32(packed_tide, tide_level_table_offset + tide_level_count - 1);
                if tide_height <= first_level {
                    // lower = upper = 0, interp = 0
                } else if tide_height >= last_level {
                    lower_idx = tide_level_count - 1;
                    upper_idx = tide_level_count - 1;
                } else {
                    for li in 0..tide_level_count - 1 {
                        let level_low = read_f32(packed_tide, tide_level_table_offset + li);
                        let level_high =
                            read_f32(packed_tide, tide_level_table_offset + li + 1);
                        if tide_height >= level_low && tide_height <= level_high {
                            lower_idx = li;
                            upper_idx = li + 1;
                            let range = level_high - level_low;
                            if range.abs() > 1.0e-6 {
                                interp_t = (tide_height - level_low) / range;
                            }
                            break;
                        }
                    }
                }
            }

            // Per-vertex flow at the lower tide level, weighted by bary.
            let lower_base = flow_data_offset + lower_idx * vertex_count * 4;
            let f_l0 = lower_base + i0 * 4;
            let f_l1 = lower_base + i1 * 4;
            let f_l2 = lower_base + i2 * 4;
            let flow_lower_x = read_f32(packed_tide, f_l0) * bary[0]
                + read_f32(packed_tide, f_l1) * bary[1]
                + read_f32(packed_tide, f_l2) * bary[2];
            let flow_lower_y = read_f32(packed_tide, f_l0 + 1) * bary[0]
                + read_f32(packed_tide, f_l1 + 1) * bary[1]
                + read_f32(packed_tide, f_l2 + 1) * bary[2];
            let flow_lower_z = read_f32(packed_tide, f_l0 + 2) * bary[0]
                + read_f32(packed_tide, f_l1 + 2) * bary[1]
                + read_f32(packed_tide, f_l2 + 2) * bary[2];
            let flow_lower_w = read_f32(packed_tide, f_l0 + 3) * bary[0]
                + read_f32(packed_tide, f_l1 + 3) * bary[1]
                + read_f32(packed_tide, f_l2 + 3) * bary[2];

            // Upper tide level.
            let upper_base = flow_data_offset + upper_idx * vertex_count * 4;
            let f_u0 = upper_base + i0 * 4;
            let f_u1 = upper_base + i1 * 4;
            let f_u2 = upper_base + i2 * 4;
            let flow_upper_x = read_f32(packed_tide, f_u0) * bary[0]
                + read_f32(packed_tide, f_u1) * bary[1]
                + read_f32(packed_tide, f_u2) * bary[2];
            let flow_upper_y = read_f32(packed_tide, f_u0 + 1) * bary[0]
                + read_f32(packed_tide, f_u1 + 1) * bary[1]
                + read_f32(packed_tide, f_u2 + 1) * bary[2];
            let flow_upper_z = read_f32(packed_tide, f_u0 + 2) * bary[0]
                + read_f32(packed_tide, f_u1 + 2) * bary[1]
                + read_f32(packed_tide, f_u2 + 2) * bary[2];
            let flow_upper_w = read_f32(packed_tide, f_u0 + 3) * bary[0]
                + read_f32(packed_tide, f_u1 + 3) * bary[1]
                + read_f32(packed_tide, f_u2 + 3) * bary[2];

            let flow_x = flow_lower_x + (flow_upper_x - flow_lower_x) * interp_t;
            let flow_y = flow_lower_y + (flow_upper_y - flow_lower_y) * interp_t;
            let flow_z = flow_lower_z + (flow_upper_z - flow_lower_z) * interp_t;
            let flow_w = flow_lower_w + (flow_upper_w - flow_lower_w) * interp_t;

            let (sin_p, cos_p) = crate::fast_trig::fast_sin_cos(tidal_phase);
            return (
                (flow_x * cos_p + flow_z * sin_p) * tidal_strength,
                (flow_y * cos_p + flow_w * sin_p) * tidal_strength,
            );
        }
    }
    (0.0, 0.0)
}
