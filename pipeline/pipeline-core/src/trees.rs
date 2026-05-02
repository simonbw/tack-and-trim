//! Tree placement generation and binary .trees file writing.
//!
//! Algorithm:
//! 1. Build a coarse elevation raster from terrain height queries (parallel).
//! 2. Flood-fill the land mask to find connected land regions (islands).
//! 3. Run Poisson disk sampling (Bridson's algorithm) per-island in parallel.
//! 4. Filter surviving candidates by elevation acceptance curve and density.

use crate::level::{BiomeConfigJSON, TerrainCPUData, TreeConfigJSON};
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

// ── Biome-aware tree zones ────────────────────────────────────────────────

/// A resolved biome zone with its tree density.
pub struct TreeZone {
    pub max_height: f64,
    pub density: f64,
}

/// Optional biome-aware tree configuration. When present, replaces the
/// hardcoded elevation_acceptance curve with per-zone density values.
pub struct BiomeTreeZones {
    pub zones: Vec<TreeZone>,
}

impl BiomeTreeZones {
    /// Build from biome config. Returns `None` if no zones have `treeDensity`
    /// set, which preserves the old elevation acceptance behavior.
    pub fn from_biome(biome: &BiomeConfigJSON, default_density: f64) -> Option<Self> {
        let has_any = biome.zones.iter().any(|z| z.tree_density.is_some());
        if !has_any {
            return None;
        }

        let zones = biome
            .zones
            .iter()
            .map(|z| TreeZone {
                max_height: z.max_height,
                density: z.tree_density.unwrap_or(default_density).clamp(0.0, 1.0),
            })
            .collect();

        Some(Self { zones })
    }
}

fn smoothstep(t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Look up the effective tree density at a given elevation using biome zones.
/// Returns a value in [0, 1] suitable for direct use as a keep threshold.
///
/// Applies smooth blending at zone boundaries and a shore ramp near min_elev.
fn biome_density_at_height(
    h: f64,
    zones: &BiomeTreeZones,
    min_elev: f64,
    max_elev: f64,
) -> f64 {
    if h < min_elev || h > max_elev || zones.zones.is_empty() {
        return 0.0;
    }

    // Find the zone containing this height and get its density.
    // Zones are sorted by max_height. The zone for height h is the first
    // zone where h <= max_height.
    let mut zone_idx = 0;
    for (i, zone) in zones.zones.iter().enumerate() {
        if h <= zone.max_height {
            zone_idx = i;
            break;
        }
        // If h is above all zones, use the last zone.
        zone_idx = i;
    }

    let zone = &zones.zones[zone_idx];
    let zone_density = zone.density;

    // Determine the lower boundary of this zone.
    let zone_lo = if zone_idx == 0 {
        min_elev
    } else {
        zones.zones[zone_idx - 1].max_height
    };
    let zone_hi = zone.max_height;
    let zone_range = zone_hi - zone_lo;

    // Blend with adjacent zones at boundaries.
    let blend_band = (zone_range * 0.15).min(15.0).max(2.0);
    let mut density = zone_density;

    // Blend with previous zone near the lower boundary.
    if zone_idx > 0 {
        let dist_from_lo = h - zone_lo;
        if dist_from_lo < blend_band {
            let prev_density = zones.zones[zone_idx - 1].density;
            let t = smoothstep(dist_from_lo / blend_band);
            density = prev_density + (zone_density - prev_density) * t;
        }
    }

    // Blend with next zone near the upper boundary.
    if zone_idx + 1 < zones.zones.len() {
        let dist_from_hi = zone_hi - h;
        if dist_from_hi < blend_band {
            let next_density = zones.zones[zone_idx + 1].density;
            let t = smoothstep(dist_from_hi / blend_band);
            density = next_density + (density - next_density) * t;
        }
    }

    // Shore ramp: smooth fade-in near min_elev so trees don't start abruptly
    // at the water line.
    let shore_band = 5.0_f64.max((max_elev - min_elev) * 0.02);
    let shore_factor = smoothstep((h - min_elev) / shore_band);
    density *= shore_factor;

    density
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

    buf[0..4].copy_from_slice(&MAGIC.to_le_bytes());
    buf[4..6].copy_from_slice(&VERSION.to_le_bytes());
    buf[8..12].copy_from_slice(&(tree_count as u32).to_le_bytes());

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
    /// Rows are computed in parallel with rayon.
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

        // Build dilated land mask.
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

// ── Connected land region detection ─────────────────────────────────────────

/// A connected land region (island) found by flood-filling the land mask.
struct LandRegion {
    /// Bounding box in raster cell coordinates.
    min_cx: usize,
    min_cy: usize,
    max_cx: usize,
    max_cy: usize,
    /// Raster cells belonging to this region (stored as (cx, cy) pairs).
    cells: Vec<(usize, usize)>,
}

/// Flood-fill the land mask to find connected land regions.
/// Uses 4-connectivity (not diagonal) so narrow diagonal channels separate islands.
fn find_land_regions(raster: &ElevationRaster) -> Vec<LandRegion> {
    let n = raster.grid_w * raster.grid_h;
    let mut visited = vec![false; n];
    let mut regions = Vec::new();

    for start_y in 0..raster.grid_h {
        for start_x in 0..raster.grid_w {
            let si = start_y * raster.grid_w + start_x;
            if visited[si] || !raster.land_mask[si] {
                continue;
            }

            // BFS flood fill from this cell.
            let mut region = LandRegion {
                min_cx: start_x,
                min_cy: start_y,
                max_cx: start_x,
                max_cy: start_y,
                cells: Vec::new(),
            };

            let mut queue = vec![(start_x, start_y)];
            visited[si] = true;

            while let Some((cx, cy)) = queue.pop() {
                region.cells.push((cx, cy));
                region.min_cx = region.min_cx.min(cx);
                region.min_cy = region.min_cy.min(cy);
                region.max_cx = region.max_cx.max(cx);
                region.max_cy = region.max_cy.max(cy);

                // 4-connected neighbors.
                for (dx, dy) in [(-1i32, 0), (1, 0), (0, -1i32), (0, 1)] {
                    let nx = cx as i32 + dx;
                    let ny = cy as i32 + dy;
                    if nx < 0
                        || ny < 0
                        || nx >= raster.grid_w as i32
                        || ny >= raster.grid_h as i32
                    {
                        continue;
                    }
                    let nx = nx as usize;
                    let ny = ny as usize;
                    let ni = ny * raster.grid_w + nx;
                    if !visited[ni] && raster.land_mask[ni] {
                        visited[ni] = true;
                        queue.push((nx, ny));
                    }
                }
            }

            regions.push(region);
        }
    }

    // Sort by (min_cy, min_cx) for deterministic ordering.
    regions.sort_by_key(|r| (r.min_cy, r.min_cx));
    regions
}

// ── Per-island Poisson disk sampling ────────────────────────────────────────

/// Maximum candidates to try around each active point before giving up.
const BRIDSON_K: usize = 30;

/// Sentinel value for empty cells in the Poisson disk grid.
const EMPTY: u32 = u32::MAX;

/// Run Bridson's algorithm on a single land region. The grid is sized to the
/// region's bounding box. Seeds from the region's land cells and only accepts
/// candidates that fall in land cells.
///
/// Coordinates are in the global AABB local space (relative to terrain min).
fn poisson_disk_for_region(
    region: &LandRegion,
    r: f64,
    raster: &ElevationRaster,
    rng: &mut Rng,
    aabb_width: f64,
    aabb_height: f64,
) -> Vec<[f64; 2]> {
    let cell_size = r / std::f64::consts::SQRT_2;
    let r_sq = r * r;

    // Region bounding box in world-local coordinates, with padding for Bridson
    // annulus (2r) so expansion can reach the edges.
    let pad = 2.0 * r;
    let region_x0 = (region.min_cx as f64 * raster.cell_size - pad).max(0.0);
    let region_y0 = (region.min_cy as f64 * raster.cell_size - pad).max(0.0);
    let region_x1 = ((region.max_cx + 1) as f64 * raster.cell_size + pad).min(aabb_width);
    let region_y1 = ((region.max_cy + 1) as f64 * raster.cell_size + pad).min(aabb_height);
    let region_w = region_x1 - region_x0;
    let region_h = region_y1 - region_y0;

    if region_w <= 0.0 || region_h <= 0.0 {
        return Vec::new();
    }

    // Grid sized to region bounding box only.
    let grid_w = (region_w / cell_size).ceil() as usize + 1;
    let grid_h = (region_h / cell_size).ceil() as usize + 1;

    let mut grid = vec![EMPTY; grid_w * grid_h];
    let mut points: Vec<[f64; 2]> = Vec::new();
    let mut active: Vec<u32> = Vec::new();

    // Convert global coordinates to region-local grid coordinates.
    let to_grid = |x: f64, y: f64| -> (usize, usize) {
        let gx = ((x - region_x0) / cell_size) as usize;
        let gy = ((y - region_y0) / cell_size) as usize;
        (gx.min(grid_w - 1), gy.min(grid_h - 1))
    };

    // Try to insert a seed point at global coordinates.
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

    // Seed from this region's land cells.
    for &(cx, cy) in &region.cells {
        let x = (cx as f64 + 0.5) * raster.cell_size;
        let y = (cy as f64 + 0.5) * raster.cell_size;
        if x >= aabb_width || y >= aabb_height {
            continue;
        }
        try_seed(x, y, &mut grid, &mut points, &mut active);
    }

    if points.is_empty() {
        return Vec::new();
    }

    // Bridson expansion.
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

            // Global bounds check.
            if cx < region_x0 || cx >= region_x1 || cy < region_y0 || cy >= region_y1 {
                continue;
            }

            // Land check.
            if !raster.is_near_land(cx, cy) {
                continue;
            }

            let (gx, gy) = to_grid(cx, cy);
            let gi = gy * grid_w + gx;

            if grid[gi] != EMPTY {
                continue;
            }

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
/// Islands are detected via flood-fill and processed in parallel.
pub fn generate_trees(
    terrain: &TerrainCPUData,
    config: &TreeConfig,
    biome_zones: Option<&BiomeTreeZones>,
    seed: u64,
) -> TreeData {
    use rayon::prelude::*;

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

    // Step 1: Build coarse elevation raster (parallel).
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

    // Step 2: Find connected land regions (islands).
    let regions = find_land_regions(&raster);

    if regions.is_empty() {
        return TreeData {
            positions: Vec::new(),
        };
    }

    // Step 3: Run Poisson disk sampling per-island in parallel.
    // Each island gets a deterministic seed derived from the base seed and
    // its sorted index, so results are independent of thread scheduling.
    let all_candidates: Vec<Vec<[f64; 2]>> = regions
        .par_iter()
        .enumerate()
        .map(|(i, region)| {
            let island_seed = seed ^ (i as u64).wrapping_mul(0x517CC1B727220A95);
            let mut rng = Rng::new(island_seed);
            poisson_disk_for_region(region, config.spacing, &raster, &mut rng, width, height)
        })
        .collect();

    // Step 4: Filter by elevation acceptance curve and density thinning.
    // Each island's filter uses a deterministic RNG seeded from its index,
    // so the output is identical regardless of parallel execution order.
    let mut positions: Vec<[f32; 2]> = Vec::new();

    for (i, candidates) in all_candidates.into_iter().enumerate() {
        let filter_seed = seed ^ (i as u64).wrapping_mul(0x9E3779B97F4A7C15);
        let mut rng = Rng::new(filter_seed);

        for [cx, cy] in &candidates {
            let h = raster.sample(*cx, *cy);

            let threshold = match biome_zones {
                Some(zones) => {
                    biome_density_at_height(h, zones, config.min_elevation, config.max_elevation)
                }
                None => {
                    elevation_acceptance(h, config.min_elevation, config.max_elevation)
                        * config.density
                }
            };
            if threshold <= 0.0 {
                continue;
            }
            if rng.next_f64() >= threshold {
                continue;
            }

            let world_x = min_x + cx;
            let world_y = min_y + cy;
            positions.push([world_x as f32, world_y as f32]);
        }
    }

    TreeData { positions }
}
