//! JSON level file parsing, Catmull-Rom spline sampling, contour tree building,
//! and terrain CPU data construction. Mirrors LevelFileFormat.ts + LandMass.ts.

mod binary;
mod build;
mod format;
mod grid_builders;
mod parse;

pub use binary::{read_terrain_binary, write_terrain_binary};
pub use build::{build_terrain_data, build_terrain_data_from_polygons};
pub use format::{
    default_wave_sources, default_wind_sources, BiomeConfigJSON, BiomeZoneJSON, BoundingBox,
    DataSourceConfig, ElevationSchedule, LevelFileJSON, PolygonContour, RegionConfig,
    TerrainCPUData, TerrainContourJSON, TerrainFileJSON, TreeConfigJSON, WaveConfigJSON,
    WaveSource, WaveSourceJSON, WindConfigJSON, WindSource, WindSourceJSON,
    CONTAINMENT_GRID_SIZE, FLOATS_PER_CONTOUR,
};
pub use parse::{parse_level_file, parse_terrain_file, resolve_level_terrain, resolve_terrain_path};
