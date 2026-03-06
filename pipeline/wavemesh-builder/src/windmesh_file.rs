use crate::level::TerrainCPUData;
use crate::windmesh::WindMeshData;

const MAGIC: u32 = 0x4d444e57; // "WNDM" little-endian
const VERSION: u16 = 1;
const HEADER_BYTES: usize = 16;
const METADATA_BYTES: usize = 32;

pub fn build_windmesh_buffer(mesh: &WindMeshData, input_hash: [u32; 2]) -> Vec<u8> {
    let vertex_data_bytes = mesh.vertex_count * 5 * 4;
    let index_data_bytes = mesh.index_count * 4;
    let total_size = HEADER_BYTES + METADATA_BYTES + vertex_data_bytes + index_data_bytes;

    let mut buf = vec![0u8; total_size];

    // Header (16 bytes)
    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    // [6..7] reserved = 0
    buf[8..12].copy_from_slice(&input_hash[0].to_le_bytes());
    buf[12..16].copy_from_slice(&input_hash[1].to_le_bytes());

    // Mesh metadata (32 bytes)
    let m = HEADER_BYTES;
    buf[m..m + 4].copy_from_slice(&(mesh.vertex_count as u32).to_le_bytes());
    buf[m + 4..m + 8].copy_from_slice(&(mesh.index_count as u32).to_le_bytes());
    buf[m + 8..m + 12].copy_from_slice(&(mesh.grid_cols as u32).to_le_bytes());
    buf[m + 12..m + 16].copy_from_slice(&(mesh.grid_rows as u32).to_le_bytes());
    buf[m + 16..m + 20].copy_from_slice(&(mesh.grid_min_x as f32).to_le_bytes());
    buf[m + 20..m + 24].copy_from_slice(&(mesh.grid_min_y as f32).to_le_bytes());
    buf[m + 24..m + 28].copy_from_slice(&(mesh.grid_cell_width as f32).to_le_bytes());
    buf[m + 28..m + 32].copy_from_slice(&(mesh.grid_cell_height as f32).to_le_bytes());

    // Vertex data
    let data_start = HEADER_BYTES + METADATA_BYTES;
    for (i, &val) in mesh.vertices[..mesh.vertex_count * 5].iter().enumerate() {
        let off = data_start + i * 4;
        buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
    }

    // Index data
    let index_start = data_start + vertex_data_bytes;
    for (i, &val) in mesh.indices[..mesh.index_count].iter().enumerate() {
        let off = index_start + i * 4;
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

pub fn compute_wind_input_hash(terrain: &TerrainCPUData) -> [u32; 2] {
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

    let parts: Vec<Vec<u8>> = vec![
        vertex_bytes,
        terrain.contour_data.clone(),
        children_bytes,
        contour_count_bytes.to_vec(),
        default_depth_bytes.to_vec(),
    ];

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    [fnv1a_32(&refs, 0x811c9dc5), fnv1a_32(&refs, 0x050c5d1f)]
}
