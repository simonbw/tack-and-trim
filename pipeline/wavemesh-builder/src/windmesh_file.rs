use crate::level::TerrainCPUData;
use crate::windmesh::WindMeshData;

const MAGIC: u32 = 0x4d444e57; // "WNDM" little-endian
const VERSION: u16 = 2;
const HEADER_BYTES: usize = 32;

/// Build a version 2 multi-source windmesh buffer.
///
/// Format:
///   Header (32 bytes):
///     [0..3]   magic: "WNDM"
///     [4..5]   version: u16 = 2
///     [6..7]   sourceCount: u16
///     [8..15]  inputHash (2 x u32)
///     [16..31] reserved
///
///   Per-source direction table (4 bytes x sourceCount):
///     direction: f32 (radians)
///
///   Per-source entry table (16 bytes x sourceCount):
///     vertexDataOffset, vertexCount, indexDataOffset, indexCount (all u32)
///
///   Shared grid metadata (32 bytes):
///     gridCols, gridRows, gridMinX, gridMinY, gridCellWidth, gridCellHeight, reserved x2
///
///   Data sections (concatenated):
///     Vertex data per source (5 f32/vertex)
///     Index data (shared — same triangulation for all sources)
pub fn build_windmesh_buffer(meshes: &[WindMeshData], input_hash: [u32; 2]) -> Vec<u8> {
    let source_count = meshes.len();
    assert!(source_count > 0, "need at least one wind mesh");

    // All sources share the same grid dimensions and index data
    let ref_mesh = &meshes[0];
    let grid_cols = ref_mesh.grid_cols;
    let grid_rows = ref_mesh.grid_rows;
    let index_count = ref_mesh.index_count;

    let direction_table_bytes = source_count * 4;
    let entry_table_bytes = source_count * 16;
    let grid_metadata_bytes = 32;

    let per_source_vertex_bytes = ref_mesh.vertex_count * 5 * 4;
    let total_vertex_bytes = per_source_vertex_bytes * source_count;
    let index_data_bytes = index_count * 4; // shared

    let data_section_start =
        HEADER_BYTES + direction_table_bytes + entry_table_bytes + grid_metadata_bytes;
    let total_size = data_section_start + total_vertex_bytes + index_data_bytes;

    let mut buf = vec![0u8; total_size];

    // Header (32 bytes)
    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    buf[6..8].copy_from_slice(&(source_count as u16).to_le_bytes());
    buf[8..12].copy_from_slice(&input_hash[0].to_le_bytes());
    buf[12..16].copy_from_slice(&input_hash[1].to_le_bytes());
    // [16..31] reserved = 0

    // Per-source direction table
    let dir_table_start = HEADER_BYTES;
    for (i, mesh) in meshes.iter().enumerate() {
        let off = dir_table_start + i * 4;
        buf[off..off + 4].copy_from_slice(&(mesh.direction as f32).to_le_bytes());
    }

    // Per-source entry table
    let entry_table_start = dir_table_start + direction_table_bytes;
    let index_data_offset = data_section_start + total_vertex_bytes;

    for (i, mesh) in meshes.iter().enumerate() {
        let off = entry_table_start + i * 16;
        let vertex_data_offset = data_section_start + i * per_source_vertex_bytes;
        buf[off..off + 4].copy_from_slice(&(vertex_data_offset as u32).to_le_bytes());
        buf[off + 4..off + 8].copy_from_slice(&(mesh.vertex_count as u32).to_le_bytes());
        buf[off + 8..off + 12].copy_from_slice(&(index_data_offset as u32).to_le_bytes());
        buf[off + 12..off + 16].copy_from_slice(&(mesh.index_count as u32).to_le_bytes());
    }

    // Shared grid metadata (32 bytes)
    let gm = entry_table_start + entry_table_bytes;
    buf[gm..gm + 4].copy_from_slice(&(grid_cols as u32).to_le_bytes());
    buf[gm + 4..gm + 8].copy_from_slice(&(grid_rows as u32).to_le_bytes());
    buf[gm + 8..gm + 12].copy_from_slice(&(ref_mesh.grid_min_x as f32).to_le_bytes());
    buf[gm + 12..gm + 16].copy_from_slice(&(ref_mesh.grid_min_y as f32).to_le_bytes());
    buf[gm + 16..gm + 20].copy_from_slice(&(ref_mesh.grid_cell_width as f32).to_le_bytes());
    buf[gm + 20..gm + 24].copy_from_slice(&(ref_mesh.grid_cell_height as f32).to_le_bytes());
    // [gm+24..gm+32] reserved = 0

    // Vertex data per source
    for (i, mesh) in meshes.iter().enumerate() {
        let start = data_section_start + i * per_source_vertex_bytes;
        for (j, &val) in mesh.vertices[..mesh.vertex_count * 5].iter().enumerate() {
            let off = start + j * 4;
            buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
        }
    }

    // Index data (shared — use first mesh's indices)
    for (j, &val) in ref_mesh.indices[..index_count].iter().enumerate() {
        let off = index_data_offset + j * 4;
        buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
    }

    buf
}

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

pub fn compute_wind_input_hash(
    terrain: &TerrainCPUData,
    wind_directions: &[f64],
) -> [u32; 2] {
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
    let direction_bytes: Vec<u8> = wind_directions
        .iter()
        .flat_map(|d| d.to_le_bytes())
        .collect();

    let parts: Vec<Vec<u8>> = vec![
        vertex_bytes,
        terrain.contour_data.clone(),
        children_bytes,
        contour_count_bytes.to_vec(),
        default_depth_bytes.to_vec(),
        direction_bytes,
    ];

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    [fnv1a_32(&refs, 0x811c9dc5), fnv1a_32(&refs, 0x050c5d1f)]
}
