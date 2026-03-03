//! Mesh triangulation from segment tracks.
//! Mirrors buildMeshDataFromTracks.ts.

use crate::wavefront::{
    CoverageQuad, SegmentTrack, WaveBounds, WaveParams, WavefrontMeshData, WavefrontSegment,
    VERTEX_FLOATS,
};
use std::collections::HashMap;

/// Triangulate all segment tracks into a single mesh with vertex and index buffers.
pub fn build_mesh_data_from_tracks(
    tracks: &[SegmentTrack],
    wp: &WaveParams,
    bounds: &WaveBounds,
) -> WavefrontMeshData {
    let k = wp.k;
    let topo = count_mesh_topology(tracks);

    let mut vertices = vec![0.0f32; topo.vertex_count * VERTEX_FLOATS];
    let mut indices = vec![0u32; topo.triangle_count * 3];

    // Track which segments already have vertices written; map segment ptr → base vertex index
    let mut base_by_segment: HashMap<*const WavefrontSegment, usize> = HashMap::new();
    let mut track_by_id: HashMap<i32, &SegmentTrack> = HashMap::new();
    for track in tracks {
        track_by_id.insert(track.track_id, track);
    }

    let mut vertex_offset = 0usize;
    let mut index_offset = 0usize;

    let ensure_vertices = |seg: &WavefrontSegment,
                           vertices: &mut Vec<f32>,
                           vertex_offset: &mut usize,
                           base_by_segment: &mut HashMap<*const WavefrontSegment, usize>|
     -> usize {
        let ptr = seg as *const WavefrontSegment;
        if let Some(&base) = base_by_segment.get(&ptr) {
            return base;
        }
        let base = *vertex_offset / VERTEX_FLOATS;
        base_by_segment.insert(ptr, base);

        let phase_base = seg.source_step_index as f64 * wp.phase_per_step;
        for pi in 0..seg.len() {
            let x = seg.x[pi];
            let y = seg.y[pi];
            let phase_offset = phase_base - k * (x * wp.wave_dx + y * wp.wave_dy);
            vertices[*vertex_offset] = x as f32;
            *vertex_offset += 1;
            vertices[*vertex_offset] = y as f32;
            *vertex_offset += 1;
            vertices[*vertex_offset] = seg.amplitude[pi] as f32;
            *vertex_offset += 1;
            vertices[*vertex_offset] = seg.turbulence[pi] as f32;
            *vertex_offset += 1;
            vertices[*vertex_offset] = phase_offset as f32;
            *vertex_offset += 1;
            vertices[*vertex_offset] = seg.blend[pi] as f32;
            *vertex_offset += 1;
        }
        base
    };

    // Triangulate within each track's consecutive snapshots
    for track in tracks {
        for si in 0..track.snapshots.len().saturating_sub(1) {
            let prev_seg = &track.snapshots[si].segment;
            let next_seg = &track.snapshots[si + 1].segment;
            let prev_base = ensure_vertices(
                prev_seg,
                &mut vertices,
                &mut vertex_offset,
                &mut base_by_segment,
            );
            let next_base = ensure_vertices(
                next_seg,
                &mut vertices,
                &mut vertex_offset,
                &mut base_by_segment,
            );
            index_offset = triangulate_segment_pair(
                prev_seg,
                next_seg,
                prev_base,
                next_base,
                &mut indices,
                index_offset,
            );
        }
    }

    // Triangulate parent→child split boundaries
    for parent in tracks {
        let last_snap = match parent.snapshots.last() {
            Some(s) => s,
            None => continue,
        };
        for &child_id in &parent.child_track_ids {
            let child_track = match track_by_id.get(&child_id) {
                Some(t) => t,
                None => continue,
            };
            let first_snap = match child_track.snapshots.first() {
                Some(s) => s,
                None => continue,
            };
            let parent_base = ensure_vertices(
                &last_snap.segment,
                &mut vertices,
                &mut vertex_offset,
                &mut base_by_segment,
            );
            let child_base = ensure_vertices(
                &first_snap.segment,
                &mut vertices,
                &mut vertex_offset,
                &mut base_by_segment,
            );
            index_offset = triangulate_segment_pair(
                &last_snap.segment,
                &first_snap.segment,
                parent_base,
                child_base,
                &mut indices,
                index_offset,
            );
        }
    }

    let coverage_quad = compute_coverage_quad(bounds, wp.wave_dx, wp.wave_dy);
    let final_vertex_count = vertex_offset / VERTEX_FLOATS;

    indices.truncate(index_offset);

    WavefrontMeshData {
        vertices,
        indices,
        vertex_count: final_vertex_count,
        index_count: index_offset,
        coverage_quad,
    }
}

struct MeshTopology {
    vertex_count: usize,
    triangle_count: usize,
}

fn count_mesh_topology(tracks: &[SegmentTrack]) -> MeshTopology {
    // Use segment pointer identity to count unique segments
    let mut unique_ptrs: std::collections::HashSet<*const WavefrontSegment> =
        std::collections::HashSet::new();
    let mut triangle_count = 0usize;
    let mut track_by_id: HashMap<i32, &SegmentTrack> = HashMap::new();

    for track in tracks {
        track_by_id.insert(track.track_id, track);
        for snap in &track.snapshots {
            unique_ptrs.insert(&snap.segment as *const WavefrontSegment);
        }
        for si in 0..track.snapshots.len().saturating_sub(1) {
            triangle_count += count_triangles_between(
                &track.snapshots[si].segment,
                &track.snapshots[si + 1].segment,
            );
        }
    }

    for parent in tracks {
        let last = match parent.snapshots.last() {
            Some(s) => s,
            None => continue,
        };
        for &child_id in &parent.child_track_ids {
            let child = match track_by_id.get(&child_id) {
                Some(t) => t,
                None => continue,
            };
            let first = match child.snapshots.first() {
                Some(s) => s,
                None => continue,
            };
            triangle_count += count_triangles_between(&last.segment, &first.segment);
        }
    }

    let mut vertex_count = 0;
    for &ptr in &unique_ptrs {
        vertex_count += unsafe { &*ptr }.len();
    }

    MeshTopology {
        vertex_count,
        triangle_count,
    }
}

fn count_triangles_between(prev: &WavefrontSegment, next: &WavefrontSegment) -> usize {
    let prev_len = prev.len();
    let next_len = next.len();
    if prev_len == 0 || next_len == 0 {
        return 0;
    }
    let overlap_min = prev.t[0].max(next.t[0]);
    let overlap_max = prev.t[prev_len - 1].min(next.t[next_len - 1]);
    if overlap_min > overlap_max {
        return 0;
    }
    let (ps, pe) = clip_to_range(prev, overlap_min, overlap_max);
    let (ns, ne) = clip_to_range(next, overlap_min, overlap_max);
    if pe < ps || ne < ns {
        return 0;
    }
    (pe - ps) + (ne - ns)
}

fn triangulate_segment_pair(
    prev: &WavefrontSegment,
    next: &WavefrontSegment,
    prev_base: usize,
    next_base: usize,
    indices: &mut [u32],
    mut offset: usize,
) -> usize {
    let prev_len = prev.len();
    let next_len = next.len();
    if prev_len == 0 || next_len == 0 {
        return offset;
    }

    let overlap_min = prev.t[0].max(next.t[0]);
    let overlap_max = prev.t[prev_len - 1].min(next.t[next_len - 1]);
    if overlap_min > overlap_max {
        return offset;
    }

    let (p_start, p_end) = clip_to_range(prev, overlap_min, overlap_max);
    let (n_start, n_end) = clip_to_range(next, overlap_min, overlap_max);
    if p_end < p_start || n_end < n_start {
        return offset;
    }

    let mut i = p_start;
    let mut j = n_start;

    while i < p_end || j < n_end {
        if i >= p_end {
            indices[offset] = (prev_base + i) as u32;
            offset += 1;
            indices[offset] = (next_base + j) as u32;
            offset += 1;
            indices[offset] = (next_base + j + 1) as u32;
            offset += 1;
            j += 1;
        } else if j >= n_end {
            indices[offset] = (prev_base + i) as u32;
            offset += 1;
            indices[offset] = (prev_base + i + 1) as u32;
            offset += 1;
            indices[offset] = (next_base + j) as u32;
            offset += 1;
            i += 1;
        } else {
            let score_a = score_triangle(
                prev.x[i],
                prev.y[i],
                prev.x[i + 1],
                prev.y[i + 1],
                next.x[j],
                next.y[j],
            );
            let score_b = score_triangle(
                prev.x[i],
                prev.y[i],
                next.x[j],
                next.y[j],
                next.x[j + 1],
                next.y[j + 1],
            );
            if score_a < score_b {
                indices[offset] = (prev_base + i) as u32;
                offset += 1;
                indices[offset] = (prev_base + i + 1) as u32;
                offset += 1;
                indices[offset] = (next_base + j) as u32;
                offset += 1;
                i += 1;
            } else {
                indices[offset] = (prev_base + i) as u32;
                offset += 1;
                indices[offset] = (next_base + j) as u32;
                offset += 1;
                indices[offset] = (next_base + j + 1) as u32;
                offset += 1;
                j += 1;
            }
        }
    }
    offset
}

fn score_triangle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) -> f64 {
    let d1x = bx - ax;
    let d1y = by - ay;
    let d2x = cx - bx;
    let d2y = cy - by;
    let d3x = ax - cx;
    let d3y = ay - cy;
    d1x * d1x + d1y * d1y + d2x * d2x + d2y * d2y + d3x * d3x + d3y * d3y
}

fn clip_to_range(seg: &WavefrontSegment, min_t: f64, max_t: f64) -> (usize, usize) {
    let t = &seg.t;
    let len = t.len();
    let mut start = 0;
    while start < len && t[start] < min_t {
        start += 1;
    }
    let mut end = len - 1;
    while end > 0 && t[end] > max_t {
        end -= 1;
    }
    if start > end {
        return (start, end);
    }
    start = start.saturating_sub(1);
    if end < len - 1 {
        end += 1;
    }
    (start, end)
}

fn compute_coverage_quad(bounds: &WaveBounds, wave_dx: f64, wave_dy: f64) -> CoverageQuad {
    let perp_dx = -wave_dy;
    let perp_dy = wave_dx;
    let to_world = |proj: f64, perp: f64| -> (f64, f64) {
        (
            proj * wave_dx + perp * perp_dx,
            proj * wave_dy + perp * perp_dy,
        )
    };
    let (x0, y0) = to_world(bounds.min_proj, bounds.min_perp);
    let (x1, y1) = to_world(bounds.max_proj, bounds.min_perp);
    let (x2, y2) = to_world(bounds.max_proj, bounds.max_perp);
    let (x3, y3) = to_world(bounds.min_proj, bounds.max_perp);
    CoverageQuad {
        x0,
        y0,
        x1,
        y1,
        x2,
        y2,
        x3,
        y3,
    }
}
