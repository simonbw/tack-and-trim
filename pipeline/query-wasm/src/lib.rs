//! Compute kernel for the CPU world-state query backend.
//!
//! Each query worker instantiates a `WebAssembly.Instance` of this
//! module against a single, shared `WebAssembly.Memory` owned by the
//! main thread. All per-frame buffers (points, params, results,
//! modifiers) and all immutable world-state buffers (packed terrain,
//! wave mesh, tide mesh, wind mesh) live inside that shared memory at
//! offsets the host partitions manually.
//!
//! Per frame, JS calls e.g. `process_water_batch(points_ptr,
//! point_count, params_ptr, modifiers_ptr, modifier_count, results_ptr,
//! result_stride)` directly — no copies, just pointer arithmetic into
//! shared memory.
//!
//! The kernel doesn't own allocations. Memory layout is the host's
//! responsibility. Each Instance does carry per-instance world-state
//! pointers (set via `set_packed_*` at worker init), but those are
//! just `(ptr, len)` pairs into the shared memory.

mod fast_trig;
mod noise;
mod packed;
mod terrain;
mod terrain_slow;
mod tide;
mod water;
mod wind;
mod world_state;

use crate::world_state::{with_world_state, with_world_state_mut, PackedRef};

// ---------------------------------------------------------------------------
// Implementation mask. Each phase of the port flips on the corresponding
// bit. Workers read this once at init and fall back to the JS path for
// query types whose bit is unset.
// ---------------------------------------------------------------------------

pub const IMPL_BIT_TERRAIN: u32 = 1 << 0;
pub const IMPL_BIT_WATER: u32 = 1 << 1;
pub const IMPL_BIT_WIND: u32 = 1 << 2;

#[no_mangle]
pub extern "C" fn query_implementation_mask() -> u32 {
    IMPL_BIT_TERRAIN | IMPL_BIT_WATER | IMPL_BIT_WIND
}

// ---------------------------------------------------------------------------
// World-state pointer registration. Each worker calls these once at init
// with offsets into the shared `WebAssembly.Memory`. Stored in this
// instance's `static mut WORLD_STATE` (per-instance, so each worker has
// its own copy of the pointer table).
// ---------------------------------------------------------------------------

/// # Safety
/// `ptr` must be a valid pointer into shared linear memory pointing to
/// `len_u32` u32 elements that remain live for the worker's lifetime,
/// or null with `len_u32 == 0`.
#[no_mangle]
pub unsafe extern "C" fn set_packed_terrain(ptr: *const u32, len_u32: u32) {
    with_world_state_mut(|s| {
        s.packed_terrain = PackedRef {
            ptr,
            len: len_u32 as usize,
        };
    });
}

/// # Safety: see `set_packed_terrain`.
#[no_mangle]
pub unsafe extern "C" fn set_packed_wave_mesh(ptr: *const u32, len_u32: u32) {
    with_world_state_mut(|s| {
        s.packed_wave_mesh = PackedRef {
            ptr,
            len: len_u32 as usize,
        };
    });
}

/// # Safety: see `set_packed_terrain`.
#[no_mangle]
pub unsafe extern "C" fn set_packed_tide_mesh(ptr: *const u32, len_u32: u32) {
    with_world_state_mut(|s| {
        s.packed_tide_mesh = PackedRef {
            ptr,
            len: len_u32 as usize,
        };
    });
}

/// # Safety: see `set_packed_terrain`.
#[no_mangle]
pub unsafe extern "C" fn set_packed_wind_mesh(ptr: *const u32, len_u32: u32) {
    with_world_state_mut(|s| {
        s.packed_wind_mesh = PackedRef {
            ptr,
            len: len_u32 as usize,
        };
    });
}

// ---------------------------------------------------------------------------
// Per-frame batch entry points.
// ---------------------------------------------------------------------------

/// # Safety
/// All pointers must point into the shared linear memory and have the
/// declared element counts. World state must have been registered via
/// `set_packed_*` prior to the first call.
#[no_mangle]
pub unsafe extern "C" fn process_water_batch(
    points_ptr: *const f32,
    point_count: u32,
    params_ptr: *const f32,
    modifiers_ptr: *const f32,
    modifier_count: u32,
    results_ptr: *mut f32,
    result_stride: u32,
) {
    if point_count == 0 || result_stride == 0 {
        return;
    }
    let points = std::slice::from_raw_parts(
        points_ptr,
        (point_count as usize) * water::STRIDE_PER_POINT,
    );
    let params = std::slice::from_raw_parts(params_ptr, water::PARAMS_FLOATS_PER_CHANNEL);
    let modifiers = if modifiers_ptr.is_null() || modifier_count == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(
            modifiers_ptr,
            (modifier_count as usize) * water::FLOATS_PER_MODIFIER,
        )
    };
    let results = std::slice::from_raw_parts_mut(
        results_ptr,
        (point_count as usize) * (result_stride as usize),
    );

    with_world_state(|state| {
        water::process_batch(
            points,
            params,
            modifiers,
            modifier_count as usize,
            state,
            results,
            result_stride as usize,
        );
    });
}

/// # Safety: see `process_water_batch`.
#[no_mangle]
pub unsafe extern "C" fn process_terrain_batch(
    points_ptr: *const f32,
    point_count: u32,
    params_ptr: *const f32,
    results_ptr: *mut f32,
    result_stride: u32,
) {
    if point_count == 0 || result_stride == 0 {
        return;
    }
    let points = std::slice::from_raw_parts(
        points_ptr,
        (point_count as usize) * terrain::STRIDE_PER_POINT,
    );
    let params = std::slice::from_raw_parts(params_ptr, terrain::PARAMS_FLOATS_PER_CHANNEL);
    let results = std::slice::from_raw_parts_mut(
        results_ptr,
        (point_count as usize) * (result_stride as usize),
    );

    with_world_state(|state| {
        terrain::process_batch(points, params, state, results, result_stride as usize);
    });
}

/// Pure-compute calibration probe — no memory access beyond the
/// register state. Runs a fixed-cost arithmetic loop so we can compare
/// "what does N units of CPU work take in this environment" between the
/// bench and the production worker pool. Useful for separating CPU
/// scheduling / frequency effects (which slow this down) from data /
/// cache effects (which don't).
///
/// `iterations` is a tunable so the caller can pick a window long
/// enough to be measurable but short enough not to bog the frame down.
/// Returns the final accumulator so the optimiser can't elide the loop.
#[no_mangle]
pub extern "C" fn calibration_probe(iterations: u32) -> f32 {
    let mut a = 1.0_f32;
    let mut b = 0.5_f32;
    for _ in 0..iterations {
        a = a * 1.0000001 + b;
        b = b * 0.9999999 + a;
    }
    a + b
}

/// # Safety: see `process_water_batch`.
#[no_mangle]
pub unsafe extern "C" fn process_wind_batch(
    points_ptr: *const f32,
    point_count: u32,
    params_ptr: *const f32,
    results_ptr: *mut f32,
    result_stride: u32,
) {
    if point_count == 0 || result_stride == 0 {
        return;
    }
    let points = std::slice::from_raw_parts(
        points_ptr,
        (point_count as usize) * wind::STRIDE_PER_POINT,
    );
    let params = std::slice::from_raw_parts(params_ptr, wind::PARAMS_FLOATS_PER_CHANNEL);
    let results = std::slice::from_raw_parts_mut(
        results_ptr,
        (point_count as usize) * (result_stride as usize),
    );

    with_world_state(|state| {
        wind::process_batch(points, params, state, results, result_stride as usize);
    });
}
