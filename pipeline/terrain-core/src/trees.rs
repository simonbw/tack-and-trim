//! Tree placement generation and binary .trees file writing.
//!
//! Algorithm: scatter pseudorandom candidate points across the terrain AABB,
//! keep those whose terrain height falls within an elevation band.

use crate::level::TerrainCPUData;
use crate::terrain::{compute_terrain_height, parse_contours};

// ── Configuration ────────────────────────────────────────────────────────────

const NUM_CANDIDATES: usize = 1000;
const MIN_ELEVATION: f64 = 10.0; // feet
const MAX_ELEVATION: f64 = 1000.0; // feet

// ── Output ───────────────────────────────────────────────────────────────────

pub struct TreeData {
    /// Flat list of (x, y) positions in world feet.
    pub positions: Vec<[f32; 2]>,
}

// ── Binary file format ──────────────────────────────────────────────────────

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
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
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

// ── Generation ──────────────────────────────────────────────────────────────

/// Generate tree positions by scattering random candidates across the terrain
/// AABB and keeping those within the elevation band.
pub fn generate_trees(terrain: &TerrainCPUData, seed: u64) -> TreeData {
    let (contours, _lookup_grid) = parse_contours(terrain);

    // Compute terrain AABB
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

    let mut rng = Rng::new(seed);
    let mut positions = Vec::new();

    for _ in 0..NUM_CANDIDATES {
        let x = min_x + rng.next_f64() * width;
        let y = min_y + rng.next_f64() * height;

        let h = compute_terrain_height(x, y, terrain, &contours);

        if h >= MIN_ELEVATION && h <= MAX_ELEVATION {
            positions.push([x as f32, y as f32]);
        }
    }

    TreeData { positions }
}
