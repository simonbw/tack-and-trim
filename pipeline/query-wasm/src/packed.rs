//! Read-only accessors over the packed `[u32]` buffers shared with the
//! GPU shaders. Each buffer aliases mixed u32/f32 fields in a single
//! linear allocation; the WGSL side reads via `bitcast<f32>()`, and on
//! the wasm side we use `f32::from_bits()` (the same operation).
//!
//! Layouts mirror:
//! - `src/game/world/shaders/terrain-packed.wgsl.ts`
//! - `src/game/world/shaders/mesh-packed.wgsl.ts`
//! - `src/game/world/shaders/tide-mesh-packed.wgsl.ts`
//! - `src/game/world/shaders/wind-mesh-packed.wgsl.ts`
//!
//! Keep these constants in sync with the WGSL and the TypeScript ports
//! (`terrain-math.ts`, `water-math.ts`, etc.).

// ---------------------------------------------------------------------------
// Terrain packed-buffer layout (mirrors terrain-packed.wgsl.ts)
// ---------------------------------------------------------------------------

pub const TERRAIN_HEADER_VERTICES_OFFSET: usize = 0;
pub const TERRAIN_HEADER_CONTOURS_OFFSET: usize = 1;
pub const TERRAIN_HEADER_CHILDREN_OFFSET: usize = 2;
// Slots 3..5 are containment-grid / IDW-grid offsets (not used here —
// CPU port intentionally takes the slow path).

pub const FLOATS_PER_CONTOUR: usize = 14;

pub const CONTOUR_POINT_START: usize = 0;
pub const CONTOUR_POINT_COUNT: usize = 1;
pub const CONTOUR_HEIGHT: usize = 2;
pub const CONTOUR_DEPTH: usize = 4;
pub const CONTOUR_CHILD_START: usize = 5;
pub const CONTOUR_CHILD_COUNT: usize = 6;
pub const CONTOUR_BBOX_MIN_X: usize = 8;
pub const CONTOUR_BBOX_MIN_Y: usize = 9;
pub const CONTOUR_BBOX_MAX_X: usize = 10;
pub const CONTOUR_BBOX_MAX_Y: usize = 11;
pub const CONTOUR_SKIP_COUNT: usize = 12;

#[inline]
pub fn contour_base(packed: &[u32], contour_index: usize) -> usize {
    packed[TERRAIN_HEADER_CONTOURS_OFFSET] as usize + contour_index * FLOATS_PER_CONTOUR
}

#[inline]
pub fn terrain_vertex_xy(packed: &[u32], vertex_index: usize) -> (f32, f32) {
    let base = packed[TERRAIN_HEADER_VERTICES_OFFSET] as usize + vertex_index * 2;
    (f32::from_bits(packed[base]), f32::from_bits(packed[base + 1]))
}

#[inline]
pub fn terrain_child_index(packed: &[u32], child_list_index: usize) -> usize {
    let children_base = packed[TERRAIN_HEADER_CHILDREN_OFFSET] as usize;
    packed[children_base + child_list_index] as usize
}

/// Derive contour count from the packed-terrain layout. The contour
/// section starts at HEADER_CONTOURS_OFFSET and each contour is
/// FLOATS_PER_CONTOUR wide; the children section follows it, so we
/// derive the count from the gap between the two offsets.
pub fn terrain_contour_count(packed: &[u32]) -> usize {
    if packed.len() <= TERRAIN_HEADER_CHILDREN_OFFSET {
        return 0;
    }
    let contours_offset = packed[TERRAIN_HEADER_CONTOURS_OFFSET] as usize;
    let children_offset = packed[TERRAIN_HEADER_CHILDREN_OFFSET] as usize;
    if children_offset > contours_offset {
        (children_offset - contours_offset) / FLOATS_PER_CONTOUR
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Wave mesh packed-buffer layout (mirrors mesh-packed.wgsl.ts)
// ---------------------------------------------------------------------------

pub const MESH_HEADER_MESH_OFFSETS_BASE: usize = 1;

/// Offsets into a per-wave mesh header (16 u32). [13..15] are padding.
pub const MESH_VERTEX_OFFSET: usize = 0;
pub const MESH_INDEX_OFFSET: usize = 2;
pub const MESH_TRIANGLE_COUNT: usize = 3;
pub const MESH_GRID_OFFSET: usize = 4;
pub const MESH_GRID_COLS: usize = 5;
pub const MESH_GRID_ROWS: usize = 6;
pub const MESH_GRID_MIN_X_F32: usize = 7;
pub const MESH_GRID_MIN_Y_F32: usize = 8;
pub const MESH_GRID_CELL_W_F32: usize = 9;
pub const MESH_GRID_CELL_H_F32: usize = 10;
pub const MESH_GRID_COS_A_F32: usize = 11;
pub const MESH_GRID_SIN_A_F32: usize = 12;

/// Each wave-mesh vertex is 6 floats: [posX, posY, ampFactor, dirOffset,
/// phaseOffset, blendWeight].
pub const MESH_FLOATS_PER_VERTEX: usize = 6;

#[inline]
pub fn mesh_num_waves(packed: &[u32]) -> u32 {
    if packed.is_empty() {
        0
    } else {
        packed[0]
    }
}

// ---------------------------------------------------------------------------
// Wind mesh packed-buffer layout (mirrors wind-mesh-packed.wgsl.ts).
// ---------------------------------------------------------------------------

/// Each wind-mesh vertex is 5 floats: [posX, posY, speedFactor,
/// dirOffset, turbulence].
pub const WIND_MESH_FLOATS_PER_VERTEX: usize = 5;
