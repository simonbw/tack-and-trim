//! Binary `.terrain` file I/O (v2 + v3 read; v3 write).

use anyhow::Context;

use super::format::{TerrainCPUData, FLOATS_PER_CONTOUR};

/// Write terrain CPU data to a binary `.terrain` file (v3 format).
///
/// Binary format (all little-endian):
///   Header (36 bytes):
///     magic u32 (0x4E525254), version u32 (3), defaultDepth f32, contourCount u32,
///     vertexCount u32, childrenCount u32, containmentGridU32s u32, idwGridU32s u32,
///     lookupGridU32s u32
///   Sections (sequential):
///     1. contourData     — contourCount * 14 * 4 bytes
///     2. vertexData      — vertexCount * 2 * 4 bytes
///     3. childrenData    — childrenCount * 4 bytes
///     4. containmentGrid — containmentGridU32s * 4 bytes
///     5. idwGridData     — idwGridU32s * 4 bytes
///     6. lookupGridData  — lookupGridU32s * 4 bytes
pub fn write_terrain_binary(
    path: &std::path::Path,
    terrain: &TerrainCPUData,
) -> anyhow::Result<()> {
    use std::io::{BufWriter, Write};

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(path)
        .with_context(|| format!("failed to create {}", path.display()))?;
    let mut w = BufWriter::new(file);

    let vertex_count = terrain.vertex_data.len() / 2;

    // Header (36 bytes)
    w.write_all(&0x4E525254_u32.to_le_bytes())?; // magic
    w.write_all(&3_u32.to_le_bytes())?; // version
    w.write_all(&(terrain.default_depth as f32).to_le_bytes())?;
    w.write_all(&(terrain.contour_count as u32).to_le_bytes())?;
    w.write_all(&(vertex_count as u32).to_le_bytes())?;
    w.write_all(&(terrain.children_data.len() as u32).to_le_bytes())?;
    w.write_all(&(terrain.containment_grid_data.len() as u32).to_le_bytes())?;
    w.write_all(&(terrain.idw_grid_data.len() as u32).to_le_bytes())?;
    w.write_all(&(terrain.lookup_grid_data.len() as u32).to_le_bytes())?;

    // Section 1: contourData
    w.write_all(&terrain.contour_data)?;

    // Section 2: vertexData
    for &v in &terrain.vertex_data {
        w.write_all(&v.to_le_bytes())?;
    }

    // Section 3: childrenData
    for &c in &terrain.children_data {
        w.write_all(&c.to_le_bytes())?;
    }

    // Section 4: containmentGrid
    for &g in &terrain.containment_grid_data {
        w.write_all(&g.to_le_bytes())?;
    }

    // Section 5: idwGridData
    for &g in &terrain.idw_grid_data {
        w.write_all(&g.to_le_bytes())?;
    }

    // Section 6: lookupGridData
    for &g in &terrain.lookup_grid_data {
        w.write_all(&g.to_le_bytes())?;
    }

    w.flush()?;
    Ok(())
}

/// Read a binary `.terrain` file (v2 or v3 format) into TerrainCPUData.
pub fn read_terrain_binary(bytes: &[u8]) -> anyhow::Result<TerrainCPUData> {
    anyhow::ensure!(bytes.len() >= 32, "terrain file too short: {} bytes", bytes.len());

    let magic = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    anyhow::ensure!(magic == 0x4E525254, "invalid terrain magic: 0x{:08X}", magic);

    let version = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
    anyhow::ensure!(
        version == 2 || version == 3,
        "unsupported terrain version: {} (expected 2 or 3)",
        version
    );

    let default_depth = f32::from_le_bytes(bytes[8..12].try_into().unwrap()) as f64;
    let contour_count = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let vertex_count = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
    let children_count = u32::from_le_bytes(bytes[20..24].try_into().unwrap()) as usize;
    let containment_grid_u32s = u32::from_le_bytes(bytes[24..28].try_into().unwrap()) as usize;
    let idw_grid_u32s = u32::from_le_bytes(bytes[28..32].try_into().unwrap()) as usize;

    let (lookup_grid_u32s, header_size) = if version >= 3 {
        anyhow::ensure!(bytes.len() >= 36, "v3 terrain file too short for header");
        let n = u32::from_le_bytes(bytes[32..36].try_into().unwrap()) as usize;
        (n, 36usize)
    } else {
        (0usize, 32usize)
    };

    let mut offset = header_size;

    // Section 1: contourData
    let contour_bytes = contour_count * FLOATS_PER_CONTOUR * 4;
    anyhow::ensure!(
        bytes.len() >= offset + contour_bytes,
        "terrain file truncated in contour data"
    );
    let contour_data = bytes[offset..offset + contour_bytes].to_vec();
    offset += contour_bytes;

    // Section 2: vertexData
    let vertex_bytes = vertex_count * 2 * 4;
    anyhow::ensure!(
        bytes.len() >= offset + vertex_bytes,
        "terrain file truncated in vertex data"
    );
    let mut vertex_data = Vec::with_capacity(vertex_count * 2);
    for i in 0..vertex_count * 2 {
        let o = offset + i * 4;
        vertex_data.push(f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
    }
    offset += vertex_bytes;

    // Section 3: childrenData
    let children_bytes = children_count * 4;
    anyhow::ensure!(
        bytes.len() >= offset + children_bytes,
        "terrain file truncated in children data"
    );
    let mut children_data = Vec::with_capacity(children_count);
    for i in 0..children_count {
        let o = offset + i * 4;
        children_data.push(u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
    }
    offset += children_bytes;

    // Section 4: containmentGrid
    let containment_bytes = containment_grid_u32s * 4;
    anyhow::ensure!(
        bytes.len() >= offset + containment_bytes,
        "terrain file truncated in containment grid"
    );
    let mut containment_grid_data = Vec::with_capacity(containment_grid_u32s);
    for i in 0..containment_grid_u32s {
        let o = offset + i * 4;
        containment_grid_data.push(u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
    }
    offset += containment_bytes;

    // Section 5: idwGridData
    let idw_bytes = idw_grid_u32s * 4;
    anyhow::ensure!(
        bytes.len() >= offset + idw_bytes,
        "terrain file truncated in IDW grid data"
    );
    let mut idw_grid_data = Vec::with_capacity(idw_grid_u32s);
    for i in 0..idw_grid_u32s {
        let o = offset + i * 4;
        idw_grid_data.push(u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
    }
    offset += idw_bytes;

    // Section 6: lookupGridData (v3 only)
    let lookup_grid_data = if lookup_grid_u32s > 0 {
        let lookup_bytes = lookup_grid_u32s * 4;
        anyhow::ensure!(
            bytes.len() >= offset + lookup_bytes,
            "terrain file truncated in lookup grid data"
        );
        let mut data = Vec::with_capacity(lookup_grid_u32s);
        for i in 0..lookup_grid_u32s {
            let o = offset + i * 4;
            data.push(u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap()));
        }
        data
    } else {
        Vec::new()
    };

    Ok(TerrainCPUData {
        vertex_data,
        contour_data,
        children_data,
        contour_count,
        default_depth,
        containment_grid_data,
        idw_grid_data,
        lookup_grid_data,
    })
}

/// Reconstruct TerrainContourJSON from TerrainCPUData.
/// Used by resolve_level_terrain to populate the level's contours for backward
/// compatibility with code that reads contours from LevelFileJSON.
pub(super) fn terrain_cpu_data_to_contours(
    terrain: &TerrainCPUData,
) -> Vec<super::format::TerrainContourJSON> {
    let mut contours = Vec::with_capacity(terrain.contour_count);
    for i in 0..terrain.contour_count {
        let base = i * FLOATS_PER_CONTOUR * 4;
        let cd = &terrain.contour_data[base..base + FLOATS_PER_CONTOUR * 4];

        let point_start =
            u32::from_le_bytes(cd[0..4].try_into().unwrap()) as usize;
        let point_count =
            u32::from_le_bytes(cd[4..8].try_into().unwrap()) as usize;
        let height = f32::from_le_bytes(cd[8..12].try_into().unwrap()) as f64;

        let mut polygon = Vec::with_capacity(point_count);
        for j in 0..point_count {
            let vi = (point_start + j) * 2;
            let x = terrain.vertex_data[vi] as f64;
            let y = terrain.vertex_data[vi + 1] as f64;
            polygon.push([x, y]);
        }

        contours.push(super::format::TerrainContourJSON {
            height,
            control_points: None,
            polygon: Some(polygon),
        });
    }
    contours
}
