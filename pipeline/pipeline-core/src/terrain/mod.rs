//! CPU terrain height queries — contour tree DFS, winding number, IDW.
//! Mirrors terrainHeightCPU.ts.

mod contour;
mod distance;
mod idw_grid;
mod lookup_grid;
mod query;
mod spatial;

pub use contour::{parse_contours, ParsedContour};
pub use idw_grid::IDWGrid;
pub use lookup_grid::ContourLookupGrid;
pub use query::{
    compute_terrain_height, compute_terrain_height_and_gradient,
    compute_terrain_height_and_gradient_ex, TerrainHeightGradient,
};
pub use spatial::{ContainmentGrid, EdgeGrid};
