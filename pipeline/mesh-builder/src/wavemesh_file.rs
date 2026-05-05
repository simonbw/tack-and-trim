//! Binary .wavemesh output format and FNV-1a input hashing.
//!
//! The canonical format specification (with byte-level layout) lives in the
//! TypeScript implementation: `src/pipeline/mesh-building/WavemeshFile.ts`.
//! See also `src/pipeline/CLAUDE.md` for a summary.

use pipeline_core::level::{TerrainCPUData, WaveSource};
use crate::wavefront::WavefrontMeshData;

const MAGIC: u32 = 0x484d5657; // "WVMH" little-endian
const VERSION: u16 = 1;
const HEADER_BYTES: usize = 32;
const ENTRY_BYTES: usize = 16;
const COVERAGE_BYTES: usize = 36;

/// Serialize wave mesh data into the binary `.wavemesh` format.
pub fn build_wavemesh_buffer(meshes: &[WavefrontMeshData], input_hash: [u32; 2]) -> Vec<u8> {
    let wave_count = meshes.len();
    let mut data_size = 0usize;
    let mut vertex_offsets = Vec::with_capacity(wave_count);
    let mut index_offsets = Vec::with_capacity(wave_count);

    for mesh in meshes {
        vertex_offsets.push(data_size);
        data_size += mesh.vertex_count * 6 * 4;
        index_offsets.push(data_size);
        data_size += mesh.index_count * 4;
    }

    let table_start = HEADER_BYTES;
    let coverage_start = table_start + ENTRY_BYTES * wave_count;
    let data_start = coverage_start + COVERAGE_BYTES * wave_count;
    let total_size = data_start + data_size;

    let mut buf = vec![0u8; total_size];

    // Header
    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    buf[6..8].copy_from_slice(&(wave_count as u16).to_le_bytes());
    buf[8..12].copy_from_slice(&input_hash[0].to_le_bytes());
    buf[12..16].copy_from_slice(&input_hash[1].to_le_bytes());

    for i in 0..wave_count {
        let mesh = &meshes[i];
        let entry_off = table_start + i * ENTRY_BYTES;
        let vert_data_off = data_start + vertex_offsets[i];
        let idx_data_off = data_start + index_offsets[i];

        buf[entry_off..entry_off + 4].copy_from_slice(&(vert_data_off as u32).to_le_bytes());
        buf[entry_off + 4..entry_off + 8]
            .copy_from_slice(&(mesh.vertex_count as u32).to_le_bytes());
        buf[entry_off + 8..entry_off + 12].copy_from_slice(&(idx_data_off as u32).to_le_bytes());
        buf[entry_off + 12..entry_off + 16]
            .copy_from_slice(&(mesh.index_count as u32).to_le_bytes());

        // Coverage quad
        let cov_off = coverage_start + i * COVERAGE_BYTES;
        buf[cov_off..cov_off + 4].copy_from_slice(&1u32.to_le_bytes());
        let q = &mesh.coverage_quad;
        for (j, &val) in [q.x0, q.y0, q.x1, q.y1, q.x2, q.y2, q.x3, q.y3]
            .iter()
            .enumerate()
        {
            let off = cov_off + 4 + j * 4;
            buf[off..off + 4].copy_from_slice(&(val as f32).to_le_bytes());
        }

        // Vertex data
        for (vi, &val) in mesh.vertices[..mesh.vertex_count * 6].iter().enumerate() {
            let off = vert_data_off + vi * 4;
            buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
        }

        // Index data
        for (ii, &val) in mesh.indices[..mesh.index_count].iter().enumerate() {
            let off = idx_data_off + ii * 4;
            buf[off..off + 4].copy_from_slice(&val.to_le_bytes());
        }
    }

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

/// Compute a 64-bit FNV-1a hash of all terrain data and wave source parameters
/// for cache invalidation. Returns `[hash_lo, hash_hi]`.
pub fn compute_input_hash(
    wave_sources: &[WaveSource],
    terrain: &TerrainCPUData,
    tide_height: f64,
) -> [u32; 2] {
    // Collect all byte slices
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
    let tide_bytes = f64_bytes(tide_height);

    let mut parts: Vec<Vec<u8>> = vec![
        vertex_bytes,
        terrain.contour_data.clone(),
        children_bytes,
        contour_count_bytes.to_vec(),
        default_depth_bytes.to_vec(),
        tide_bytes.to_vec(),
    ];

    for ws in wave_sources {
        parts.push(f64_bytes(ws.wavelength).to_vec());
        parts.push(f64_bytes(ws.direction).to_vec());
        parts.push(f64_bytes(ws.amplitude).to_vec());
        parts.push(f64_bytes(ws.source_dist).to_vec());
        parts.push(f64_bytes(ws.source_offset_x).to_vec());
        parts.push(f64_bytes(ws.source_offset_y).to_vec());
    }

    let refs: Vec<&[u8]> = parts.iter().map(|p| p.as_slice()).collect();
    [fnv1a_32(&refs, 0x811c9dc5), fnv1a_32(&refs, 0x050c5d1f)]
}
