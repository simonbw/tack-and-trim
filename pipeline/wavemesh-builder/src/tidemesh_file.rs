//! Binary .tidemesh output format and FNV-1a input hashing.

use crate::level::TerrainCPUData;
use crate::tidemesh::TideMeshData;

const MAGIC: u32 = 0x4D444954; // "TIDM" little-endian
const VERSION: u16 = 1;
const HEADER_BYTES: usize = 64;

/// Serialize tide mesh data into the binary `.tidemesh` format.
///
/// Format:
///   HEADER (64 bytes)
///   TIDE LEVEL TABLE (4 bytes x tideLevelCount)
///   VERTEX POSITION DATA (2 * 4 bytes per vertex)
///   FLOW DATA (tideLevelCount * vertexCount * 4 * 4 bytes)
///   INDEX DATA (3 * 4 bytes per triangle)
///   GRID CELL HEADERS (2 * 4 bytes per cell)
///   GRID TRIANGLE LISTS (4 bytes per entry)
pub fn build_tidemesh_buffer(mesh: &TideMeshData, input_hash: [u32; 2]) -> Vec<u8> {
    let tide_level_count = mesh.tide_levels.len();
    let vertex_count = mesh.vertex_count;
    let triangle_count = mesh.triangle_count;
    let grid_cols = mesh.grid_cols;
    let grid_rows = mesh.grid_rows;
    let cell_count = grid_cols * grid_rows;

    let tide_table_bytes = tide_level_count * 4;
    let vertex_pos_bytes = vertex_count * 2 * 4;
    let flow_data_bytes = tide_level_count * vertex_count * 4 * 4;
    let index_data_bytes = triangle_count * 3 * 4;
    let grid_header_bytes = cell_count * 2 * 4;
    let grid_list_bytes = mesh.grid_triangle_lists.len() * 4;

    let total_size = HEADER_BYTES
        + tide_table_bytes
        + vertex_pos_bytes
        + flow_data_bytes
        + index_data_bytes
        + grid_header_bytes
        + grid_list_bytes;

    let mut buf = vec![0u8; total_size];
    let mut off;

    // ── Header (64 bytes) ────────────────────────────────────────────────────
    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    buf[6..8].copy_from_slice(&(tide_level_count as u16).to_le_bytes());
    buf[8..12].copy_from_slice(&input_hash[0].to_le_bytes());
    buf[12..16].copy_from_slice(&input_hash[1].to_le_bytes());
    buf[16..20].copy_from_slice(&(vertex_count as u32).to_le_bytes());
    buf[20..24].copy_from_slice(&(triangle_count as u32).to_le_bytes());
    buf[24..28].copy_from_slice(&(grid_cols as u32).to_le_bytes());
    buf[28..32].copy_from_slice(&(grid_rows as u32).to_le_bytes());
    buf[32..36].copy_from_slice(&(mesh.grid_min_x as f32).to_le_bytes());
    buf[36..40].copy_from_slice(&(mesh.grid_min_y as f32).to_le_bytes());
    buf[40..44].copy_from_slice(&(mesh.grid_cell_width as f32).to_le_bytes());
    buf[44..48].copy_from_slice(&(mesh.grid_cell_height as f32).to_le_bytes());
    // [48..63] reserved = 0
    off = HEADER_BYTES;

    // ── Tide level table ─────────────────────────────────────────────────────
    for &level in &mesh.tide_levels {
        buf[off..off + 4].copy_from_slice(&(level as f32).to_le_bytes());
        off += 4;
    }

    // ── Vertex position data ─────────────────────────────────────────────────
    for i in 0..vertex_count {
        let x = mesh.vertex_positions[i * 2];
        let y = mesh.vertex_positions[i * 2 + 1];
        buf[off..off + 4].copy_from_slice(&x.to_le_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&y.to_le_bytes());
        off += 4;
    }

    // ── Flow data ────────────────────────────────────────────────────────────
    for &val in &mesh.flow_data {
        buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
        off += 4;
    }

    // ── Index data ───────────────────────────────────────────────────────────
    for &idx in &mesh.indices {
        buf[off..off + 4].copy_from_slice(&idx.to_le_bytes());
        off += 4;
    }

    // ── Grid cell headers ────────────────────────────────────────────────────
    for i in 0..cell_count {
        let cell_offset = mesh.grid_cell_offsets[i];
        let cell_count = mesh.grid_cell_counts[i];
        buf[off..off + 4].copy_from_slice(&cell_offset.to_le_bytes());
        off += 4;
        buf[off..off + 4].copy_from_slice(&cell_count.to_le_bytes());
        off += 4;
    }

    // ── Grid triangle lists ──────────────────────────────────────────────────
    for &tri_idx in &mesh.grid_triangle_lists {
        buf[off..off + 4].copy_from_slice(&tri_idx.to_le_bytes());
        off += 4;
    }

    debug_assert_eq!(off, total_size);

    buf
}

/// FNV-1a 32-bit hash.
fn fnv1a_32(parts: &[&[u8]], offset_basis: u32) -> u32 {
    let mut h = offset_basis;
    for part in parts {
        for &b in *part {
            h ^= b as u32;
            h = h.wrapping_mul(0x01000193);
        }
    }
    h
}

fn f64_bytes(v: f64) -> [u8; 8] {
    v.to_le_bytes()
}

/// Compute a 64-bit FNV-1a hash of terrain data and tide levels for cache
/// invalidation. Returns `[hash_lo, hash_hi]`.
pub fn compute_tide_input_hash(terrain: &TerrainCPUData, tide_levels: &[f64]) -> [u32; 2] {
    let vertex_bytes: Vec<u8> = terrain
        .vertex_data
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect();
    let children_bytes: Vec<u8> = terrain
        .children_data
        .iter()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    let contour_count_bytes = f64_bytes(terrain.contour_count as f64);
    let default_depth_bytes = f64_bytes(terrain.default_depth);
    let tide_level_bytes: Vec<u8> = tide_levels
        .iter()
        .flat_map(|t| t.to_le_bytes())
        .collect();

    let parts: Vec<Vec<u8>> = vec![
        vertex_bytes,
        terrain.contour_data.clone(),
        children_bytes,
        contour_count_bytes.to_vec(),
        default_depth_bytes.to_vec(),
        tide_level_bytes,
    ];

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    [fnv1a_32(&refs, 0x811c9dc5), fnv1a_32(&refs, 0x050c5d1f)]
}
