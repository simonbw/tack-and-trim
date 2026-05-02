//! Pure data definitions for the `.level.json` and `.terrain` formats.
//! Mirrors LevelFileFormat.ts.

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

// ── Wave source types ────────────────────────────────────────────────────────

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

pub(super) const DEFAULT_DEPTH: f64 = -300.0;

/// Number of 32-bit values per contour in the binary contour data buffer.
pub const FLOATS_PER_CONTOUR: usize = 14;

// Grid constants matching TypeScript TerrainConstants.ts
pub const CONTAINMENT_GRID_SIZE: usize = 64;

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
