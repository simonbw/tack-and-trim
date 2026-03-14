//! Tree placement generation and binary .trees file writing.
//!
//! Algorithm:
//! 1. Build a coarse elevation raster from terrain height queries (parallel).
//! 2. Run Poisson disk sampling (Bridson's algorithm) with land-aware rejection
//!    so the algorithm never explores ocean regions.
//! 3. Filter surviving candidates by elevation acceptance curve and density.

use crate::level::{TerrainCPUData, TreeConfigJSON};
use crate::terrain::{compute_terrain_height, parse_contours, ParsedContour};

// ── Default configuration ───────────────────────────────────────────────────

const DEFAULT_SPACING: f64 = 40.0; // feet between trees
const DEFAULT_DENSITY: f64 = 0.7; // fraction of valid positions kept
const DEFAULT_MIN_ELEVATION: f64 = 5.0; // feet
const DEFAULT_MAX_ELEVATION: f64 = 500.0; // feet

/// Resolved tree generation config with defaults applied.
pub struct TreeConfig {
    pub spacing: f64,
    pub density: f64,
    pub min_elevation: f64,
    pub max_elevation: f64,
}

impl TreeConfig {
    pub fn from_json(json: Option<&TreeConfigJSON>) -> Self {
        match json {
            Some(j) => Self {
                spacing: j.spacing.unwrap_or(DEFAULT_SPACING),
                density: j.density.unwrap_or(DEFAULT_DENSITY).clamp(0.0, 1.0),
                min_elevation: j.min_elevation.unwrap_or(DEFAULT_MIN_ELEVATION),
                max_elevation: j.max_elevation.unwrap_or(DEFAULT_MAX_ELEVATION),
            },
            None => Self {
                spacing: DEFAULT_SPACING,
                density: DEFAULT_DENSITY,
                min_elevation: DEFAULT_MIN_ELEVATION,
                max_elevation: DEFAULT_MAX_ELEVATION,
            },
        }
    }
}

// ── Output ──────────────────────────────────────────────────────────────────

pub struct TreeData {
    /// Flat list of (x, y) positions in world feet.
    pub positions: Vec<[f32; 2]>,
}

// ── Binary file format ─────────────────────────────────────────────────────

const MAGIC: u32 = 0x45455254; // "TREE" little-endian
const VERSION: u16 = 1;
const HEADER_BYTES: usize = 16;
const BYTES_PER_TREE: usize = 8;

/// Serialize tree positions into the binary `.trees` format.
pub fn build_tree_buffer(data: &TreeData) -> Vec<u8> {
    let tree_count = data.positions.len();
    let total_size = HEADER_BYTES + tree_count * BYTES_PER_TREE;
    let mut buf = vec![0u8; total_size];

    // Header (16 bytes)
    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    // [6..8] reserved = 0
    buf[8..12].copy_from_slice(&(tree_count as u32).to_le_bytes());
    // [12..16] reserved = 0

    // Tree data (8 bytes per tree)
    for (i, pos) in data.positions.iter().enumerate() {
        let offset = HEADER_BYTES + i * BYTES_PER_TREE;
        buf[offset..offset + 4].copy_from_slice(&pos[0].to_le_bytes());
        buf[offset + 4..offset + 8].copy_from_slice(&pos[1].to_le_bytes());
    }

    buf
}

// ── Simple PCG-style PRNG ───────────────────────────────────────────────────

struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: u64) -> Self {
        Self {
            state: seed.wrapping_add(0x9E3779B97F4A7C15),
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let mut x = self.state;
        x ^= x >> 30;
        x = x.wrapping_mul(0xBF58476D1CE4E5B9);
        x ^= x >> 27;
        x = x.wrapping_mul(0x94D049BB133111EB);
        x ^= x >> 31;
        x
    }

    /// Returns a value in [0.0, 1.0).
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

// ── Coarse elevation raster ────────────────────────────────────────────────

/// Multiplier for raster cell size relative to tree spacing.
const RASTER_SCALE: f64 = 5.0;

/// Coarse elevation grid used to cheaply skip ocean regions and look up
/// approximate terrain height without expensive per-point DFS queries.
struct ElevationRaster {
    heights: Vec<f64>,
    /// Dilated land mask: true if this cell or any neighbor has land.
    land_mask: Vec<bool>,
    grid_w: usize,
    grid_h: usize,
    cell_size: f64,
}

impl ElevationRaster {
    /// Build by sampling terrain height at the center of each coarse cell.
    /// Rows are computed in parallel with rayon — each row's output depends
    /// only on its coordinates and the (read-only) terrain data, so the
    /// result is fully deterministic regardless of thread scheduling.
    fn build(
        width: f64,
        height: f64,
        min_x: f64,
        min_y: f64,
        cell_size: f64,
        terrain: &TerrainCPUData,
        contours: &[ParsedContour],
        min_elev: f64,
        max_elev: f64,
    ) -> Self {
        use rayon::prelude::*;

        let grid_w = (width / cell_size).ceil() as usize + 1;
        let grid_h = (height / cell_size).ceil() as usize + 1;

        // Compute heights in parallel, one row at a time.
        let heights: Vec<f64> = (0..grid_h)
            .into_par_iter()
            .flat_map_iter(|cy| {
                (0..grid_w).map(move |cx| {
                    let wx = min_x + (cx as f64 + 0.5) * cell_size;
                    let wy = min_y + (cy as f64 + 0.5) * cell_size;
                    compute_terrain_height(wx, wy, terrain, contours)
                })
            })
            .collect();

        // Build dilated land mask: mark cell + neighbors if any cell has land.
        let n = grid_w * grid_h;
        let mut land_mask = vec![false; n];
        for cy in 0..grid_h {
            for cx in 0..grid_w {
                let h = heights[cy * grid_w + cx];
                if h >= min_elev && h <= max_elev {
                    let y0 = cy.saturating_sub(1);
                    let y1 = (cy + 2).min(grid_h);
                    let x0 = cx.saturating_sub(1);
                    let x1 = (cx + 2).min(grid_w);
                    for ny in y0..y1 {
                        for nx in x0..x1 {
                            land_mask[ny * grid_w + nx] = true;
                        }
                    }
                }
            }
        }

        Self {
            heights,
            land_mask,
            grid_w,
            grid_h,
            cell_size,
        }
    }

    /// Look up approximate height via bilinear interpolation of the coarse grid.
    /// Coordinates are in local space (relative to AABB origin).
    fn sample(&self, x: f64, y: f64) -> f64 {
        let gx = (x / self.cell_size) - 0.5;
        let gy = (y / self.cell_size) - 0.5;

        let x0 = (gx.floor() as isize).max(0) as usize;
        let y0 = (gy.floor() as isize).max(0) as usize;
        let x1 = (x0 + 1).min(self.grid_w - 1);
        let y1 = (y0 + 1).min(self.grid_h - 1);

        let fx = (gx - x0 as f64).clamp(0.0, 1.0);
        let fy = (gy - y0 as f64).clamp(0.0, 1.0);

        let h00 = self.heights[y0 * self.grid_w + x0];
        let h10 = self.heights[y0 * self.grid_w + x1];
        let h01 = self.heights[y1 * self.grid_w + x0];
        let h11 = self.heights[y1 * self.grid_w + x1];

        let h0 = h00 + (h10 - h00) * fx;
        let h1 = h01 + (h11 - h01) * fx;
        h0 + (h1 - h0) * fy
    }

    /// Quick check: is this point near land?
    fn is_near_land(&self, x: f64, y: f64) -> bool {
        let cx = (x / self.cell_size) as usize;
        let cy = (y / self.cell_size) as usize;
        let cx = cx.min(self.grid_w - 1);
        let cy = cy.min(self.grid_h - 1);
        self.land_mask[cy * self.grid_w + cx]
    }
}

// ── Land-aware Poisson disk sampling ────────────────────────────────────────

/// Maximum candidates to try around each active point before giving up.
const BRIDSON_K: usize = 30;

/// Sentinel value for empty cells in the Poisson disk grid.
const EMPTY: u32 = u32::MAX;

/// Bridson's algorithm with land-aware rejection. Candidates in ocean cells are
/// rejected before becoming active, so the algorithm never explores ocean
/// regions.
///
/// Uses a dense `Vec<u32>` grid for O(1) neighbor lookups (vs ~50-100ns per
/// HashMap lookup). Seeds from all land cells in the raster so multi-island
/// maps are fully populated.
fn poisson_disk_sample_on_land(
    width: f64,
    height: f64,
    r: f64,
    raster: &ElevationRaster,
    rng: &mut Rng,
) -> Vec<[f64; 2]> {
    let cell_size = r / std::f64::consts::SQRT_2;
    let grid_w = (width / cell_size).ceil() as usize + 1;
    let grid_h = (height / cell_size).ceil() as usize + 1;

    let r_sq = r * r;

    // Dense grid storing point index per cell (EMPTY = unoccupied).
    let mut grid = vec![EMPTY; grid_w * grid_h];
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut active: Vec<u32> = Vec::new();

    let to_grid = |x: f64, y: f64| -> (usize, usize) {
        let gx = (x / cell_size) as usize;
        let gy = (y / cell_size) as usize;
        (gx.min(grid_w - 1), gy.min(grid_h - 1))
    };

    // Try to insert a seed point. Returns true if placed (no conflict).
    let try_seed = |x: f64,
                    y: f64,
                    grid: &mut [u32],
                    points: &mut Vec<[f64; 2]>,
                    active: &mut Vec<u32>|
     -> bool {
        let (gx, gy) = to_grid(x, y);
        let gi = gy * grid_w + gx;
        if grid[gi] != EMPTY {
            return false;
        }
        // Check neighbors for distance conflicts.
        let g_min_x = gx.saturating_sub(2);
        let g_min_y = gy.saturating_sub(2);
        let g_max_x = (gx + 3).min(grid_w);
        let g_max_y = (gy + 3).min(grid_h);
        for ny in g_min_y..g_max_y {
            for nx in g_min_x..g_max_x {
                let ni = grid[ny * grid_w + nx];
                if ni != EMPTY {
                    let dx = points[ni as usize][0] - x;
                    let dy = points[ni as usize][1] - y;
                    if dx * dx + dy * dy < r_sq {
                        return false;
                    }
                }
            }
        }
        let idx = points.len() as u32;
        grid[gi] = idx;
        points.push([x, y]);
        active.push(idx);
        true
    };

    // Seed from every land cell in the raster (center of cell).
    // This ensures all disconnected land masses get populated.
    // The Poisson disk conflict check prevents over-seeding.
    for cy in 0..raster.grid_h {
        for cx in 0..raster.grid_w {
            if !raster.land_mask[cy * raster.grid_w + cx] {
                continue;
            }
            let x = (cx as f64 + 0.5) * raster.cell_size;
            let y = (cy as f64 + 0.5) * raster.cell_size;
            if x >= width || y >= height {
                continue;
            }
            try_seed(x, y, &mut grid, &mut points, &mut active);
        }
    }

    if points.is_empty() {
        return Vec::new();
    }

    // Standard Bridson expansion from all seeded points.
    while !active.is_empty() {
        let active_idx = (rng.next_u64() as usize) % active.len();
        let point_idx = active[active_idx] as usize;
        let px = points[point_idx][0];
        let py = points[point_idx][1];

        let mut found = false;
        for _ in 0..BRIDSON_K {
            let angle = rng.next_f64() * std::f64::consts::TAU;
            let dist = r + rng.next_f64() * r;
            let cx = px + angle.cos() * dist;
            let cy = py + angle.sin() * dist;

            // Bounds check.
            if cx < 0.0 || cx >= width || cy < 0.0 || cy >= height {
                continue;
            }

            // Land check: skip candidates in ocean cells.
            if !raster.is_near_land(cx, cy) {
                continue;
            }

            let (gx, gy) = to_grid(cx, cy);
            let gi = gy * grid_w + gx;

            // Quick check: cell already occupied.
            if grid[gi] != EMPTY {
                continue;
            }

            // Check neighbors in a 5x5 grid around the candidate.
            let mut too_close = false;
            let g_min_x = gx.saturating_sub(2);
            let g_min_y = gy.saturating_sub(2);
            let g_max_x = (gx + 3).min(grid_w);
            let g_max_y = (gy + 3).min(grid_h);

            'neighbor: for ny in g_min_y..g_max_y {
                for nx in g_min_x..g_max_x {
                    let ni = grid[ny * grid_w + nx];
                    if ni != EMPTY {
                        let dx = points[ni as usize][0] - cx;
                        let dy = points[ni as usize][1] - cy;
                        if dx * dx + dy * dy < r_sq {
                            too_close = true;
                            break 'neighbor;
                        }
                    }
                }
            }

            if !too_close {
                let new_idx = points.len() as u32;
                grid[gi] = new_idx;
                points.push([cx, cy]);
                active.push(new_idx);
                found = true;
                break;
            }
        }

        if !found {
            active.swap_remove(active_idx);
        }
    }

    points
}

// ── Elevation acceptance curve ──────────────────────────────────────────────

/// Returns a probability [0, 1] for accepting a tree at a given elevation.
/// Smoothly ramps up from 0 at min_elevation, full density in the mid range,
/// and fades out approaching max_elevation.
fn elevation_acceptance(h: f64, min_elev: f64, max_elev: f64) -> f64 {
    if h < min_elev || h > max_elev {
        return 0.0;
    }

    let range = max_elev - min_elev;
    if range <= 0.0 {
        return 0.0;
    }

    // Shore ramp: 0 → 1 over the first 10% of elevation range.
    let shore_band = (range * 0.1).max(5.0);
    let shore_factor = ((h - min_elev) / shore_band).min(1.0);

    // Treeline fade: 1 → 0 over the last 20% of elevation range.
    let treeline_band = (range * 0.2).max(10.0);
    let treeline_factor = ((max_elev - h) / treeline_band).min(1.0);

    // Smooth (cubic ease) both ramps for natural-looking transitions.
    let s = shore_factor * shore_factor * (3.0 - 2.0 * shore_factor);
    let t = treeline_factor * treeline_factor * (3.0 - 2.0 * treeline_factor);

    s * t
}

// ── Generation ─────────────────────────────────────────────────────────────

/// Generate tree positions using Poisson disk sampling with elevation filtering.
pub fn generate_trees(terrain: &TerrainCPUData, config: &TreeConfig, seed: u64) -> TreeData {
    let (contours, _lookup_grid) = parse_contours(terrain);

    // Compute terrain AABB.
    let vert_count = terrain.vertex_data.len() / 2;
    if vert_count == 0 {
        return TreeData {
            positions: Vec::new(),
        };
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for i in 0..vert_count {
        let x = terrain.vertex_data[i * 2] as f64;
        let y = terrain.vertex_data[i * 2 + 1] as f64;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    let width = max_x - min_x;
    let height = max_y - min_y;

    if width <= 0.0 || height <= 0.0 {
        return TreeData {
            positions: Vec::new(),
        };
    }

    let mut rng = Rng::new(seed);

    // Step 1: Build coarse elevation raster for fast land checks + height lookups.
    // This is the most parallelizable step — each cell is an independent terrain
    // height query, and the results are deterministic regardless of thread order.
    let raster_cell = config.spacing * RASTER_SCALE;
    let raster = ElevationRaster::build(
        width,
        height,
        min_x,
        min_y,
        raster_cell,
        terrain,
        &contours,
        config.min_elevation,
        config.max_elevation,
    );

    // Step 2: Poisson disk sampling, constrained to land regions only.
    // Sequential but fast thanks to dense u32 grid for O(1) neighbor lookups.
    let candidates = poisson_disk_sample_on_land(width, height, config.spacing, &raster, &mut rng);

    // Step 3: Filter by elevation acceptance curve and density thinning.
    let mut positions = Vec::with_capacity(candidates.len() / 2);

    for [cx, cy] in &candidates {
        // Approximate elevation from bilinear interpolation of coarse raster.
        let h = raster.sample(*cx, *cy);

        // Elevation acceptance (smooth ramp at edges of band).
        let accept = elevation_acceptance(h, config.min_elevation, config.max_elevation);
        if accept <= 0.0 {
            continue;
        }

        // Density thinning: combine elevation acceptance with user density.
        let threshold = accept * config.density;
        if rng.next_f64() >= threshold {
            continue;
        }

        let world_x = min_x + cx;
        let world_y = min_y + cy;
        positions.push([world_x as f32, world_y as f32]);
    }

    TreeData { positions }
}
