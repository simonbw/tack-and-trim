//! Data structures for wavefront segments, tracks, and mesh output.
//! Mirrors marchingTypes.ts, segmentTracks.ts, MeshBuildTypes.ts.

use crate::config::MeshBuildConfig;
use crate::level::WaveSource;

/// Number of f32 values per vertex in the output mesh buffer.
pub const VERTEX_FLOATS: usize = 6;

/// Precomputed wave propagation parameters derived from a single wave source.
#[derive(Clone, Debug)]
pub struct WaveParams {
    pub wave_dx: f64,
    pub wave_dy: f64,
    pub perp_dx: f64,
    pub perp_dy: f64,
    pub wavelength: f64,
    pub k: f64,
    pub step_size: f64,
    pub vertex_spacing: f64,
    pub phase_per_step: f64,
    pub initial_delta_t: f64,
}

impl WaveParams {
    /// Construct from a wave source and build config. `initial_delta_t` is set
    /// to 0.0 here and must be updated after the first wavefront is generated.
    pub fn from_source(ws: &WaveSource, config: &MeshBuildConfig) -> Self {
        let k = std::f64::consts::TAU / ws.wavelength;
        let step_size = config.resolution.step_size_ft;
        WaveParams {
            wave_dx: ws.direction.cos(),
            wave_dy: ws.direction.sin(),
            perp_dx: -ws.direction.sin(),
            perp_dy: ws.direction.cos(),
            wavelength: ws.wavelength,
            k,
            step_size,
            vertex_spacing: config.resolution.vertex_spacing_ft,
            phase_per_step: k * step_size,
            initial_delta_t: 0.0,
        }
    }
}

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
    /// Create an empty segment with the given track lineage info.
    pub fn new(track_id: i32, parent_track_id: Option<i32>, source_step_index: usize) -> Self {
        Self::with_capacity(track_id, parent_track_id, source_step_index, 0)
    }

    /// Create a segment pre-allocated for `cap` rays.
    pub fn with_capacity(
        track_id: i32,
        parent_track_id: Option<i32>,
        source_step_index: usize,
        cap: usize,
    ) -> Self {
        WavefrontSegment {
            track_id,
            parent_track_id,
            source_step_index,
            x: Vec::with_capacity(cap),
            y: Vec::with_capacity(cap),
            t: Vec::with_capacity(cap),
            dir_x: Vec::with_capacity(cap),
            dir_y: Vec::with_capacity(cap),
            energy: Vec::with_capacity(cap),
            turbulence: Vec::with_capacity(cap),
            depth: Vec::with_capacity(cap),
            terrain_grad_x: Vec::with_capacity(cap),
            terrain_grad_y: Vec::with_capacity(cap),
            amplitude: Vec::with_capacity(cap),
            blend: Vec::with_capacity(cap),
        }
    }

    /// Number of rays in this segment.
    #[inline(always)]
    pub fn len(&self) -> usize {
        self.x.len()
    }

    /// Append a ray with all per-vertex fields.
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        x: f64,
        y: f64,
        t: f64,
        dir_x: f64,
        dir_y: f64,
        energy: f64,
        turbulence: f64,
        depth: f64,
        terrain_grad_x: f64,
        terrain_grad_y: f64,
        amplitude: f64,
        blend: f64,
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

/// World-space quad covering a wave source's mesh extent.
#[derive(Clone, Debug, Default)]
pub struct CoverageQuad {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub x3: f64,
    pub y3: f64,
}
