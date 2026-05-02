//! `ParsedContour` data structure and `parse_contours` — extracts contour
//! metadata from the binary buffer and builds per-contour spatial grids
//! plus the level-wide contour lookup grid.

use crate::level::{TerrainCPUData, FLOATS_PER_CONTOUR};

use super::idw_grid::IDWGrid;
use super::lookup_grid::{build_contour_lookup_grid, ContourLookupGrid};
use super::spatial::{ContainmentGrid, EdgeGrid, EDGE_GRID_THRESHOLD};

/// A contour parsed from the binary contour data buffer.
pub struct ParsedContour {
    pub point_start: usize,
    pub point_count: usize,
    pub height: f32,
    pub depth: u32,
    pub skip_count: u32,
    pub child_start: usize,
    pub child_count: usize,
    pub bbox_min_x: f32,
    pub bbox_min_y: f32,
    pub bbox_max_x: f32,
    pub bbox_max_y: f32,
    /// Spatial grid for fast nearest-edge queries. `None` for small contours.
    pub edge_grid: Option<EdgeGrid>,
    /// Containment grid for O(1) point-in-contour tests. Built for all contours.
    pub containment_grid: ContainmentGrid,
    /// Precomputed IDW candidate grid. Built for contours with children.
    pub idw_grid: Option<IDWGrid>,
}

/// Extract all contour metadata from the binary contour data buffer and build
/// the level-wide contour lookup grid. All phases are parallelized with rayon.
pub fn parse_contours(terrain: &TerrainCPUData) -> (Vec<ParsedContour>, ContourLookupGrid) {
    use rayon::prelude::*;

    let n = terrain.contour_count;
    let cd = &terrain.contour_data;
    let vd = &terrain.vertex_data;

    // Phase 1: Parse contours and build per-contour grids in parallel
    let mut contours: Vec<ParsedContour> = (0..n)
        .into_par_iter()
        .map(|i| {
            let base = i * FLOATS_PER_CONTOUR * 4;
            let b = &cd[base..base + FLOATS_PER_CONTOUR * 4];
            let point_start = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
            let point_count = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize;
            let mut c = ParsedContour {
                point_start,
                point_count,
                height: f32::from_le_bytes([b[8], b[9], b[10], b[11]]),
                depth: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
                skip_count: u32::from_le_bytes([b[48], b[49], b[50], b[51]]),
                child_start: u32::from_le_bytes([b[20], b[21], b[22], b[23]]) as usize,
                child_count: u32::from_le_bytes([b[24], b[25], b[26], b[27]]) as usize,
                bbox_min_x: f32::from_le_bytes([b[32], b[33], b[34], b[35]]),
                bbox_min_y: f32::from_le_bytes([b[36], b[37], b[38], b[39]]),
                bbox_max_x: f32::from_le_bytes([b[40], b[41], b[42], b[43]]),
                bbox_max_y: f32::from_le_bytes([b[44], b[45], b[46], b[47]]),
                edge_grid: None,
                containment_grid: ContainmentGrid::empty(),
                idw_grid: None,
            };
            c.containment_grid = ContainmentGrid::build(&c, vd);
            if point_count >= EDGE_GRID_THRESHOLD {
                c.edge_grid = Some(EdgeGrid::build(&c, vd));
            }
            c
        })
        .collect();
    // Phase 2: Build IDW grids in parallel (reads shared contours, each writes its own grid)
    let children_data = &terrain.children_data;
    let idw_grids: Vec<Option<IDWGrid>> = (0..n)
        .into_par_iter()
        .map(|i| {
            if contours[i].child_count > 0 {
                Some(IDWGrid::build(
                    &contours[i],
                    i,
                    &contours,
                    children_data,
                    vd,
                ))
            } else {
                None
            }
        })
        .collect();
    for (i, grid) in idw_grids.into_iter().enumerate() {
        if let Some(g) = grid {
            contours[i].idw_grid = Some(g);
        }
    }

    // Phase 3: Build level-wide lookup grid (contour classification parallelized)
    let lookup_grid = build_contour_lookup_grid(&contours, vd, terrain.default_depth);

    (contours, lookup_grid)
}
