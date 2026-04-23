//! JSON level file parsing, Catmull-Rom spline sampling, contour tree building,
//! and terrain CPU data construction. Mirrors LevelFileFormat.ts + LandMass.ts.

use anyhow::Context;
use serde::{Deserialize, Deserializer};

// ── Region config types ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct BoundingBox {
    #[serde(rename = "minLat")]
    pub min_lat: f64,
    #[serde(rename = "minLon")]
    pub min_lon: f64,
    #[serde(rename = "maxLat")]
    pub max_lat: f64,
    #[serde(rename = "maxLon")]
    pub max_lon: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum DataSourceConfig {
    #[serde(rename = "cudem")]
    Cudem {
        #[serde(rename = "datasetPath")]
        dataset_path: String,
    },
    #[serde(rename = "usace-s3")]
    UsaceS3 {
        #[serde(rename = "baseUrl")]
        base_url: String,
        #[serde(rename = "statePrefix")]
        state_prefix: String,
        #[serde(rename = "urlList")]
        url_list: String,
    },
    #[serde(rename = "emodnet-wcs")]
    EmodnetWcs {
        #[serde(rename = "coverageId")]
        coverage_id: String,
    },
}

/// A positive value that may vary with elevation.
///
/// Deserializes from either a bare number (uniform value everywhere) or an
/// array of `[height_ft, value]` breakpoints sorted by `height_ft` ascending.
/// Used for contour `interval` (piecewise-constant lookup via `step_at`) and
/// polygon `simplify` tolerance (piecewise-linear lookup via `interp_at`).
#[derive(Debug, Clone)]
pub struct ElevationSchedule {
    /// Breakpoints, sorted by height ascending. For a scalar config, contains
    /// a single entry; `step_at` and `interp_at` both return its value.
    breakpoints: Vec<(f64, f64)>,
}

impl ElevationSchedule {
    pub fn scalar(value: f64) -> Self {
        Self {
            breakpoints: vec![(0.0, value)],
        }
    }

    pub fn from_breakpoints(breakpoints: Vec<(f64, f64)>) -> anyhow::Result<Self> {
        if breakpoints.is_empty() {
            anyhow::bail!("elevation schedule must have at least one breakpoint");
        }
        for (i, &(_, v)) in breakpoints.iter().enumerate() {
            if !(v > 0.0) || !v.is_finite() {
                anyhow::bail!(
                    "elevation schedule value at index {} must be a positive finite number (got {})",
                    i,
                    v
                );
            }
        }
        for pair in breakpoints.windows(2) {
            if !(pair[1].0 > pair[0].0) {
                anyhow::bail!(
                    "elevation schedule heights must be strictly increasing ({} not greater than {})",
                    pair[1].0,
                    pair[0].0
                );
            }
        }
        Ok(Self { breakpoints })
    }

    /// Piecewise-constant lookup: returns the value of the greatest breakpoint
    /// whose height is `<= height`. If `height` is below every breakpoint,
    /// returns the first (lowest-elevation) value.
    pub fn step_at(&self, height: f64) -> f64 {
        let mut current = self.breakpoints[0].1;
        for &(h, v) in &self.breakpoints {
            if h <= height {
                current = v;
            } else {
                break;
            }
        }
        current
    }

    /// Piecewise-linear lookup: interpolates between adjacent breakpoints.
    /// Clamps to the endpoint values outside the schedule's range.
    pub fn interp_at(&self, height: f64) -> f64 {
        let bps = &self.breakpoints;
        if height <= bps[0].0 {
            return bps[0].1;
        }
        if height >= bps[bps.len() - 1].0 {
            return bps[bps.len() - 1].1;
        }
        for pair in bps.windows(2) {
            let (h0, v0) = pair[0];
            let (h1, v1) = pair[1];
            if height <= h1 {
                let t = (height - h0) / (h1 - h0);
                return v0 + t * (v1 - v0);
            }
        }
        bps[bps.len() - 1].1
    }

    /// Is this schedule a single scalar (one breakpoint)?
    pub fn is_scalar(&self) -> bool {
        self.breakpoints.len() == 1
    }

    pub fn breakpoints(&self) -> &[(f64, f64)] {
        &self.breakpoints
    }
}

impl<'de> Deserialize<'de> for ElevationSchedule {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Scalar(f64),
            Schedule(Vec<[f64; 2]>),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Scalar(v) => {
                if !(v > 0.0) || !v.is_finite() {
                    return Err(serde::de::Error::custom(format!(
                        "elevation value must be a positive finite number (got {})",
                        v
                    )));
                }
                Ok(Self::scalar(v))
            }
            Raw::Schedule(pairs) => {
                let breakpoints: Vec<(f64, f64)> =
                    pairs.into_iter().map(|[h, v]| (h, v)).collect();
                Self::from_breakpoints(breakpoints).map_err(serde::de::Error::custom)
            }
        }
    }
}

/// Region configuration for terrain extraction, embedded in the level file.
///
/// Bounds can be specified as either a rectangular `bbox` or a convex `bounds`
/// polygon (array of `[lat, lon]` vertices). Exactly one must be present.
/// When `bounds` is used, the pipeline computes the AABB from the polygon
/// vertices for tile fetching and grid merging, then masks grid cells outside
/// the polygon before contour extraction.
#[derive(Debug, Clone, Deserialize)]
pub struct RegionConfig {
    #[serde(rename = "datasetPath")]
    pub dataset_path: Option<String>,
    #[serde(rename = "dataSource")]
    pub data_source: Option<DataSourceConfig>,
    pub bbox: Option<BoundingBox>,
    pub bounds: Option<Vec<[f64; 2]>>,
    pub interval: ElevationSchedule,
    pub simplify: ElevationSchedule,
    pub scale: f64,
    #[serde(rename = "minPerimeter")]
    pub min_perimeter: f64,
    #[serde(rename = "minPoints")]
    pub min_points: usize,
    #[serde(rename = "flipY")]
    pub flip_y: bool,
}

impl RegionConfig {
    /// Returns the effective axis-aligned bounding box, whether specified
    /// directly via `bbox` or computed from the `bounds` polygon vertices.
    pub fn effective_bbox(&self) -> BoundingBox {
        if let Some(ref bbox) = self.bbox {
            return bbox.clone();
        }
        if let Some(ref bounds) = self.bounds {
            let mut min_lat = f64::INFINITY;
            let mut max_lat = f64::NEG_INFINITY;
            let mut min_lon = f64::INFINITY;
            let mut max_lon = f64::NEG_INFINITY;
            for &[lat, lon] in bounds {
                min_lat = min_lat.min(lat);
                max_lat = max_lat.max(lat);
                min_lon = min_lon.min(lon);
                max_lon = max_lon.max(lon);
            }
            return BoundingBox {
                min_lat,
                max_lat,
                min_lon,
                max_lon,
            };
        }
        panic!("RegionConfig must have either bbox or bounds");
    }
}

// ── Biome types ─────────────────────────────────────────────────────────────

/// A single biome elevation zone. Only fields relevant to tree generation are
/// parsed here; color/noise fields are ignored by serde's default behavior.
#[derive(Deserialize, Debug, Clone)]
pub struct BiomeZoneJSON {
    #[serde(rename = "maxHeight")]
    pub max_height: f64,
    #[serde(rename = "treeDensity")]
    pub tree_density: Option<f64>,
}

/// Biome configuration from the level file. Only the zones array is needed
/// for tree generation; other biome fields (rock, snow, noise) are ignored.
#[derive(Deserialize, Debug, Clone)]
pub struct BiomeConfigJSON {
    pub zones: Vec<BiomeZoneJSON>,
}

// ── JSON types ───────────────────────────────────────────────────────────────

/// Tree generation configuration from the level file.
#[derive(Deserialize, Debug, Clone)]
pub struct TreeConfigJSON {
    /// Minimum distance between trees in feet (default: 40).
    pub spacing: Option<f64>,
    /// Fraction of valid positions that get trees, 0–1 (default: 0.7).
    pub density: Option<f64>,
    /// Minimum terrain elevation for trees in feet (default: 5).
    #[serde(rename = "minElevation")]
    pub min_elevation: Option<f64>,
    /// Maximum terrain elevation for trees in feet (default: 500).
    #[serde(rename = "maxElevation")]
    pub max_elevation: Option<f64>,
}

/// Top-level JSON structure for a `.level.json` file.
#[derive(Deserialize, Debug)]
pub struct LevelFileJSON {
    #[allow(dead_code)]
    pub version: u32,
    pub name: Option<String>,
    pub region: Option<RegionConfig>,
    #[serde(rename = "defaultDepth")]
    pub default_depth: Option<f64>,
    pub waves: Option<WaveConfigJSON>,
    pub wind: Option<WindConfigJSON>,
    pub trees: Option<TreeConfigJSON>,
    pub biome: Option<BiomeConfigJSON>,
    #[serde(default)]
    pub contours: Vec<TerrainContourJSON>,
}

/// Top-level JSON structure for a `.terrain.json` file.
#[derive(Deserialize, Debug)]
pub struct TerrainFileJSON {
    #[allow(dead_code)]
    pub version: u32,
    #[serde(rename = "defaultDepth")]
    pub default_depth: Option<f64>,
    pub contours: Vec<TerrainContourJSON>,
}

/// Parse a terrain JSON string into a `TerrainFileJSON`.
pub fn parse_terrain_file(json_str: &str) -> anyhow::Result<TerrainFileJSON> {
    Ok(serde_json::from_str(json_str)?)
}

/// Resolve terrain references: if the level has a `region`, find the
/// binary `.terrain` path. Returns the path if a region is defined.
pub fn resolve_terrain_path(
    level: &LevelFileJSON,
    level_path: &std::path::Path,
) -> anyhow::Result<Option<std::path::PathBuf>> {
    if level.region.is_some() {
        let slug = level_slug_from_path(level_path);
        Ok(Some(find_terrain_file(&slug, level_path)?))
    } else {
        Ok(None)
    }
}

/// Resolve terrain references: if the level has a `region`, read the
/// binary `.terrain` file from `static/levels/` and merge its contours and
/// defaultDepth into the level.
pub fn resolve_level_terrain(
    level: &mut LevelFileJSON,
    level_path: &std::path::Path,
) -> anyhow::Result<()> {
    if level.region.is_some() {
        let slug = level_slug_from_path(level_path);
        let terrain_path = find_terrain_file(&slug, level_path)?;
        let bytes = std::fs::read(&terrain_path).with_context(|| {
            format!(
                "failed to read terrain file: {} (referenced by {})",
                terrain_path.display(),
                level_path.display()
            )
        })?;
        let terrain = read_terrain_binary(&bytes).with_context(|| {
            format!("failed to parse terrain file: {}", terrain_path.display())
        })?;
        if level.default_depth.is_none() {
            level.default_depth = Some(terrain.default_depth);
        }
        // Reconstruct TerrainContourJSON from the binary data
        level.contours = terrain_cpu_data_to_contours(&terrain);
    }
    Ok(())
}

/// Extract a level slug from its file path (e.g. "vendovi-island" from "vendovi-island.level.json").
fn level_slug_from_path(level_path: &std::path::Path) -> String {
    level_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(".level", "")
}

/// Find the binary .terrain file for a slug by checking:
/// 1. `static/levels/<slug>.terrain` relative to the level file's grandparent (repo root)
/// 2. Walking up from the level file looking for a `static/` directory
fn find_terrain_file(
    slug: &str,
    level_path: &std::path::Path,
) -> anyhow::Result<std::path::PathBuf> {
    let filename = format!("{}.terrain", slug);

    // The level file is typically at <repo>/resources/levels/<name>.level.json
    // So the repo root is two directories up, and static/ is at <repo>/static/levels/
    if let Some(levels_dir) = level_path.parent() {
        if let Some(resources_dir) = levels_dir.parent() {
            if let Some(repo_root) = resources_dir.parent() {
                let candidate = repo_root.join("static").join("levels").join(&filename);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
        // Also try sibling static/levels/ from the level file's directory
        let candidate = levels_dir.join(&filename);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    anyhow::bail!(
        "terrain file not found: static/levels/{} (referenced by {})",
        filename,
        level_path.display()
    )
}

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
fn terrain_cpu_data_to_contours(terrain: &TerrainCPUData) -> Vec<TerrainContourJSON> {
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

        contours.push(TerrainContourJSON {
            height,
            control_points: None,
            polygon: Some(polygon),
        });
    }
    contours
}

/// Optional wave configuration section in a level file.
#[derive(Deserialize, Debug)]
pub struct WaveConfigJSON {
    pub sources: Vec<WaveSourceJSON>,
}

/// JSON representation of a single wave source.
#[derive(Deserialize, Debug, Clone)]
pub struct WaveSourceJSON {
    pub amplitude: f64,
    pub wavelength: f64,
    pub direction: f64,
    #[serde(rename = "phaseOffset", default)]
    pub phase_offset: f64,
    #[serde(rename = "speedMult", default = "default_speed_mult")]
    pub speed_mult: f64,
    #[serde(rename = "sourceDist", default = "default_source_dist")]
    pub source_dist: f64,
    #[serde(rename = "sourceOffsetX", default)]
    pub source_offset_x: f64,
    #[serde(rename = "sourceOffsetY", default)]
    pub source_offset_y: f64,
}
fn default_speed_mult() -> f64 {
    1.0
}
fn default_source_dist() -> f64 {
    1e10
}

// ── Wind source types ────────────────────────────────────────────────────────

/// JSON representation of a single wind source.
#[derive(Deserialize, Debug, Clone)]
pub struct WindSourceJSON {
    pub direction: f64,
}

/// Optional wind configuration section in a level file.
#[derive(Deserialize, Debug)]
pub struct WindConfigJSON {
    pub sources: Vec<WindSourceJSON>,
}

/// Resolved wind source parameters used during mesh building.
#[derive(Clone, Debug)]
pub struct WindSource {
    pub direction: f64,
}

impl From<&WindSourceJSON> for WindSource {
    fn from(j: &WindSourceJSON) -> Self {
        WindSource {
            direction: j.direction,
        }
    }
}

/// Default wind sources used when the level file has no "wind" section.
/// Single NE source matching the default baseWind of V(11, 11).
/// atan2(11, 11) = PI/4.
pub fn default_wind_sources() -> Vec<WindSource> {
    vec![WindSource {
        direction: std::f64::consts::FRAC_PI_4,
    }]
}

// ── Terrain types ────────────────────────────────────────────────────────────

/// JSON representation of a terrain contour (island, shoal, etc.).
#[derive(Deserialize, Debug)]
pub struct TerrainContourJSON {
    pub height: f64,
    #[serde(rename = "controlPoints")]
    pub control_points: Option<Vec<[f64; 2]>>,
    pub polygon: Option<Vec<[f64; 2]>>,
}

// ── WaveSource ───────────────────────────────────────────────────────────────

/// Resolved wave source parameters used during mesh building.
#[derive(Clone, Debug)]
pub struct WaveSource {
    pub amplitude: f64,
    pub wavelength: f64,
    pub direction: f64,
    pub source_dist: f64,
    pub source_offset_x: f64,
    pub source_offset_y: f64,
}

impl From<&WaveSourceJSON> for WaveSource {
    fn from(j: &WaveSourceJSON) -> Self {
        WaveSource {
            amplitude: j.amplitude,
            wavelength: j.wavelength,
            direction: j.direction,
            source_dist: j.source_dist,
            source_offset_x: j.source_offset_x,
            source_offset_y: j.source_offset_y,
        }
    }
}

/// Default wave sources used when the level file has no "waves" section.
/// Matches DEFAULT_WAVE_SOURCES in WaveSource.ts.
pub fn default_wave_sources() -> Vec<WaveSource> {
    vec![
        WaveSource {
            amplitude: 0.4,
            wavelength: 200.0,
            direction: 0.8,
            source_dist: 1e10,
            source_offset_x: 0.0,
            source_offset_y: 0.0,
        },
        WaveSource {
            amplitude: 0.15,
            wavelength: 20.0,
            direction: 0.8,
            source_dist: 1e10,
            source_offset_x: 0.0,
            source_offset_y: 0.0,
        },
    ]
}

// ── TerrainCPUData ───────────────────────────────────────────────────────────

const DEFAULT_DEPTH: f64 = -300.0;
const SAMPLES_PER_SEGMENT: usize = 16;
/// Number of 32-bit values per contour in the binary contour data buffer.
pub const FLOATS_PER_CONTOUR: usize = 14;

// Grid constants matching TypeScript TerrainConstants.ts
pub const CONTAINMENT_GRID_SIZE: usize = 64;
const CONTAINMENT_GRID_CELLS: usize = CONTAINMENT_GRID_SIZE * CONTAINMENT_GRID_SIZE;
const CONTAINMENT_GRID_U32S_PER_CONTOUR: usize = CONTAINMENT_GRID_CELLS / 16; // 256
const IDW_GRID_SIZE: usize = 32;
const IDW_GRID_CELLS: usize = IDW_GRID_SIZE * IDW_GRID_SIZE;
const IDW_GRID_CELL_STARTS: usize = IDW_GRID_CELLS + 1;
const MAX_IDW_CONTOURS: usize = 32;

// Contour lookup grid constants (level-wide grid for fast deepest-contour lookup)
const LOOKUP_GRID_SIZE: usize = 1024;
const LOOKUP_GRID_HEADER: usize = 6; // cols, rows, min_x, min_y, inv_cell_w, inv_cell_h

/// Polygon contour input for `build_terrain_data_from_polygons`.
pub struct PolygonContour {
    pub height: f64,
    pub polygon: Vec<[f64; 2]>,
}

/// CPU-side terrain data matching the GPU packed buffer layout.
#[derive(Clone)]
pub struct TerrainCPUData {
    pub vertex_data: Vec<f32>,
    pub contour_data: Vec<u8>,
    pub children_data: Vec<u32>,
    pub contour_count: usize,
    pub default_depth: f64,
    pub containment_grid_data: Vec<u32>,
    pub idw_grid_data: Vec<u32>,
    pub lookup_grid_data: Vec<u32>,
}

// ── Catmull-Rom spline ───────────────────────────────────────────────────────

fn catmull_rom_point(p0: [f64; 2], p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], t: f64) -> [f64; 2] {
    let t2 = t * t;
    let t3 = t2 * t;
    let x = 0.5
        * (2.0 * p1[0]
            + (-p0[0] + p2[0]) * t
            + (2.0 * p0[0] - 5.0 * p1[0] + 4.0 * p2[0] - p3[0]) * t2
            + (-p0[0] + 3.0 * p1[0] - 3.0 * p2[0] + p3[0]) * t3);
    let y = 0.5
        * (2.0 * p1[1]
            + (-p0[1] + p2[1]) * t
            + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2
            + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3);
    [x, y]
}

fn sample_closed_spline(control_points: &[[f64; 2]], samples_per_segment: usize) -> Vec<[f64; 2]> {
    let n = control_points.len();
    if n < 3 {
        return control_points.to_vec();
    }
    let mut result = Vec::with_capacity(n * samples_per_segment);
    for i in 0..n {
        let p0 = control_points[(i + n - 1) % n];
        let p1 = control_points[i];
        let p2 = control_points[(i + 1) % n];
        let p3 = control_points[(i + 2) % n];
        for s in 0..samples_per_segment {
            let t = s as f64 / samples_per_segment as f64;
            result.push(catmull_rom_point(p0, p1, p2, p3, t));
        }
    }
    result
}

fn adaptive_samples_per_segment(control_points: &[[f64; 2]]) -> usize {
    let n = control_points.len();
    if n < 3 {
        return 1;
    }
    let mut total_length = 0.0;
    for i in 0..n {
        let a = control_points[i];
        let b = control_points[(i + 1) % n];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        total_length += (dx * dx + dy * dy).sqrt();
    }
    let avg = total_length / n as f64;
    (avg / SAMPLES_PER_SEGMENT as f64)
        .round()
        .max(1.0)
        .min(SAMPLES_PER_SEGMENT as f64) as usize
}

// ── Winding normalisation ────────────────────────────────────────────────────

fn signed_area(points: &[[f64; 2]]) -> f64 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += points[i][0] * points[j][1];
        area -= points[j][0] * points[i][1];
    }
    area / 2.0
}

fn ensure_ccw(points: &mut [[f64; 2]]) {
    if signed_area(points) > 0.0 {
        points.reverse();
    }
}

// ── Point-in-polygon ─────────────────────────────────────────────────────────

fn point_in_polygon(px: f64, py: f64, polygon: &[[f64; 2]]) -> bool {
    let n = polygon.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let yi = polygon[i][1];
        let yj = polygon[j][1];
        if (yi > py) != (yj > py)
            && px < (polygon[j][0] - polygon[i][0]) * (py - yi) / (yj - yi) + polygon[i][0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// ── Containment grid (2-bit packed) ──────────────────────────────────────────

const CELL_OUTSIDE: u8 = 0;
const CELL_INSIDE: u8 = 1;
const CELL_BOUNDARY: u8 = 2;

/// DDA rasterization of a line segment into grid cells, marking traversed cells as BOUNDARY.
fn rasterize_edge_to_grid(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    min_x: f64,
    min_y: f64,
    inv_cell_w: f64,
    inv_cell_h: f64,
    cols: usize,
    rows: usize,
    cell_flags: &mut [u8],
) {
    let max_col = cols as isize - 1;
    let max_row = rows as isize - 1;

    let mut col = ((ax - min_x) * inv_cell_w).floor() as isize;
    let mut row = ((ay - min_y) * inv_cell_h).floor() as isize;
    let end_col = ((bx - min_x) * inv_cell_w).floor() as isize;
    let end_row = ((by - min_y) * inv_cell_h).floor() as isize;

    if col >= 0 && col <= max_col && row >= 0 && row <= max_row {
        cell_flags[row as usize * cols + col as usize] = CELL_BOUNDARY;
    }

    let dx = bx - ax;
    let dy = by - ay;
    let step_col: isize = if dx > 0.0 { 1 } else if dx < 0.0 { -1 } else { 0 };
    let step_row: isize = if dy > 0.0 { 1 } else if dy < 0.0 { -1 } else { 0 };

    let cell_w = 1.0 / inv_cell_w;
    let cell_h = 1.0 / inv_cell_h;

    let mut t_max_x = if dx != 0.0 {
        let next_x = if dx > 0.0 {
            min_x + (col + 1) as f64 * cell_w
        } else {
            min_x + col as f64 * cell_w
        };
        (next_x - ax) / dx
    } else {
        f64::MAX
    };
    let mut t_max_y = if dy != 0.0 {
        let next_y = if dy > 0.0 {
            min_y + (row + 1) as f64 * cell_h
        } else {
            min_y + row as f64 * cell_h
        };
        (next_y - ay) / dy
    } else {
        f64::MAX
    };
    let t_delta_x = if dx != 0.0 { (cell_w / dx).abs() } else { f64::MAX };
    let t_delta_y = if dy != 0.0 { (cell_h / dy).abs() } else { f64::MAX };

    let max_steps = (cols + rows) * 2;
    for _ in 0..max_steps {
        if col == end_col && row == end_row {
            break;
        }
        if t_max_x < t_max_y {
            col += step_col;
            t_max_x += t_delta_x;
        } else {
            row += step_row;
            t_max_y += t_delta_y;
        }
        if col >= 0 && col <= max_col && row >= 0 && row <= max_row {
            cell_flags[row as usize * cols + col as usize] = CELL_BOUNDARY;
        }
    }
}

/// Build a 64×64 containment grid for a polygon, packed into 256 u32s (2 bits per cell).
fn build_containment_grid_packed(polygon: &[[f64; 2]], bbox: &BBox) -> Vec<u32> {
    let cols = CONTAINMENT_GRID_SIZE;
    let rows = CONTAINMENT_GRID_SIZE;
    let num_cells = CONTAINMENT_GRID_CELLS;

    let w = (bbox.max_x - bbox.min_x).max(1e-9);
    let h = (bbox.max_y - bbox.min_y).max(1e-9);
    let inv_cell_w = cols as f64 / w;
    let inv_cell_h = rows as f64 / h;
    let cell_w = w / cols as f64;
    let cell_h = h / rows as f64;

    let mut cell_flags = vec![CELL_OUTSIDE; num_cells];

    // Rasterize polygon edges
    let n = polygon.len();
    for i in 0..n {
        let j = (i + 1) % n;
        rasterize_edge_to_grid(
            polygon[i][0],
            polygon[i][1],
            polygon[j][0],
            polygon[j][1],
            bbox.min_x,
            bbox.min_y,
            inv_cell_w,
            inv_cell_h,
            cols,
            rows,
            &mut cell_flags,
        );
    }

    // Test center of non-boundary cells
    for cell in 0..num_cells {
        if cell_flags[cell] != CELL_BOUNDARY {
            let col = cell % cols;
            let row = cell / cols;
            let cx = bbox.min_x + (col as f64 + 0.5) * cell_w;
            let cy = bbox.min_y + (row as f64 + 0.5) * cell_h;
            if point_in_polygon(cx, cy, polygon) {
                cell_flags[cell] = CELL_INSIDE;
            }
        }
    }

    // Pack into 2-bit representation: 16 cells per u32
    let mut packed = vec![0u32; CONTAINMENT_GRID_U32S_PER_CONTOUR];
    for i in 0..num_cells {
        packed[i >> 4] |= ((cell_flags[i] as u32) & 3) << ((i & 15) * 2);
    }
    packed
}

// ── IDW grid (precomputed candidate edges) ───────────────────────────────────

/// Squared distance from point to line segment.
fn point_to_segment_dist_sq(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let len_sq = (abx * abx + aby * aby).max(1e-20);
    let t = (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0);
    let nx = ax + t * abx;
    let ny = ay + t * aby;
    let dx = px - nx;
    let dy = py - ny;
    dx * dx + dy * dy
}

/// Compute both (min_dist_sq, max_dist_sq) from an axis-aligned rectangle to a
/// line segment in a single pass, sharing the 4 corner distance computations.
///
/// `max_dist` = max corner-to-segment distance (exact, since dist is convex).
/// `min_dist` = min of corner-to-segment and endpoint-to-rect distances, with
/// a Liang-Barsky intersection test only when the cheap checks are inconclusive.
#[inline]
fn rect_segment_min_max_dist_sq(
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> (f64, f64) {
    // 4 corner-to-segment distances (shared for both min and max)
    let d0 = point_to_segment_dist_sq(rx0, ry0, ax, ay, bx, by);
    let d1 = point_to_segment_dist_sq(rx1, ry0, ax, ay, bx, by);
    let d2 = point_to_segment_dist_sq(rx0, ry1, ax, ay, bx, by);
    let d3 = point_to_segment_dist_sq(rx1, ry1, ax, ay, bx, by);

    let d_max = d0.max(d1).max(d2).max(d3);
    let d_min_corners = d0.min(d1).min(d2).min(d3);

    // If a corner lies on the segment, min is 0
    if d_min_corners == 0.0 {
        return (0.0, d_max);
    }

    // Check segment endpoints inside rect (very cheap)
    let de0 = point_to_rect_dist_sq(ax, ay, rx0, ry0, rx1, ry1);
    if de0 == 0.0 {
        return (0.0, d_max);
    }
    let de1 = point_to_rect_dist_sq(bx, by, rx0, ry0, rx1, ry1);
    if de1 == 0.0 {
        return (0.0, d_max);
    }

    let d_min = d_min_corners.min(de0).min(de1);

    // If segment AABB doesn't overlap cell, no crossing is possible
    let e_min_x = ax.min(bx);
    let e_max_x = ax.max(bx);
    let e_min_y = ay.min(by);
    let e_max_y = ay.max(by);
    if e_min_x > rx1 || e_max_x < rx0 || e_min_y > ry1 || e_max_y < ry0 {
        return (d_min, d_max);
    }

    // AABBs overlap but endpoints are outside — segment might cross through.
    // Use Liang-Barsky to check.
    if segment_crosses_rect(ax, ay, bx, by, rx0, ry0, rx1, ry1) {
        return (0.0, d_max);
    }

    (d_min, d_max)
}

/// Squared distance from point to axis-aligned rectangle (0 if inside).
#[inline]
fn point_to_rect_dist_sq(px: f64, py: f64, rx0: f64, ry0: f64, rx1: f64, ry1: f64) -> f64 {
    let dx = if px < rx0 {
        rx0 - px
    } else if px > rx1 {
        px - rx1
    } else {
        0.0
    };
    let dy = if py < ry0 {
        ry0 - py
    } else if py > ry1 {
        py - ry1
    } else {
        0.0
    };
    dx * dx + dy * dy
}

/// Liang-Barsky test: does segment cross through rect? (Both endpoints outside.)
#[inline]
fn segment_crosses_rect(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
) -> bool {
    let dx = bx - ax;
    let dy = by - ay;
    let mut t_min = 0.0f64;
    let mut t_max = 1.0f64;

    let clips = [
        (-dx, ax - rx0),
        (dx, rx1 - ax),
        (-dy, ay - ry0),
        (dy, ry1 - ay),
    ];

    for &(p, q) in &clips {
        if p.abs() < 1e-20 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t_max {
                    return false;
                }
                if r > t_min {
                    t_min = r;
                }
            } else {
                if r < t_min {
                    return false;
                }
                if r < t_max {
                    t_max = r;
                }
            }
        }
    }

    t_min <= t_max
}

/// Build a 32×32 IDW candidate grid for a parent contour and its children.
/// Returns (cell_starts, entries) matching the TS buildIDWGrid format.
fn build_idw_grid_packed(
    parent_polygon: &[[f64; 2]],
    child_polygons: &[&[[f64; 2]]],
    parent_bbox: &BBox,
) -> (Vec<u32>, Vec<u32>) {
    let min_x = parent_bbox.min_x;
    let min_y = parent_bbox.min_y;
    let w = (parent_bbox.max_x - min_x).max(1e-9);
    let h = (parent_bbox.max_y - min_y).max(1e-9);
    let cell_w = w / IDW_GRID_SIZE as f64;
    let cell_h = h / IDW_GRID_SIZE as f64;

    // Collect all edges with tags
    struct IDWEdge {
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        tag: u16,
        edge_index: u16,
    }
    let mut edges = Vec::new();

    // Parent edges (tag 0)
    for i in 0..parent_polygon.len() {
        let j = (i + 1) % parent_polygon.len();
        edges.push(IDWEdge {
            ax: parent_polygon[i][0],
            ay: parent_polygon[i][1],
            bx: parent_polygon[j][0],
            by: parent_polygon[j][1],
            tag: 0,
            edge_index: i as u16,
        });
    }

    // Child edges (tags 1..N)
    for (ci, poly) in child_polygons.iter().enumerate() {
        for i in 0..poly.len() {
            let j = (i + 1) % poly.len();
            edges.push(IDWEdge {
                ax: poly[i][0],
                ay: poly[i][1],
                bx: poly[j][0],
                by: poly[j][1],
                tag: (ci + 1) as u16,
                edge_index: i as u16,
            });
        }
    }

    let num_tags = 1 + child_polygons.len();
    let mut cell_entries: Vec<Vec<u32>> = vec![Vec::new(); IDW_GRID_CELLS];

    // Pre-allocate working buffers
    let mut per_tag_upper_bound_sq = vec![f64::MAX; num_tags];
    let mut edge_min_dists = vec![0.0f64; edges.len()];
    let mut cell_candidate_indices: Vec<usize> = Vec::new();

    for row in 0..IDW_GRID_SIZE {
        for col in 0..IDW_GRID_SIZE {
            let rx0 = min_x + col as f64 * cell_w;
            let ry0 = min_y + row as f64 * cell_h;
            let rx1 = rx0 + cell_w;
            let ry1 = ry0 + cell_h;

            // Single pass: compute both min and max distances, sharing corner
            // computations. Track per-tag upper bound and store per-edge min.
            per_tag_upper_bound_sq.fill(f64::MAX);
            for (i, e) in edges.iter().enumerate() {
                let (d_min, d_max) =
                    rect_segment_min_max_dist_sq(rx0, ry0, rx1, ry1, e.ax, e.ay, e.bx, e.by);
                edge_min_dists[i] = d_min;
                let tag = e.tag as usize;
                if d_max < per_tag_upper_bound_sq[tag] {
                    per_tag_upper_bound_sq[tag] = d_max;
                }
            }

            // Collect candidates passing the rect-segment upper bound filter
            cell_candidate_indices.clear();
            for (i, e) in edges.iter().enumerate() {
                if edge_min_dists[i] <= per_tag_upper_bound_sq[e.tag as usize] {
                    cell_candidate_indices.push(i);
                }
            }

            let cell = row * IDW_GRID_SIZE + col;

            // Add all candidates that pass the rect-segment upper bound filter.
            for &ei in &cell_candidate_indices {
                let e = &edges[ei];
                cell_entries[cell]
                    .push(((e.tag as u32) << 16) | (e.edge_index as u32));
            }
        }
    }

    // Flatten into prefix-sum storage
    let mut cell_starts = Vec::with_capacity(IDW_GRID_CELL_STARTS);
    cell_starts.push(0u32);
    for cell in &cell_entries {
        cell_starts.push(cell_starts.last().unwrap() + cell.len() as u32);
    }
    let mut entries = Vec::new();
    for cell in &cell_entries {
        entries.extend_from_slice(cell);
    }

    (cell_starts, entries)
}

// ── Contour lookup grid (level-wide, for GPU) ────────────────────────────────

/// Build a 256×256 contour lookup grid packed for GPU upload.
///
/// GPU format (all u32):
///   [cols, rows, min_x(f32 bits), min_y(f32 bits), inv_cell_w(f32 bits), inv_cell_h(f32 bits),
///    base_contour[N], cell_starts[N+1], candidates[...]]
/// where N = cols * rows = 65536.
///
/// base_contour[cell] = DFS index of deepest fully-containing contour, or u32::MAX.
/// candidates are sorted deepest-first; the first passing isInsideContour is the answer.
fn build_lookup_grid_packed_gpu(
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    dfs_order: &[usize],
    tree: &ContourTree,
) -> Vec<u32> {
    use rayon::prelude::*;

    let n = dfs_order.len();
    if n == 0 {
        return Vec::new();
    }

    // Compute level bounds from all contour bboxes
    let mut level_min_x = f64::MAX;
    let mut level_min_y = f64::MAX;
    let mut level_max_x = f64::MIN;
    let mut level_max_y = f64::MIN;
    for &orig in dfs_order {
        let bb = &bboxes[orig];
        level_min_x = level_min_x.min(bb.min_x);
        level_min_y = level_min_y.min(bb.min_y);
        level_max_x = level_max_x.max(bb.max_x);
        level_max_y = level_max_y.max(bb.max_y);
    }

    let cols = LOOKUP_GRID_SIZE;
    let rows = LOOKUP_GRID_SIZE;
    let w = (level_max_x - level_min_x).max(1e-9);
    let h = (level_max_y - level_min_y).max(1e-9);
    let inv_cell_w = cols as f64 / w;
    let inv_cell_h = rows as f64 / h;
    let cell_w = w / cols as f64;
    let cell_h = h / rows as f64;
    let num_cells = cols * rows;

    // Classify cells per contour in parallel (indexed by DFS index)
    let per_contour: Vec<Vec<CellClassification>> = (0..n)
        .into_par_iter()
        .map(|dfs_idx| {
            let orig = dfs_order[dfs_idx];
            let polygon = &sampled[orig];
            let bb = &bboxes[orig];

            if polygon.len() < 3 {
                return Vec::new();
            }

            let c0 = ((bb.min_x - level_min_x) * inv_cell_w)
                .floor()
                .max(0.0) as usize;
            let c1 = ((bb.max_x - level_min_x) * inv_cell_w)
                .floor()
                .min((cols - 1) as f64) as usize;
            let r0 = ((bb.min_y - level_min_y) * inv_cell_h)
                .floor()
                .max(0.0) as usize;
            let r1 = ((bb.max_y - level_min_y) * inv_cell_h)
                .floor()
                .min((rows - 1) as f64) as usize;

            let bbox_cols = c1 - c0 + 1;
            let bbox_rows = r1 - r0 + 1;
            let mut cell_flags = vec![CELL_OUTSIDE; bbox_cols * bbox_rows];

            // DDA-rasterize contour edges
            let pn = polygon.len();
            for i in 0..pn {
                let j = (i + 1) % pn;
                rasterize_edge_to_grid(
                    polygon[i][0],
                    polygon[i][1],
                    polygon[j][0],
                    polygon[j][1],
                    level_min_x + c0 as f64 * cell_w,
                    level_min_y + r0 as f64 * cell_h,
                    inv_cell_w,
                    inv_cell_h,
                    bbox_cols,
                    bbox_rows,
                    &mut cell_flags,
                );
            }

            // Classify cells
            let mut results = Vec::new();
            for lr in 0..bbox_rows {
                for lc in 0..bbox_cols {
                    let local_cell = lr * bbox_cols + lc;
                    let global_cell = (r0 + lr) * cols + (c0 + lc);
                    if cell_flags[local_cell] == CELL_BOUNDARY {
                        results.push(CellClassification {
                            cell: global_cell as u32,
                            is_inside: false,
                        });
                    } else {
                        let cx = level_min_x + ((c0 + lc) as f64 + 0.5) * cell_w;
                        let cy = level_min_y + ((r0 + lr) as f64 + 0.5) * cell_h;
                        if point_in_polygon(cx, cy, polygon) {
                            results.push(CellClassification {
                                cell: global_cell as u32,
                                is_inside: true,
                            });
                        }
                    }
                }
            }
            results
        })
        .collect();

    // Sequential merge: combine per-contour results into base + candidates
    let mut base_contour = vec![u32::MAX; num_cells];
    let mut base_depth = vec![0u32; num_cells];
    let mut all_candidates: Vec<Vec<u32>> = vec![Vec::new(); num_cells];

    for dfs_idx in 0..n {
        let orig = dfs_order[dfs_idx];
        let depth = tree.nodes[orig].depth;

        for r in &per_contour[dfs_idx] {
            let cell = r.cell as usize;
            if r.is_inside {
                if depth > base_depth[cell] || base_contour[cell] == u32::MAX {
                    base_contour[cell] = dfs_idx as u32;
                    base_depth[cell] = depth;
                }
            } else {
                all_candidates[cell].push(dfs_idx as u32);
            }
        }
    }

    // Flatten candidates: keep only P contours deeper than base, sorted deepest-first
    let mut cell_starts = Vec::with_capacity(num_cells + 1);
    let mut candidate_indices: Vec<u32> = Vec::new();
    cell_starts.push(0u32);

    for cell in 0..num_cells {
        let bd = base_depth[cell];
        let has_base = base_contour[cell] != u32::MAX;

        let mut candidates: Vec<(u32, u32)> = all_candidates[cell]
            .iter()
            .filter(|&&dfs_idx| {
                let orig = dfs_order[dfs_idx as usize];
                let d = tree.nodes[orig].depth;
                !has_base || d > bd
            })
            .map(|&dfs_idx| {
                let orig = dfs_order[dfs_idx as usize];
                (tree.nodes[orig].depth, dfs_idx)
            })
            .collect();
        candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(_, dfs_idx) in &candidates {
            candidate_indices.push(dfs_idx);
        }
        cell_starts.push(candidate_indices.len() as u32);
    }

    // Print stats
    // Compute per-cell candidate counts
    let candidate_counts: Vec<usize> = (0..num_cells)
        .map(|c| (cell_starts[c + 1] - cell_starts[c]) as usize)
        .collect();
    let cells_with_zero_candidates = candidate_counts.iter().filter(|&&c| c == 0).count();
    let cells_outside = base_contour.iter().filter(|&&b| b == u32::MAX).count();
    // "free" = zero-cost lookup (base only, no candidates to test)
    let cells_free = cells_with_zero_candidates;
    let max_candidates = candidate_counts.iter().copied().max().unwrap_or(0);

    // Sort for percentile computation (only among cells that have candidates)
    let mut nonzero_counts: Vec<usize> = candidate_counts.iter().copied().filter(|&c| c > 0).collect();
    nonzero_counts.sort_unstable();
    let avg_candidates_nonzero = if nonzero_counts.is_empty() {
        0.0
    } else {
        nonzero_counts.iter().sum::<usize>() as f64 / nonzero_counts.len() as f64
    };
    let p50 = nonzero_counts.get(nonzero_counts.len() / 2).copied().unwrap_or(0);
    let p95 = nonzero_counts.get((nonzero_counts.len() as f64 * 0.95) as usize).copied().unwrap_or(0);

    // Overall average across ALL cells (including zero-candidate cells)
    let avg_candidates_all = candidate_indices.len() as f64 / num_cells as f64;

    eprintln!("  Lookup grid stats:");
    eprintln!("    grid size:          {}×{} ({} cells)", cols, rows, num_cells);
    eprintln!(
        "    outside all:        {} ({:.1}%)",
        cells_outside,
        cells_outside as f64 / num_cells as f64 * 100.0
    );
    eprintln!(
        "    zero-cost (base):   {} ({:.1}%)",
        cells_free,
        cells_free as f64 / num_cells as f64 * 100.0
    );
    eprintln!(
        "    candidates/cell:    avg {:.2} (overall), avg {:.1} (boundary only), median {}, p95 {}, max {}",
        avg_candidates_all, avg_candidates_nonzero, p50, p95, max_candidates
    );
    let total_u32s =
        LOOKUP_GRID_HEADER + num_cells + (num_cells + 1) + candidate_indices.len();
    eprintln!(
        "    memory:             {} bytes ({:.1} KB)",
        total_u32s * 4,
        total_u32s as f64 * 4.0 / 1024.0
    );

    // Pack into GPU format
    let mut packed = Vec::with_capacity(total_u32s);

    // Header (6 u32s)
    packed.push(cols as u32);
    packed.push(rows as u32);
    packed.push((level_min_x as f32).to_bits());
    packed.push((level_min_y as f32).to_bits());
    packed.push((inv_cell_w as f32).to_bits());
    packed.push((inv_cell_h as f32).to_bits());

    // Base contour per cell
    packed.extend_from_slice(&base_contour);

    // Cell starts (prefix sum)
    packed.extend_from_slice(&cell_starts);

    // Candidate indices
    packed.extend_from_slice(&candidate_indices);

    packed
}

// CellClassification is used by both containment grid and lookup grid
struct CellClassification {
    cell: u32,
    is_inside: bool,
}

// ── Contour tree ─────────────────────────────────────────────────────────────

struct BBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

fn compute_bbox(points: &[[f64; 2]]) -> BBox {
    let mut b = BBox {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for p in points {
        if p[0] < b.min_x {
            b.min_x = p[0];
        }
        if p[0] > b.max_x {
            b.max_x = p[0];
        }
        if p[1] < b.min_y {
            b.min_y = p[1];
        }
        if p[1] > b.max_y {
            b.max_y = p[1];
        }
    }
    b
}

fn bbox_contains(outer: &BBox, inner: &BBox) -> bool {
    inner.min_x >= outer.min_x
        && inner.max_x <= outer.max_x
        && inner.min_y >= outer.min_y
        && inner.max_y <= outer.max_y
}

fn is_contour_inside(
    inner_poly: &[[f64; 2]],
    inner_bbox: &BBox,
    outer_poly: &[[f64; 2]],
    outer_bbox: &BBox,
) -> bool {
    if !bbox_contains(outer_bbox, inner_bbox) {
        return false;
    }
    if inner_poly.is_empty() {
        return false;
    }
    point_in_polygon(inner_poly[0][0], inner_poly[0][1], outer_poly)
}

struct ContourTreeNode {
    parent_index: i32,
    depth: u32,
    children: Vec<usize>,
}

struct ContourTree {
    nodes: Vec<ContourTreeNode>,
}

fn build_contour_tree(sampled: &[Vec<[f64; 2]>], bboxes: &[BBox]) -> ContourTree {
    let n = sampled.len();
    if n == 0 {
        return ContourTree { nodes: vec![] };
    }

    // Working tree: virtual root's children list
    let mut parent_of: Vec<Option<usize>> = vec![None; n]; // None = child of virtual root
    let mut children_of: Vec<Vec<usize>> = vec![vec![]; n + 1]; // index n = virtual root

    // Insert each contour incrementally
    for ci in 0..n {
        insert_contour(ci, n, sampled, bboxes, &mut parent_of, &mut children_of);
    }

    // Build final tree nodes
    let mut nodes: Vec<ContourTreeNode> = (0..n)
        .map(|_| ContourTreeNode {
            parent_index: -1,
            depth: 0,
            children: vec![],
        })
        .collect();

    for i in 0..n {
        if let Some(p) = parent_of[i] {
            nodes[i].parent_index = p as i32;
        }
        nodes[i].children = children_of[i].clone();
    }

    // Compute depths
    let roots: Vec<usize> = children_of[n].clone();
    let mut stack: Vec<(usize, u32)> = roots.iter().map(|&r| (r, 0u32)).collect();
    while let Some((idx, depth)) = stack.pop() {
        nodes[idx].depth = depth;
        for &child in &nodes[idx].children {
            stack.push((child, depth + 1));
        }
    }

    ContourTree { nodes }
}

fn insert_contour(
    ci: usize,
    virtual_root: usize,
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    parent_of: &mut [Option<usize>],
    children_of: &mut [Vec<usize>],
) {
    let parent = find_deepest_container(ci, virtual_root, sampled, bboxes, children_of);

    // Check if ci contains any existing children of parent → reparent them
    let existing_children: Vec<usize> = children_of[parent].clone();
    let mut children_to_reparent = vec![];
    for &existing in &existing_children {
        if is_contour_inside(
            &sampled[existing],
            &bboxes[existing],
            &sampled[ci],
            &bboxes[ci],
        ) {
            children_to_reparent.push(existing);
        }
    }

    for &child in &children_to_reparent {
        children_of[parent].retain(|&c| c != child);
        children_of[ci].push(child);
        parent_of[child] = Some(ci);
    }

    children_of[parent].push(ci);
    parent_of[ci] = if parent == virtual_root {
        None
    } else {
        Some(parent)
    };
}

fn find_deepest_container(
    ci: usize,
    current: usize,
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    children_of: &[Vec<usize>],
) -> usize {
    for &child in &children_of[current] {
        if is_contour_inside(&sampled[ci], &bboxes[ci], &sampled[child], &bboxes[child]) {
            return find_deepest_container(ci, child, sampled, bboxes, children_of);
        }
    }
    current
}

// ── Build terrain data ───────────────────────────────────────────────────────

/// Parse a level JSON string into a `LevelFileJSON`.
pub fn parse_level_file(json_str: &str) -> anyhow::Result<LevelFileJSON> {
    Ok(serde_json::from_str(json_str)?)
}

/// Build the binary terrain CPU data from a parsed level file, including contour
/// tree construction, DFS ordering, and flat vertex/children buffers.
pub fn build_terrain_data(level: &LevelFileJSON) -> TerrainCPUData {
    let def_depth = level.default_depth.unwrap_or(DEFAULT_DEPTH);
    let contours = &level.contours;

    let polygon_contours: Vec<PolygonContour> = contours
        .iter()
        .map(|c| {
            let pts: Vec<[f64; 2]> = if let Some(ref poly) = c.polygon {
                poly.clone()
            } else if let Some(ref cp) = c.control_points {
                let sps = adaptive_samples_per_segment(cp);
                sample_closed_spline(cp, sps)
            } else {
                vec![]
            };
            PolygonContour {
                height: c.height,
                polygon: pts,
            }
        })
        .collect();

    build_terrain_data_from_polygons(&polygon_contours, def_depth)
}

/// Build the binary terrain CPU data from pre-sampled polygon contours.
/// This is the core implementation used by both `build_terrain_data` (from JSON)
/// and `extract.rs` (from GIS pipeline).
pub fn build_terrain_data_from_polygons(
    contours: &[PolygonContour],
    default_depth: f64,
) -> TerrainCPUData {
    let n = contours.len();

    // Normalise winding to CCW
    let mut sampled: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n);
    for c in contours {
        let mut poly = c.polygon.clone();
        ensure_ccw(&mut poly);
        sampled.push(poly);
    }

    // Build bounding boxes
    let bboxes: Vec<BBox> = sampled.iter().map(|p| compute_bbox(p)).collect();

    // Build containment tree
    let tree = build_contour_tree(&sampled, &bboxes);

    // DFS ordering
    let mut dfs_order: Vec<usize> = Vec::with_capacity(n);
    let mut skip_counts = vec![0usize; n];
    let roots: Vec<usize> = (0..n).filter(|&i| tree.nodes[i].parent_index < 0).collect();

    fn dfs_visit(
        idx: usize,
        tree: &ContourTree,
        dfs_order: &mut Vec<usize>,
        skip_counts: &mut Vec<usize>,
    ) -> usize {
        let dfs_idx = dfs_order.len();
        dfs_order.push(idx);
        let mut sub = 0usize;
        for &child in &tree.nodes[idx].children {
            sub += 1 + dfs_visit(child, tree, dfs_order, skip_counts);
        }
        skip_counts[dfs_idx] = sub;
        sub
    }

    for &root in &roots {
        dfs_visit(root, &tree, &mut dfs_order, &mut skip_counts);
    }

    // Build original→dfs mapping
    let mut original_to_dfs = vec![0usize; n];
    for (dfs_idx, &orig) in dfs_order.iter().enumerate() {
        original_to_dfs[orig] = dfs_idx;
    }

    // Count vertices
    let total_verts: usize = sampled.iter().map(|p| p.len()).sum();
    let mut vertex_data = Vec::with_capacity(total_verts * 2);
    let mut contour_data = vec![0u8; n * FLOATS_PER_CONTOUR * 4];

    // Build flat children in DFS order
    let mut child_starts = Vec::with_capacity(n);
    let mut children_flat: Vec<u32> = Vec::new();
    for &orig in dfs_order.iter().take(n) {
        child_starts.push(children_flat.len());
        for &child_orig in &tree.nodes[orig].children {
            children_flat.push(original_to_dfs[child_orig] as u32);
        }
    }

    let mut vertex_index: usize = 0;

    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let vertices = &sampled[orig];
        let height = contours[orig].height;
        let depth = tree.nodes[orig].depth;
        let parent_dfs: i32 = if tree.nodes[orig].parent_index < 0 {
            -1
        } else {
            original_to_dfs[tree.nodes[orig].parent_index as usize] as i32
        };
        let child_count = tree.nodes[orig].children.len();
        let child_start = child_starts[dfs_idx];

        let byte_base = dfs_idx * FLOATS_PER_CONTOUR * 4;
        let cd = &mut contour_data[byte_base..byte_base + FLOATS_PER_CONTOUR * 4];

        // pointStartIndex (u32)
        cd[0..4].copy_from_slice(&(vertex_index as u32).to_le_bytes());
        // pointCount (u32)
        cd[4..8].copy_from_slice(&(vertices.len() as u32).to_le_bytes());
        // height (f32)
        cd[8..12].copy_from_slice(&(height as f32).to_le_bytes());
        // parentIndex (i32)
        cd[12..16].copy_from_slice(&parent_dfs.to_le_bytes());
        // depth (u32)
        cd[16..20].copy_from_slice(&depth.to_le_bytes());
        // childStartIndex (u32)
        cd[20..24].copy_from_slice(&(child_start as u32).to_le_bytes());
        // childCount (u32)
        cd[24..28].copy_from_slice(&(child_count as u32).to_le_bytes());
        // isCoastline (u32)
        let is_coast: u32 = if height == 0.0 { 1 } else { 0 };
        cd[28..32].copy_from_slice(&is_coast.to_le_bytes());

        // bbox
        let bb = &bboxes[orig];
        cd[32..36].copy_from_slice(&(bb.min_x as f32).to_le_bytes());
        cd[36..40].copy_from_slice(&(bb.min_y as f32).to_le_bytes());
        cd[40..44].copy_from_slice(&(bb.max_x as f32).to_le_bytes());
        cd[44..48].copy_from_slice(&(bb.max_y as f32).to_le_bytes());

        // skipCount (u32)
        cd[48..52].copy_from_slice(&(skip_counts[dfs_idx] as u32).to_le_bytes());

        // idwGridDataOffset (u32) — 0 initially, filled below
        cd[52..56].copy_from_slice(&0u32.to_le_bytes());

        // vertex data
        for pt in vertices {
            vertex_data.push(pt[0] as f32);
            vertex_data.push(pt[1] as f32);
            vertex_index += 1;
        }
    }

    // Build containment grids (256 u32 per contour, 2-bit packed)
    let mut containment_grid_data = vec![0u32; n * CONTAINMENT_GRID_U32S_PER_CONTOUR];
    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let vertices = &sampled[orig];
        if vertices.len() >= 3 {
            let packed = build_containment_grid_packed(vertices, &bboxes[orig]);
            let offset = dfs_idx * CONTAINMENT_GRID_U32S_PER_CONTOUR;
            containment_grid_data[offset..offset + CONTAINMENT_GRID_U32S_PER_CONTOUR]
                .copy_from_slice(&packed);
        }
    }

    // Build IDW grids for contours with children
    let mut idw_grid_parts: Vec<u32> = Vec::new();
    let mut idw_grid_count = 0usize;
    let mut idw_total_edges = 0usize;
    let mut idw_total_entries = 0usize;
    let mut idw_max_entries_per_cell = 0usize;
    let mut idw_cell_counts: Vec<usize> = Vec::new(); // entries-per-cell across all grids
    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let node = &tree.nodes[orig];
        if node.children.is_empty() || node.children.len() + 1 > MAX_IDW_CONTOURS {
            continue;
        }

        let parent_poly = &sampled[orig];
        let child_polys: Vec<&[[f64; 2]]> = node
            .children
            .iter()
            .map(|&child_orig| sampled[child_orig].as_slice())
            .collect();

        let (cell_starts, entries) =
            build_idw_grid_packed(parent_poly, &child_polys, &bboxes[orig]);

        // Collect stats
        let num_edges: usize =
            parent_poly.len() + child_polys.iter().map(|p| p.len()).sum::<usize>();
        idw_grid_count += 1;
        idw_total_edges += num_edges;
        idw_total_entries += entries.len();
        for i in 0..IDW_GRID_CELLS {
            let count = (cell_starts[i + 1] - cell_starts[i]) as usize;
            idw_cell_counts.push(count);
            if count > idw_max_entries_per_cell {
                idw_max_entries_per_cell = count;
            }
        }

        // Record relative offset + 1 (0 = no grid sentinel)
        let offset = idw_grid_parts.len();
        let byte_base = dfs_idx * FLOATS_PER_CONTOUR * 4;
        contour_data[byte_base + 52..byte_base + 56]
            .copy_from_slice(&((offset + 1) as u32).to_le_bytes());

        idw_grid_parts.extend_from_slice(&cell_starts);
        idw_grid_parts.extend_from_slice(&entries);
    }

    // Print IDW grid stats
    if idw_grid_count > 0 {
        let total_cells = idw_cell_counts.len();
        let avg_entries = idw_total_entries as f64 / total_cells as f64;
        let median_entries = {
            let mut sorted = idw_cell_counts.clone();
            sorted.sort_unstable();
            sorted[sorted.len() / 2]
        };
        let p95_entries = {
            let mut sorted = idw_cell_counts.clone();
            sorted.sort_unstable();
            sorted[(sorted.len() as f64 * 0.95) as usize]
        };
        let memory_bytes = idw_grid_parts.len() * 4;
        eprintln!("  IDW grid stats:");
        eprintln!("    grids:           {}", idw_grid_count);
        eprintln!("    total edges:     {}", idw_total_edges);
        eprintln!("    total entries:   {}", idw_total_entries);
        eprintln!(
            "    entries/cell:    avg {:.1}, median {}, p95 {}, max {}",
            avg_entries, median_entries, p95_entries, idw_max_entries_per_cell
        );
        eprintln!(
            "    memory:          {} bytes ({:.1} KB)",
            memory_bytes,
            memory_bytes as f64 / 1024.0
        );
    }

    // Build contour lookup grid for GPU
    let lookup_grid_data =
        build_lookup_grid_packed_gpu(&sampled, &bboxes, &dfs_order, &tree);

    TerrainCPUData {
        vertex_data,
        contour_data,
        children_data: children_flat,
        contour_count: n,
        default_depth,
        containment_grid_data,
        idw_grid_data: idw_grid_parts,
        lookup_grid_data,
    }
}

#[cfg(test)]
mod elevation_schedule_tests {
    use super::*;

    #[test]
    fn scalar_step_and_interp_are_constant() {
        let s = ElevationSchedule::scalar(7.5);
        assert_eq!(s.step_at(-100.0), 7.5);
        assert_eq!(s.step_at(0.0), 7.5);
        assert_eq!(s.step_at(500.0), 7.5);
        assert_eq!(s.interp_at(-100.0), 7.5);
        assert_eq!(s.interp_at(250.0), 7.5);
        assert!(s.is_scalar());
    }

    #[test]
    fn step_at_is_piecewise_constant() {
        let s = ElevationSchedule::from_breakpoints(vec![
            (-300.0, 50.0),
            (-50.0, 10.0),
            (0.0, 5.0),
            (25.0, 25.0),
        ])
        .unwrap();
        // Below the first breakpoint, clamp to first value.
        assert_eq!(s.step_at(-500.0), 50.0);
        assert_eq!(s.step_at(-300.0), 50.0);
        assert_eq!(s.step_at(-100.0), 50.0);
        // At -50, the -50 breakpoint kicks in.
        assert_eq!(s.step_at(-50.0), 10.0);
        assert_eq!(s.step_at(-10.0), 10.0);
        // At 0, the 0 breakpoint kicks in.
        assert_eq!(s.step_at(0.0), 5.0);
        assert_eq!(s.step_at(10.0), 5.0);
        // At 25, the 25 breakpoint kicks in.
        assert_eq!(s.step_at(25.0), 25.0);
        assert_eq!(s.step_at(1000.0), 25.0);
        assert!(!s.is_scalar());
    }

    #[test]
    fn interp_at_is_piecewise_linear_and_clamps() {
        let s = ElevationSchedule::from_breakpoints(vec![(0.0, 1.0), (100.0, 11.0)]).unwrap();
        assert!((s.interp_at(-50.0) - 1.0).abs() < 1e-9);
        assert!((s.interp_at(0.0) - 1.0).abs() < 1e-9);
        assert!((s.interp_at(50.0) - 6.0).abs() < 1e-9);
        assert!((s.interp_at(100.0) - 11.0).abs() < 1e-9);
        assert!((s.interp_at(500.0) - 11.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_empty_schedule() {
        let err = ElevationSchedule::from_breakpoints(vec![]);
        assert!(err.is_err());
    }

    #[test]
    fn rejects_non_monotonic_heights() {
        let err = ElevationSchedule::from_breakpoints(vec![(0.0, 5.0), (-10.0, 10.0)]);
        assert!(err.is_err());
    }

    #[test]
    fn rejects_non_positive_value() {
        let err = ElevationSchedule::from_breakpoints(vec![(0.0, 0.0), (10.0, 5.0)]);
        assert!(err.is_err());
        let err = ElevationSchedule::from_breakpoints(vec![(0.0, -5.0)]);
        assert!(err.is_err());
    }

    #[test]
    fn deserializes_scalar() {
        let s: ElevationSchedule = serde_json::from_str("25").unwrap();
        assert!(s.is_scalar());
        assert_eq!(s.step_at(100.0), 25.0);
    }

    #[test]
    fn deserializes_schedule_array() {
        let json = "[[-50, 10], [0, 5], [25, 25]]";
        let s: ElevationSchedule = serde_json::from_str(json).unwrap();
        assert!(!s.is_scalar());
        assert_eq!(s.step_at(-25.0), 10.0);
        assert_eq!(s.step_at(5.0), 5.0);
        assert_eq!(s.step_at(100.0), 25.0);
    }

    #[test]
    fn deserializes_region_config_with_schedule() {
        let json = r#"{
            "bbox": {"minLat": 0, "minLon": 0, "maxLat": 1, "maxLon": 1},
            "interval": [[-300, 50], [0, 5]],
            "simplify": 3,
            "scale": 1,
            "minPerimeter": 1000,
            "minPoints": 3,
            "flipY": true
        }"#;
        let rc: RegionConfig = serde_json::from_str(json).unwrap();
        assert!(!rc.interval.is_scalar());
        assert!(rc.simplify.is_scalar());
        assert_eq!(rc.simplify.interp_at(0.0), 3.0);
    }
}
