/// Data structures for wavefront segments, tracks, and mesh output.
/// Mirrors marchingTypes.ts, segmentTracks.ts, MeshBuildTypes.ts.

pub const VERTEX_FLOATS: usize = 6;

/// Struct-of-arrays wavefront segment (SoA layout).
#[derive(Clone)]
pub struct WavefrontSegment {
    pub track_id: i32,
    pub parent_track_id: Option<i32>,
    pub source_step_index: usize,
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub t: Vec<f64>,
    pub dir_x: Vec<f64>,
    pub dir_y: Vec<f64>,
    pub energy: Vec<f64>,
    pub turbulence: Vec<f64>,
    pub depth: Vec<f64>,
    pub terrain_grad_x: Vec<f64>,
    pub terrain_grad_y: Vec<f64>,
    pub amplitude: Vec<f64>,
    pub blend: Vec<f64>,
}

impl WavefrontSegment {
    pub fn new(track_id: i32, parent_track_id: Option<i32>, source_step_index: usize) -> Self {
        WavefrontSegment {
            track_id,
            parent_track_id,
            source_step_index,
            x: vec![], y: vec![], t: vec![],
            dir_x: vec![], dir_y: vec![],
            energy: vec![], turbulence: vec![],
            depth: vec![],
            terrain_grad_x: vec![], terrain_grad_y: vec![],
            amplitude: vec![], blend: vec![],
        }
    }

    pub fn len(&self) -> usize { self.x.len() }

    pub fn push(
        &mut self, x: f64, y: f64, t: f64,
        dir_x: f64, dir_y: f64,
        energy: f64, turbulence: f64, depth: f64,
        terrain_grad_x: f64, terrain_grad_y: f64,
        amplitude: f64, blend: f64,
    ) {
        self.x.push(x);
        self.y.push(y);
        self.t.push(t);
        self.dir_x.push(dir_x);
        self.dir_y.push(dir_y);
        self.energy.push(energy);
        self.turbulence.push(turbulence);
        self.depth.push(depth);
        self.terrain_grad_x.push(terrain_grad_x);
        self.terrain_grad_y.push(terrain_grad_y);
        self.amplitude.push(amplitude);
        self.blend.push(blend);
    }
}

/// Wave-aligned bounding box.
#[derive(Clone, Copy, Debug)]
pub struct WaveBounds {
    pub min_proj: f64,
    pub max_proj: f64,
    pub min_perp: f64,
    pub max_perp: f64,
}

/// A snapshot of a segment track at one march step.
#[derive(Clone)]
pub struct SegmentTrackSnapshot {
    pub step_index: usize,
    pub segment_index: usize,
    pub source_step_index: usize,
    pub segment: WavefrontSegment,
}

/// A lineage-preserving segment track.
#[derive(Clone)]
pub struct SegmentTrack {
    pub track_id: i32,
    pub parent_track_id: Option<i32>,
    pub child_track_ids: Vec<i32>,
    pub snapshots: Vec<SegmentTrackSnapshot>,
}

/// Final mesh output data.
pub struct WavefrontMeshData {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_count: usize,
    pub index_count: usize,
    pub coverage_quad: CoverageQuad,
}

#[derive(Clone, Debug, Default)]
pub struct CoverageQuad {
    pub x0: f64, pub y0: f64,
    pub x1: f64, pub y1: f64,
    pub x2: f64, pub y2: f64,
    pub x3: f64, pub y3: f64,
}
