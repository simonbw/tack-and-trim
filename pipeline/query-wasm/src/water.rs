//! Water query — port of `writeWaterResult` and friends from
//! `src/game/world/query/water-math.ts`.
//!
//! Mirrors the WGSL compute shader in `WaterQueryShader.ts`:
//!   - Gerstner waves (two-pass: horizontal displacement, then height/velocity)
//!   - Wavefront mesh lookup per wave source (energy + phase corrections)
//!   - Modifier accumulation (wakes / ripples / currents / foam)
//!   - Finite-difference normals (re-runs the height pass at +x/+y offsets)
//!   - Tidal flow lookup added to the velocity output
//!
//! Result layout (matches `WaterResultLayout`):
//!   `[surface_height, velocity_x, velocity_y, normal_x, normal_y, depth]`

use crate::fast_trig::{fast_sin_cos, sincos_chunk_4};
use crate::noise::simplex3d;
use crate::packed::{
    mesh_num_waves, terrain_contour_count, MESH_FLOATS_PER_VERTEX, MESH_GRID_CELL_H_F32,
    MESH_GRID_CELL_W_F32, MESH_GRID_COLS, MESH_GRID_COS_A_F32, MESH_GRID_MIN_X_F32,
    MESH_GRID_MIN_Y_F32, MESH_GRID_ROWS, MESH_GRID_SIN_A_F32, MESH_HEADER_MESH_OFFSETS_BASE,
    MESH_INDEX_OFFSET, MESH_TRIANGLE_COUNT, MESH_VERTEX_OFFSET,
};
use crate::terrain_height::compute_terrain_height;
use crate::tide::lookup_tidal_flow;
use crate::world_state::WorldState;

// ---------------------------------------------------------------------------
// Layout constants — must stay in sync with the TypeScript and WGSL sides.
// ---------------------------------------------------------------------------

pub const STRIDE_PER_POINT: usize = 2;
pub const PARAMS_FLOATS_PER_CHANNEL: usize = 128;
pub const FLOATS_PER_MODIFIER: usize = 14;

const MAX_WAVE_SOURCES: usize = 8;
const FLOATS_PER_WAVE: usize = 8;
const MAX_MODIFIERS: usize = 16384;

// `water-params.ts` offsets — indices into the params block.
const WATER_PARAM_TIME: usize = 0;
const WATER_PARAM_TIDE_HEIGHT: usize = 1;
const WATER_PARAM_DEFAULT_DEPTH: usize = 2;
const WATER_PARAM_NUM_WAVES: usize = 3;
const WATER_PARAM_TIDAL_PHASE: usize = 4;
const WATER_PARAM_TIDAL_STRENGTH: usize = 5;
// const WATER_PARAM_CONTOUR_COUNT: usize = 6;  // unused — we derive from packed buffer
// const WATER_PARAM_MODIFIER_COUNT: usize = 7; // passed in directly
const WATER_PARAM_WAVE_AMPLITUDE_SCALE: usize = 8;
const WATER_PARAM_WAVE_SOURCES_BASE: usize = 9;

// `WaterConstants.ts` — keep in sync.
const GERSTNER_STEEPNESS: f32 = 0.7;
const WAVE_AMP_MOD_SPATIAL_SCALE: f32 = 0.005;
const WAVE_AMP_MOD_TIME_SCALE: f32 = 0.015;
const WAVE_AMP_MOD_STRENGTH: f32 = 0.0;

// Math constants from `core/graphics/webgpu/Shader.ts` `getMathConstants()`.
const GRAVITY: f32 = 32.174; // ft/s^2
const TWO_PI: f32 = std::f32::consts::TAU;

// `WaterQueryShader.ts` `NORMAL_SAMPLE_OFFSET`.
const NORMAL_SAMPLE_OFFSET: f32 = 1.0;

// Modifier type discriminators (from `water-modifiers.wgsl.ts`).
const MODIFIER_TYPE_WAKE: i32 = 1;
const MODIFIER_TYPE_RIPPLE: i32 = 2;
const MODIFIER_TYPE_CURRENT: i32 = 3;
// MODIFIER_TYPE_OBSTACLE (4) is a no-op in the shader — match that.
const MODIFIER_TYPE_FOAM: i32 = 5;

// ---------------------------------------------------------------------------
// Mesh lookup. Iterates triangles in the wave's spatial grid cell and
// accumulates a phasor (cos, sin) weighted by per-vertex amplitude.
// Returns `(phasor_cos, phasor_sin)`. Outside the mesh → `(1, 0)`
// (open ocean: full amplitude, zero phase correction). Inside the grid
// but no covering triangle → `(0, 0)` (shadow).
// ---------------------------------------------------------------------------

#[inline]
fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

fn lookup_mesh_for_wave(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    wave_index: usize,
) -> (f32, f32) {
    if packed.is_empty() {
        return (1.0, 0.0);
    }
    let num_waves = mesh_num_waves(packed) as usize;
    if wave_index >= num_waves {
        return (1.0, 0.0);
    }

    let header_offset = packed[MESH_HEADER_MESH_OFFSETS_BASE + wave_index] as usize;
    let vertex_offset = packed[header_offset + MESH_VERTEX_OFFSET] as usize;
    let index_offset = packed[header_offset + MESH_INDEX_OFFSET] as usize;
    let triangle_count = packed[header_offset + MESH_TRIANGLE_COUNT] as usize;
    let grid_offset = packed[header_offset + crate::packed::MESH_GRID_OFFSET] as usize;
    let grid_cols = packed[header_offset + MESH_GRID_COLS] as i32;
    let grid_rows = packed[header_offset + MESH_GRID_ROWS] as i32;
    let grid_min_x = read_f32(packed, header_offset + MESH_GRID_MIN_X_F32);
    let grid_min_y = read_f32(packed, header_offset + MESH_GRID_MIN_Y_F32);
    let grid_cell_w = read_f32(packed, header_offset + MESH_GRID_CELL_W_F32);
    let grid_cell_h = read_f32(packed, header_offset + MESH_GRID_CELL_H_F32);
    let grid_cos_a = read_f32(packed, header_offset + MESH_GRID_COS_A_F32);
    let grid_sin_a = read_f32(packed, header_offset + MESH_GRID_SIN_A_F32);

    if triangle_count == 0 {
        return (1.0, 0.0);
    }

    // Rotate world position into wave-aligned grid space.
    let rx = world_x * grid_cos_a + world_y * grid_sin_a;
    let ry = -world_x * grid_sin_a + world_y * grid_cos_a;
    let gx = (rx - grid_min_x) / grid_cell_w;
    let gy = (ry - grid_min_y) / grid_cell_h;
    let col = gx.floor() as i32;
    let row = gy.floor() as i32;

    // Out of grid bounds → open ocean.
    if col < 0 || col >= grid_cols || row < 0 || row >= grid_rows {
        return (1.0, 0.0);
    }

    let cell_index = (row * grid_cols + col) as usize;
    let cell_base = grid_offset + cell_index * 2;
    let tri_list_offset = packed[cell_base] as usize;
    let tri_list_count = packed[cell_base + 1] as usize;

    let mut phasor_cos = 0.0_f32;
    let mut phasor_sin = 0.0_f32;
    for t in 0..tri_list_count {
        let tri_index = packed[tri_list_offset + t] as usize;
        let tri_base = index_offset + tri_index * 3;
        let ai = packed[tri_base] as usize;
        let bi = packed[tri_base + 1] as usize;
        let ci = packed[tri_base + 2] as usize;

        let a_base = vertex_offset + ai * MESH_FLOATS_PER_VERTEX;
        let b_base = vertex_offset + bi * MESH_FLOATS_PER_VERTEX;
        let c_base = vertex_offset + ci * MESH_FLOATS_PER_VERTEX;
        let ax = read_f32(packed, a_base);
        let ay = read_f32(packed, a_base + 1);
        let bx = read_f32(packed, b_base);
        let by = read_f32(packed, b_base + 1);
        let cx = read_f32(packed, c_base);
        let cy = read_f32(packed, c_base + 1);

        let bary = barycentric(world_x, world_y, ax, ay, bx, by, cx, cy);
        if bary[0] >= -0.001 && bary[1] >= -0.001 && bary[2] >= -0.001 {
            // attribA.x = amplitudeFactor (offset 2), attribA.z = phaseOffset (offset 4).
            let a_amp = read_f32(packed, a_base + 2);
            let a_phase = read_f32(packed, a_base + 4);
            let b_amp = read_f32(packed, b_base + 2);
            let b_phase = read_f32(packed, b_base + 4);
            let c_amp = read_f32(packed, c_base + 2);
            let c_phase = read_f32(packed, c_base + 4);

            let amp = a_amp * bary[0] + b_amp * bary[1] + c_amp * bary[2];
            let phase = a_phase * bary[0] + b_phase * bary[1] + c_phase * bary[2];
            let (s, c) = fast_sin_cos(phase);
            phasor_cos += amp * c;
            phasor_sin += amp * s;
        }
    }

    // Inside grid but no containing triangle → shadow. (cos, sin) stay zero.
    (phasor_cos, phasor_sin)
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

// ---------------------------------------------------------------------------
// Gerstner wave sum. Two-pass: horizontal displacement, then height +
// velocity at the displaced sample point. Returns
// `(height, vel_x, vel_y, dh_dt)`.
// ---------------------------------------------------------------------------

/// Per-pass scratch — phase plus the geometric data the inner loop
/// needs once we have the sincos values back. Pre-populated scalar
/// (the plane-wave / point-source branch doesn't vectorise cleanly),
/// then sincos is computed in `f32x4` chunks of four.
#[derive(Default, Clone, Copy)]
struct PassScratch {
    phase: f32,
    /// Propagation direction unit vector (x).
    prop_dx: f32,
    /// Propagation direction unit vector (y).
    prop_dy: f32,
}

#[allow(clippy::too_many_arguments)]
fn calculate_gerstner_waves(
    world_x: f32,
    world_y: f32,
    time: f32,
    wave_data: &[f32],
    num_waves: usize,
    steepness: f32,
    energy_factors: &[f32; MAX_WAVE_SOURCES],
    direction_offsets: &[f32; MAX_WAVE_SOURCES],
    phase_corrections: &[f32; MAX_WAVE_SOURCES],
    amp_mod: f32,
) -> (f32, f32, f32, f32) {
    let num_waves_f = num_waves as f32;

    // ---------------------------------------------------------------------
    // Pre-compute per-wave constants used by both passes (k, omega) and
    // pass-1 / pass-2 phases + propagation directions.
    //
    // The plane-wave vs point-source branch is expressed scalar here
    // because the conditional doesn't fit cleanly into SIMD lanes;
    // afterwards sincos is the only meaningful trig cost remaining and
    // it gets vectorised in chunks of 4 below.
    // ---------------------------------------------------------------------

    let mut amplitude = [0.0_f32; MAX_WAVE_SOURCES];
    let mut k_arr = [0.0_f32; MAX_WAVE_SOURCES];
    let mut omega_arr = [0.0_f32; MAX_WAVE_SOURCES];
    let mut pass1 = [PassScratch::default(); MAX_WAVE_SOURCES];

    let sample_x;
    let sample_y;
    {
        let mut disp_x = 0.0_f32;
        let mut disp_y = 0.0_f32;

        for i in 0..num_waves {
            let base = i * FLOATS_PER_WAVE;
            let amp = wave_data[base];
            let wavelength = wave_data[base + 1];
            let direction = wave_data[base + 2];
            let phase_offset = wave_data[base + 3];
            let speed_mult = wave_data[base + 4];
            let source_dist = wave_data[base + 5];
            let source_offset_x = wave_data[base + 6];
            let source_offset_y = wave_data[base + 7];

            let k = TWO_PI / wavelength;
            let omega = (GRAVITY * k).sqrt() * speed_mult;
            amplitude[i] = amp;
            k_arr[i] = k;
            omega_arr[i] = omega;

            if source_dist > 1.0e9 {
                let bent = direction + direction_offsets[i];
                let (dy, dx) = fast_sin_cos(bent);
                let projected = world_x * dx + world_y * dy;
                pass1[i].phase =
                    k * projected - omega * time + phase_offset + phase_corrections[i];
                pass1[i].prop_dx = dx;
                pass1[i].prop_dy = dy;
            } else {
                let (base_dy, base_dx) = fast_sin_cos(direction);
                let source_x = -base_dx * source_dist + source_offset_x;
                let source_y = -base_dy * source_dist + source_offset_y;
                let to_x = world_x - source_x;
                let to_y = world_y - source_y;
                let dist = (to_x * to_x + to_y * to_y).sqrt();
                let inv = if dist > 1.0e-4 { 1.0 / dist } else { 0.0 };
                pass1[i].phase =
                    k * dist - omega * time + phase_offset + phase_corrections[i];
                pass1[i].prop_dx = to_x * inv;
                pass1[i].prop_dy = to_y * inv;
            }
        }

        // SIMD sincos for pass 1 phases — two chunks of 4 (covers the
        // fixed MAX_WAVE_SOURCES=8). Pass-1 only consumes cos, but the
        // SIMD path produces both for free.
        let mut p1_phases = [0.0_f32; MAX_WAVE_SOURCES];
        for i in 0..MAX_WAVE_SOURCES {
            p1_phases[i] = pass1[i].phase;
        }
        let mut p1_sin = [0.0_f32; MAX_WAVE_SOURCES];
        let mut p1_cos = [0.0_f32; MAX_WAVE_SOURCES];
        let (p1_phases_a, p1_phases_b) = p1_phases.split_at(4);
        let (p1_sin_a, p1_sin_b) = p1_sin.split_at_mut(4);
        let (p1_cos_a, p1_cos_b) = p1_cos.split_at_mut(4);
        sincos_chunk_4(
            p1_phases_a.try_into().unwrap(),
            p1_sin_a.try_into().unwrap(),
            p1_cos_a.try_into().unwrap(),
        );
        sincos_chunk_4(
            p1_phases_b.try_into().unwrap(),
            p1_sin_b.try_into().unwrap(),
            p1_cos_b.try_into().unwrap(),
        );

        for i in 0..num_waves {
            let q = steepness / (k_arr[i] * amplitude[i] * num_waves_f);
            let cos_phase = p1_cos[i];
            disp_x += q * amplitude[i] * pass1[i].prop_dx * cos_phase;
            disp_y += q * amplitude[i] * pass1[i].prop_dy * cos_phase;
        }

        sample_x = world_x - disp_x;
        sample_y = world_y - disp_y;
    }

    // ---------------------------------------------------------------------
    // Pass 2: height + velocity at the displaced sample point. Same
    // structure — scalar geometry up front, then SIMD sincos.
    // ---------------------------------------------------------------------

    let mut pass2 = [PassScratch::default(); MAX_WAVE_SOURCES];
    for i in 0..num_waves {
        let base = i * FLOATS_PER_WAVE;
        let direction = wave_data[base + 2];
        let phase_offset = wave_data[base + 3];
        let source_dist = wave_data[base + 5];
        let source_offset_x = wave_data[base + 6];
        let source_offset_y = wave_data[base + 7];
        let k = k_arr[i];
        let omega = omega_arr[i];

        if source_dist > 1.0e9 {
            let bent = direction + direction_offsets[i];
            let (pdy, pdx) = fast_sin_cos(bent);
            let projected = sample_x * pdx + sample_y * pdy;
            pass2[i].phase =
                k * projected - omega * time + phase_offset + phase_corrections[i];
            pass2[i].prop_dx = pdx;
            pass2[i].prop_dy = pdy;
        } else {
            let (base_dy, base_dx) = fast_sin_cos(direction);
            let source_x = -base_dx * source_dist + source_offset_x;
            let source_y = -base_dy * source_dist + source_offset_y;
            let to_x = sample_x - source_x;
            let to_y = sample_y - source_y;
            let dist = (to_x * to_x + to_y * to_y).sqrt();
            let inv = if dist > 1.0e-4 { 1.0 / dist } else { 0.0 };
            pass2[i].phase =
                k * dist - omega * time + phase_offset + phase_corrections[i];
            pass2[i].prop_dx = to_x * inv;
            pass2[i].prop_dy = to_y * inv;
        }
    }

    let mut p2_phases = [0.0_f32; MAX_WAVE_SOURCES];
    for i in 0..MAX_WAVE_SOURCES {
        p2_phases[i] = pass2[i].phase;
    }
    let mut p2_sin = [0.0_f32; MAX_WAVE_SOURCES];
    let mut p2_cos = [0.0_f32; MAX_WAVE_SOURCES];
    let (p2_phases_a, p2_phases_b) = p2_phases.split_at(4);
    let (p2_sin_a, p2_sin_b) = p2_sin.split_at_mut(4);
    let (p2_cos_a, p2_cos_b) = p2_cos.split_at_mut(4);
    sincos_chunk_4(
        p2_phases_a.try_into().unwrap(),
        p2_sin_a.try_into().unwrap(),
        p2_cos_a.try_into().unwrap(),
    );
    sincos_chunk_4(
        p2_phases_b.try_into().unwrap(),
        p2_sin_b.try_into().unwrap(),
        p2_cos_b.try_into().unwrap(),
    );

    let mut height = 0.0_f32;
    let mut dh_dt = 0.0_f32;
    let mut vel_x = 0.0_f32;
    let mut vel_y = 0.0_f32;
    for i in 0..num_waves {
        let amp_eff = amplitude[i] * energy_factors[i];
        let sin_phase = p2_sin[i];
        let cos_phase = p2_cos[i];
        height += amp_eff * amp_mod * sin_phase;
        dh_dt += -amp_eff * amp_mod * omega_arr[i] * cos_phase;

        let vel_coeff = (steepness / (k_arr[i] * num_waves_f))
            * omega_arr[i]
            * amp_mod
            * energy_factors[i]
            * sin_phase;
        vel_x += vel_coeff * pass2[i].prop_dx;
        vel_y += vel_coeff * pass2[i].prop_dy;
    }

    (height, vel_x, vel_y, dh_dt)
}

// Height-only helper for finite-difference normals — re-runs Gerstner
// at the offset sample point and returns just the height (+ tide).
#[allow(clippy::too_many_arguments)]
fn compute_wave_height(
    world_x: f32,
    world_y: f32,
    time: f32,
    wave_sources: &[f32],
    num_waves: usize,
    energy_factors: &[f32; MAX_WAVE_SOURCES],
    direction_offsets: &[f32; MAX_WAVE_SOURCES],
    phase_corrections: &[f32; MAX_WAVE_SOURCES],
    amp_mod: f32,
    tide_height: f32,
) -> f32 {
    let (h, _, _, _) = calculate_gerstner_waves(
        world_x,
        world_y,
        time,
        wave_sources,
        num_waves,
        GERSTNER_STEEPNESS,
        energy_factors,
        direction_offsets,
        phase_corrections,
        amp_mod,
    );
    h + tide_height
}

// ---------------------------------------------------------------------------
// Modifier contributions. Each function mirrors the corresponding WGSL/
// JS implementation in `water-modifiers.wgsl.ts` / `water-math.ts`.
// Returns `(height, vel_x, vel_y, turbulence)`.
// ---------------------------------------------------------------------------

fn wake_contribution(
    world_x: f32,
    world_y: f32,
    base: usize,
    modifiers: &[f32],
) -> (f32, f32, f32, f32) {
    let src_x = modifiers[base + 5];
    let src_y = modifiers[base + 6];
    let ring_radius = modifiers[base + 7];
    let ring_width = modifiers[base + 8];
    let amplitude = modifiers[base + 9];
    let omega = modifiers[base + 10];

    let dx = world_x - src_x;
    let dy = world_y - src_y;
    let dist = (dx * dx + dy * dy).sqrt();
    let dist_from_ring = dist - ring_radius;
    let ring = (-(dist_from_ring * dist_from_ring) / (ring_width * ring_width)).exp();
    let local_amp = amplitude * ring;

    let inv_dist = if dist > 1.0e-4 { 1.0 / dist } else { 0.0 };
    let nx = dx * inv_dist;
    let ny = dy * inv_dist;
    let v_radial = local_amp * omega;
    (local_amp, v_radial * nx, v_radial * ny, 0.0)
}

fn ripple_contribution(
    world_x: f32,
    world_y: f32,
    base: usize,
    modifiers: &[f32],
) -> (f32, f32, f32, f32) {
    let radius = modifiers[base + 5];
    let intensity = modifiers[base + 6];
    let phase = modifiers[base + 7];

    let min_x = modifiers[base + 1];
    let min_y = modifiers[base + 2];
    let max_x = modifiers[base + 3];
    let max_y = modifiers[base + 4];
    let center_x = (min_x + max_x) * 0.5;
    let center_y = (min_y + max_y) * 0.5;
    let dx = world_x - center_x;
    let dy = world_y - center_y;
    let dist = (dx * dx + dy * dy).sqrt();

    // 2ft ring width.
    let ring_width = 2.0_f32;
    let dist_from_ring = (dist - radius).abs();
    let falloff = (1.0 - dist_from_ring / ring_width).max(0.0);
    let height = intensity * falloff * phase.cos();
    (height, 0.0, 0.0, 0.0)
}

fn current_contribution(base: usize, modifiers: &[f32]) -> (f32, f32, f32, f32) {
    let velocity_x = modifiers[base + 5];
    let velocity_y = modifiers[base + 6];
    // fade_distance at base+7 unused (matches WGSL).
    (0.0, velocity_x, velocity_y, 0.0)
}

fn foam_contribution(
    world_x: f32,
    world_y: f32,
    base: usize,
    modifiers: &[f32],
) -> (f32, f32, f32, f32) {
    let src_x = modifiers[base + 5];
    let src_y = modifiers[base + 6];
    let radius = modifiers[base + 7];
    let intensity = modifiers[base + 8];

    let dx = world_x - src_x;
    let dy = world_y - src_y;
    let dist2 = dx * dx + dy * dy;
    let r_sq = (radius * radius).max(1.0e-4);
    let falloff = (-dist2 / r_sq).exp();
    (0.0, 0.0, 0.0, intensity * falloff)
}

fn calculate_modifiers(
    world_x: f32,
    world_y: f32,
    modifiers: &[f32],
    modifier_count: usize,
) -> (f32, f32, f32, f32) {
    let mut total_height = 0.0_f32;
    let mut total_vel_x = 0.0_f32;
    let mut total_vel_y = 0.0_f32;
    let mut max_turb = 0.0_f32;

    let count = modifier_count.min(MAX_MODIFIERS);
    for i in 0..count {
        let base = i * FLOATS_PER_MODIFIER;
        if base + FLOATS_PER_MODIFIER > modifiers.len() {
            break;
        }
        let mod_type = modifiers[base] as i32;
        let min_x = modifiers[base + 1];
        let min_y = modifiers[base + 2];
        let max_x = modifiers[base + 3];
        let max_y = modifiers[base + 4];
        if world_x < min_x || world_x > max_x || world_y < min_y || world_y > max_y {
            continue;
        }
        let (h, vx, vy, t) = match mod_type {
            x if x == MODIFIER_TYPE_WAKE => wake_contribution(world_x, world_y, base, modifiers),
            x if x == MODIFIER_TYPE_RIPPLE => {
                ripple_contribution(world_x, world_y, base, modifiers)
            }
            x if x == MODIFIER_TYPE_CURRENT => current_contribution(base, modifiers),
            x if x == MODIFIER_TYPE_FOAM => foam_contribution(world_x, world_y, base, modifiers),
            // MODIFIER_TYPE_OBSTACLE (4) and unknown types contribute nothing.
            _ => (0.0, 0.0, 0.0, 0.0),
        };
        total_height += h;
        total_vel_x += vx;
        total_vel_y += vy;
        if t > max_turb {
            max_turb = t;
        }
    }

    (total_height, total_vel_x, total_vel_y, max_turb)
}

// ---------------------------------------------------------------------------
// Public entry point — process a batch of points.
// ---------------------------------------------------------------------------

pub fn process_batch(
    points: &[f32],
    params: &[f32],
    modifiers: &[f32],
    modifier_count: usize,
    state: &WorldState,
    results: &mut [f32],
    result_stride: usize,
) {
    let time = params[WATER_PARAM_TIME];
    let tide_height = params[WATER_PARAM_TIDE_HEIGHT];
    let default_depth = params[WATER_PARAM_DEFAULT_DEPTH];
    let num_waves_param = params[WATER_PARAM_NUM_WAVES] as usize;
    let tidal_phase = params[WATER_PARAM_TIDAL_PHASE];
    let tidal_strength = params[WATER_PARAM_TIDAL_STRENGTH];
    let wave_amplitude_scale = params[WATER_PARAM_WAVE_AMPLITUDE_SCALE];

    let wave_sources = &params[WATER_PARAM_WAVE_SOURCES_BASE..];
    let clamped_num_waves = num_waves_param.min(MAX_WAVE_SOURCES);

    // SAFETY: pointers were registered via `set_packed_*` and refer to
    // shared memory regions live for the worker pool's lifetime.
    let (packed_terrain, packed_wave_mesh, packed_tide_mesh) = unsafe {
        (
            state.packed_terrain.as_slice(),
            state.packed_wave_mesh.as_slice(),
            state.packed_tide_mesh.as_slice(),
        )
    };
    let contour_count = terrain_contour_count(packed_terrain);

    let amp_mod_time = time * WAVE_AMP_MOD_TIME_SCALE;

    let point_count = points.len() / STRIDE_PER_POINT;
    for i in 0..point_count {
        let world_x = points[i * STRIDE_PER_POINT];
        let world_y = points[i * STRIDE_PER_POINT + 1];

        let terrain_height = compute_terrain_height(
            world_x,
            world_y,
            packed_terrain,
            contour_count,
            default_depth,
        );

        // Amplitude modulation noise — shared across center/offset normal samples.
        // Global weather amplitude scale folds in here so it cascades through
        // height/dhdt/velocity uniformly.
        let amp_mod = (1.0
            + simplex3d(
                world_x * WAVE_AMP_MOD_SPATIAL_SCALE,
                world_y * WAVE_AMP_MOD_SPATIAL_SCALE,
                amp_mod_time,
            ) * WAVE_AMP_MOD_STRENGTH)
            * wave_amplitude_scale;

        // Per-wave energy + phase from the wavefront mesh.
        let mut energy_factors = [0.0_f32; MAX_WAVE_SOURCES];
        let direction_offsets = [0.0_f32; MAX_WAVE_SOURCES]; // always zero in the query shader.
        let mut phase_corrections = [0.0_f32; MAX_WAVE_SOURCES];
        for w in 0..clamped_num_waves {
            let (pc, ps) = lookup_mesh_for_wave(world_x, world_y, packed_wave_mesh, w);
            energy_factors[w] = (pc * pc + ps * ps).sqrt();
            phase_corrections[w] = if pc == 0.0 && ps == 0.0 {
                0.0
            } else {
                ps.atan2(pc)
            };
        }

        let (h0, vel_x, vel_y, _dh_dt) = calculate_gerstner_waves(
            world_x,
            world_y,
            time,
            wave_sources,
            clamped_num_waves,
            GERSTNER_STEEPNESS,
            &energy_factors,
            &direction_offsets,
            &phase_corrections,
            amp_mod,
        );
        let wave_height = h0 + tide_height;

        // Finite-difference normal — uses the same per-wave energy/phase
        // values across all three height samples, matching the WGSL.
        let hx = compute_wave_height(
            world_x + NORMAL_SAMPLE_OFFSET,
            world_y,
            time,
            wave_sources,
            clamped_num_waves,
            &energy_factors,
            &direction_offsets,
            &phase_corrections,
            amp_mod,
            tide_height,
        );
        let hy = compute_wave_height(
            world_x,
            world_y + NORMAL_SAMPLE_OFFSET,
            time,
            wave_sources,
            clamped_num_waves,
            &energy_factors,
            &direction_offsets,
            &phase_corrections,
            amp_mod,
            tide_height,
        );
        let ndx = (hx - wave_height) / NORMAL_SAMPLE_OFFSET;
        let ndy = (hy - wave_height) / NORMAL_SAMPLE_OFFSET;
        let mut normal_x = 0.0_f32;
        let mut normal_y = 0.0_f32;
        let grad_len = ndx * ndx + ndy * ndy;
        if grad_len >= 0.0001 {
            let inv_len = 1.0 / grad_len.sqrt();
            normal_x = -ndx * inv_len;
            normal_y = -ndy * inv_len;
        }

        // Modifier accumulation.
        let (mod_height, mod_vel_x, mod_vel_y, _mod_turb) =
            calculate_modifiers(world_x, world_y, modifiers, modifier_count);

        // Tidal flow.
        let (tidal_vel_x, tidal_vel_y) = lookup_tidal_flow(
            world_x,
            world_y,
            packed_tide_mesh,
            tide_height,
            tidal_phase,
            tidal_strength,
        );

        let final_surface_height = wave_height + mod_height;
        let final_depth = final_surface_height - terrain_height;

        let r = i * result_stride;
        results[r] = final_surface_height;
        results[r + 1] = vel_x + mod_vel_x + tidal_vel_x;
        results[r + 2] = vel_y + mod_vel_y + tidal_vel_y;
        results[r + 3] = normal_x;
        results[r + 4] = normal_y;
        results[r + 5] = final_depth;
    }
}
