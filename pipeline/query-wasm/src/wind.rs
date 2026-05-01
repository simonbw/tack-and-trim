//! Wind query — port of `writeWindResult` and the mesh-blended lookup
//! from `src/game/world/query/wind-math.ts` and
//! `src/game/world/query/wind-mesh-math.ts`.
//!
//! Output layout (`WindResultLayout`):
//!   `[velocity_x, velocity_y, speed, direction]`

use crate::fast_trig::fast_sin_cos;
use crate::noise::simplex3d;
use crate::packed::WIND_MESH_FLOATS_PER_VERTEX;
pub use crate::protocol::{PARAMS_FLOATS_PER_CHANNEL, STRIDE_PER_POINT};
use crate::world_state::WorldState;

const WIND_PARAM_TIME: usize = 0;
const WIND_PARAM_BASE_X: usize = 1;
const WIND_PARAM_BASE_Y: usize = 2;
const WIND_PARAM_INFLUENCE_SPEED_FACTOR: usize = 3;
const WIND_PARAM_INFLUENCE_DIRECTION_OFFSET: usize = 4;
const WIND_PARAM_INFLUENCE_TURBULENCE: usize = 5;
const WIND_PARAM_WEIGHTS_BASE: usize = 6;
const WIND_PARAM_WEIGHTS_COUNT: usize = 8;

// `WindConstants.ts` — keep in sync.
const WIND_NOISE_SPATIAL_SCALE: f32 = 0.005;
const WIND_SPEED_VARIATION: f32 = 0.5;
const WIND_ANGLE_VARIATION: f32 = 0.17;
const WIND_FLOW_CYCLE_PERIOD: f32 = 20.0;
const WIND_SLOW_TIME_SCALE: f32 = 0.02;
const MAX_WIND_SOURCES: usize = 8;

const GLOBAL_HEADER_MESH_OFFSETS: usize = 1;

#[inline]
fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

#[inline]
fn fract(x: f32) -> f32 {
    x - x.floor()
}

#[inline]
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

/// Result of a per-source mesh lookup. `found = false` means the lookup
/// missed (no triangle in the wave's grid covered the point), and the
/// caller should leave attributes at their fallback values.
struct MeshLookupResult {
    speed_factor: f32,
    direction_offset: f32,
    turbulence: f32,
    found: bool,
}

fn lookup_wind_mesh_for_source(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    mesh_offset: usize,
) -> MeshLookupResult {
    // Mesh header layout (16 u32 with padding; we only read 11):
    // 0:vertexOffset 1:vertexCount 2:indexOffset 3:triangleCount 4:gridOffset
    // 5:gridCols 6:gridRows 7:gridMinX(f32) 8:gridMinY(f32)
    // 9:gridCellWidth(f32) 10:gridCellHeight(f32)
    let vertex_offset = packed[mesh_offset] as usize;
    let triangle_count = packed[mesh_offset + 3] as usize;
    if triangle_count == 0 {
        return MeshLookupResult {
            speed_factor: 1.0,
            direction_offset: 0.0,
            turbulence: 0.0,
            found: false,
        };
    }
    let index_offset = packed[mesh_offset + 2] as usize;
    let grid_offset = packed[mesh_offset + 4] as usize;
    let grid_cols = packed[mesh_offset + 5] as i32;
    let grid_rows = packed[mesh_offset + 6] as i32;
    let grid_min_x = read_f32(packed, mesh_offset + 7);
    let grid_min_y = read_f32(packed, mesh_offset + 8);
    let grid_cell_w = read_f32(packed, mesh_offset + 9);
    let grid_cell_h = read_f32(packed, mesh_offset + 10);

    let gx = (world_x - grid_min_x) / grid_cell_w;
    let gy = (world_y - grid_min_y) / grid_cell_h;
    let col = gx.floor() as i32;
    let row = gy.floor() as i32;
    if col < 0 || col >= grid_cols || row < 0 || row >= grid_rows {
        return MeshLookupResult {
            speed_factor: 1.0,
            direction_offset: 0.0,
            turbulence: 0.0,
            found: false,
        };
    }

    let cell_index = (row * grid_cols + col) as usize;
    let cell_base = grid_offset + cell_index * 2;
    let tri_list_offset = packed[cell_base] as usize;
    let tri_list_count = packed[cell_base + 1] as usize;

    for t in 0..tri_list_count {
        let tri_index = packed[tri_list_offset + t] as usize;
        let tri_base = index_offset + tri_index * 3;
        let ai = packed[tri_base] as usize;
        let bi = packed[tri_base + 1] as usize;
        let ci = packed[tri_base + 2] as usize;

        let a_off = vertex_offset + ai * WIND_MESH_FLOATS_PER_VERTEX;
        let b_off = vertex_offset + bi * WIND_MESH_FLOATS_PER_VERTEX;
        let c_off = vertex_offset + ci * WIND_MESH_FLOATS_PER_VERTEX;
        let ax = read_f32(packed, a_off);
        let ay = read_f32(packed, a_off + 1);
        let bx = read_f32(packed, b_off);
        let by = read_f32(packed, b_off + 1);
        let cx = read_f32(packed, c_off);
        let cy = read_f32(packed, c_off + 1);

        let bary = barycentric(world_x, world_y, ax, ay, bx, by, cx, cy);
        if bary[0] >= -0.001 && bary[1] >= -0.001 && bary[2] >= -0.001 {
            // Vertex layout: [posX, posY, speedFactor, directionOffset, turbulence]
            let a_speed = read_f32(packed, a_off + 2);
            let a_dir = read_f32(packed, a_off + 3);
            let a_turb = read_f32(packed, a_off + 4);
            let b_speed = read_f32(packed, b_off + 2);
            let b_dir = read_f32(packed, b_off + 3);
            let b_turb = read_f32(packed, b_off + 4);
            let c_speed = read_f32(packed, c_off + 2);
            let c_dir = read_f32(packed, c_off + 3);
            let c_turb = read_f32(packed, c_off + 4);

            return MeshLookupResult {
                speed_factor: a_speed * bary[0] + b_speed * bary[1] + c_speed * bary[2],
                direction_offset: a_dir * bary[0] + b_dir * bary[1] + c_dir * bary[2],
                turbulence: a_turb * bary[0] + b_turb * bary[1] + c_turb * bary[2],
                found: true,
            };
        }
    }

    MeshLookupResult {
        speed_factor: 1.0,
        direction_offset: 0.0,
        turbulence: 0.0,
        found: false,
    }
}

/// Blended mesh lookup — sums per-source contributions weighted by each
/// source's activation weight. Returns the fallback (no-influence)
/// values when the lookup misses everywhere.
fn lookup_wind_mesh_blended(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    weights: &[f32],
) -> MeshLookupResult {
    if packed.is_empty() {
        return MeshLookupResult {
            speed_factor: 1.0,
            direction_offset: 0.0,
            turbulence: 0.0,
            found: false,
        };
    }
    let num_sources = packed[0] as usize;
    if num_sources == 0 {
        return MeshLookupResult {
            speed_factor: 1.0,
            direction_offset: 0.0,
            turbulence: 0.0,
            found: false,
        };
    }

    let mut acc_speed = 0.0_f32;
    let mut acc_dir = 0.0_f32;
    let mut acc_turb = 0.0_f32;
    let mut total_weight = 0.0_f32;
    let mut any_found = false;

    let limit = num_sources.min(MAX_WIND_SOURCES);
    for s in 0..limit {
        let w = weights[s];
        if w <= 0.0 {
            continue;
        }
        let mesh_offset = packed[GLOBAL_HEADER_MESH_OFFSETS + s] as usize;
        let r = lookup_wind_mesh_for_source(world_x, world_y, packed, mesh_offset);
        if r.found {
            acc_speed += r.speed_factor * w;
            acc_dir += r.direction_offset * w;
            acc_turb += r.turbulence * w;
            total_weight += w;
            any_found = true;
        }
    }

    if any_found && total_weight > 0.0 {
        let inv = 1.0 / total_weight;
        MeshLookupResult {
            speed_factor: acc_speed * inv,
            direction_offset: acc_dir * inv,
            turbulence: acc_turb * inv,
            found: true,
        }
    } else {
        MeshLookupResult {
            speed_factor: 1.0,
            direction_offset: 0.0,
            turbulence: 0.0,
            found: false,
        }
    }
}

/// Per-point wind velocity. Mirrors `writeWindResult` in
/// `wind-math.ts`.
#[allow(clippy::too_many_arguments)]
fn write_wind_result(
    world_x: f32,
    world_y: f32,
    time: f32,
    base_wind_x: f32,
    base_wind_y: f32,
    influence_speed_factor: f32,
    influence_direction_offset: f32,
    influence_turbulence: f32,
    out: &mut [f32],
) {
    let local_flow_x = base_wind_x * influence_speed_factor;
    let local_flow_y = base_wind_y * influence_speed_factor;
    let (sin_dir, cos_dir) = fast_sin_cos(influence_direction_offset);
    let flow_x = local_flow_x * cos_dir - local_flow_y * sin_dir;
    let flow_y = local_flow_x * sin_dir + local_flow_y * cos_dir;

    let period = WIND_FLOW_CYCLE_PERIOD;
    let t0 = fract(time / period);
    let t1 = fract(time / period + 0.5);
    let blend = (2.0 * t0 - 1.0).abs();

    let slow_time = time * WIND_SLOW_TIME_SCALE;

    let scale = WIND_NOISE_SPATIAL_SCALE;
    let uv0_speed_x = (world_x - flow_x * t0 * period) * scale;
    let uv0_speed_y = (world_y - flow_y * t0 * period) * scale;
    let uv1_speed_x = (world_x - flow_x * t1 * period) * scale;
    let uv1_speed_y = (world_y - flow_y * t1 * period) * scale;

    let speed_noise_0 = simplex3d(uv0_speed_x, uv0_speed_y, slow_time);
    let speed_noise_1 = simplex3d(uv1_speed_x, uv1_speed_y, slow_time);
    let speed_noise = speed_noise_0 + (speed_noise_1 - speed_noise_0) * blend;

    let uv0_angle_x = uv0_speed_x + 1000.0;
    let uv0_angle_y = uv0_speed_y + 1000.0;
    let uv1_angle_x = uv1_speed_x + 1000.0;
    let uv1_angle_y = uv1_speed_y + 1000.0;
    let angle_noise_0 = simplex3d(uv0_angle_x, uv0_angle_y, slow_time);
    let angle_noise_1 = simplex3d(uv1_angle_x, uv1_angle_y, slow_time);
    let angle_noise = angle_noise_0 + (angle_noise_1 - angle_noise_0) * blend;

    let turbulence_boost = 1.0 + influence_turbulence * 0.5;
    let mut speed_scale = 1.0 + speed_noise * WIND_SPEED_VARIATION * turbulence_boost;
    speed_scale *= influence_speed_factor;

    let total_angle_offset = angle_noise * WIND_ANGLE_VARIATION + influence_direction_offset;

    let scaled_x = base_wind_x * speed_scale;
    let scaled_y = base_wind_y * speed_scale;
    let (sin_angle, cos_angle) = fast_sin_cos(total_angle_offset);
    let velocity_x = scaled_x * cos_angle - scaled_y * sin_angle;
    let velocity_y = scaled_x * sin_angle + scaled_y * cos_angle;

    let speed = (velocity_x * velocity_x + velocity_y * velocity_y).sqrt();
    let direction = velocity_y.atan2(velocity_x);

    out[0] = velocity_x;
    out[1] = velocity_y;
    out[2] = speed;
    out[3] = direction;
}

pub fn process_batch(
    points: &[f32],
    params: &[f32],
    state: &WorldState,
    results: &mut [f32],
    result_stride: usize,
) {
    let time = params[WIND_PARAM_TIME];
    let base_x = params[WIND_PARAM_BASE_X];
    let base_y = params[WIND_PARAM_BASE_Y];
    let fallback_speed = params[WIND_PARAM_INFLUENCE_SPEED_FACTOR];
    let fallback_dir = params[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET];
    let fallback_turb = params[WIND_PARAM_INFLUENCE_TURBULENCE];

    let mut weights = [0.0_f32; WIND_PARAM_WEIGHTS_COUNT];
    for (i, w) in weights.iter_mut().enumerate() {
        *w = params[WIND_PARAM_WEIGHTS_BASE + i];
    }

    // SAFETY: pointer was registered via `set_packed_wind_mesh` and
    // refers to a shared-memory region live for the worker's lifetime.
    let packed_wind: &[u32] = unsafe { state.packed_wind_mesh.as_slice() };
    let point_count = points.len() / STRIDE_PER_POINT;

    for i in 0..point_count {
        let world_x = points[i * STRIDE_PER_POINT];
        let world_y = points[i * STRIDE_PER_POINT + 1];

        let (speed_factor, dir_offset, turb) = if packed_wind.is_empty() {
            (fallback_speed, fallback_dir, fallback_turb)
        } else {
            let r = lookup_wind_mesh_blended(world_x, world_y, packed_wind, &weights);
            if r.found {
                (r.speed_factor, r.direction_offset, r.turbulence)
            } else {
                (fallback_speed, fallback_dir, fallback_turb)
            }
        };

        let r = i * result_stride;
        write_wind_result(
            world_x,
            world_y,
            time,
            base_x,
            base_y,
            speed_factor,
            dir_offset,
            turb,
            &mut results[r..r + 4],
        );
    }
}
