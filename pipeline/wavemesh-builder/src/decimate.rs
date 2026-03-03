//! Segment and track-level decimation.
//! Mirrors decimateSegment.ts and decimateWavefrontTracks.ts.

use crate::wavefront::{SegmentTrack, SegmentTrackSnapshot, WaveParams, WavefrontSegment};

fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

// ── Segment-level decimation ─────────────────────────────────────────────────

fn can_remove_vertices_between(
    seg: &WavefrontSegment,
    anchor: usize,
    endpoint: usize,
    pos_tol_sq: f64,
    amp_tol: f64,
) -> bool {
    if endpoint <= anchor + 1 {
        return true;
    }

    let a_t = seg.t[anchor];
    let b_t = seg.t[endpoint];
    let t_span = b_t - a_t;
    let inv_t_span = if t_span > 0.0 { 1.0 / t_span } else { 0.0 };

    let ax = seg.x[anchor];
    let ay = seg.y[anchor];
    let bx = seg.x[endpoint];
    let by = seg.y[endpoint];
    let x_delta = bx - ax;
    let y_delta = by - ay;

    let a_amp = seg.amplitude[anchor];
    let b_amp = seg.amplitude[endpoint];
    let amp_delta = b_amp - a_amp;
    let a_turb = seg.turbulence[anchor];
    let b_turb = seg.turbulence[endpoint];
    let turb_delta = b_turb - a_turb;
    let a_blend = seg.blend[anchor];
    let b_blend = seg.blend[endpoint];
    let blend_delta = b_blend - a_blend;

    let t_slice = &seg.t[(anchor + 1)..endpoint];
    let x_slice = &seg.x[(anchor + 1)..endpoint];
    let y_slice = &seg.y[(anchor + 1)..endpoint];
    let amp_slice = &seg.amplitude[(anchor + 1)..endpoint];
    let turb_slice = &seg.turbulence[(anchor + 1)..endpoint];
    let blend_slice = &seg.blend[(anchor + 1)..endpoint];

    for (((((&t, &x), &y), &amp), &turb), &blend) in t_slice
        .iter()
        .zip(x_slice)
        .zip(y_slice)
        .zip(amp_slice)
        .zip(turb_slice)
        .zip(blend_slice)
    {
        let f = (t - a_t) * inv_t_span;
        let ix = ax + x_delta * f;
        let iy = ay + y_delta * f;
        let dx = x - ix;
        let dy = y - iy;
        if dx * dx + dy * dy > pos_tol_sq {
            return false;
        }

        if (amp - (a_amp + amp_delta * f)).abs() > amp_tol {
            return false;
        }
        if (turb - (a_turb + turb_delta * f)).abs() > amp_tol {
            return false;
        }
        if (blend - (a_blend + blend_delta * f)).abs() > amp_tol {
            return false;
        }
    }
    true
}

fn build_segment_from_kept(seg: &WavefrontSegment, kept: &[usize]) -> WavefrontSegment {
    let mut out = WavefrontSegment::with_capacity(
        seg.track_id,
        seg.parent_track_id,
        seg.source_step_index,
        kept.len(),
    );
    for &idx in kept {
        out.push(
            seg.x[idx],
            seg.y[idx],
            seg.t[idx],
            if !seg.dir_x.is_empty() {
                seg.dir_x[idx]
            } else {
                0.0
            },
            if !seg.dir_y.is_empty() {
                seg.dir_y[idx]
            } else {
                0.0
            },
            if !seg.energy.is_empty() {
                seg.energy[idx]
            } else {
                0.0
            },
            seg.turbulence[idx],
            if !seg.depth.is_empty() {
                seg.depth[idx]
            } else {
                0.0
            },
            if !seg.terrain_grad_x.is_empty() {
                seg.terrain_grad_x[idx]
            } else {
                0.0
            },
            if !seg.terrain_grad_y.is_empty() {
                seg.terrain_grad_y[idx]
            } else {
                0.0
            },
            seg.amplitude[idx],
            seg.blend[idx],
        );
    }
    out
}

/// Decimate a single segment by removing vertices whose linear interpolation
/// stays within position and amplitude tolerances.
pub fn decimate_segment(seg: &WavefrontSegment, pos_tol_sq: f64, amp_tol: f64) -> WavefrontSegment {
    let len = seg.len();
    if len <= 2 {
        return seg.clone();
    }

    let mut kept = vec![0usize];
    let mut anchor = 0;
    let mut endpoint = 2;

    while endpoint < len {
        if can_remove_vertices_between(seg, anchor, endpoint, pos_tol_sq, amp_tol) {
            if endpoint == len - 1 {
                kept.push(endpoint);
                break;
            }
            endpoint += 1;
        } else {
            kept.push(endpoint - 1);
            anchor = endpoint - 1;
            endpoint = anchor + 2;
        }
    }

    if *kept.last().unwrap() != len - 1 {
        kept.push(len - 1);
    }

    if kept.len() == len {
        return seg.clone();
    }
    build_segment_from_kept(seg, &kept)
}

// ── Track-level decimation ───────────────────────────────────────────────────

struct SegmentSample {
    x: f64,
    y: f64,
    amplitude: f64,
    turbulence: f64,
    blend: f64,
}

/// Forward-only sampler for monotonically increasing t queries on a segment.
/// Maintains a cursor to avoid binary search, giving O(1) amortized per query.
struct SegmentScanner<'a> {
    seg: &'a WavefrontSegment,
    cursor: usize,
    n: usize,
    t_min: f64,
    t_max: f64,
}

impl<'a> SegmentScanner<'a> {
    fn new(seg: &'a WavefrontSegment) -> Self {
        let n = seg.len();
        let (t_min, t_max) = if n > 0 {
            (seg.t[0], seg.t[n - 1])
        } else {
            (0.0, 0.0)
        };
        SegmentScanner {
            seg,
            cursor: 0,
            n,
            t_min,
            t_max,
        }
    }

    /// Sample interpolated values at t. Queries must be monotonically increasing.
    fn sample(&mut self, t: f64) -> Option<SegmentSample> {
        if self.n == 0 {
            return None;
        }
        if t < self.t_min - 1e-9 || t > self.t_max + 1e-9 {
            return None;
        }

        if t <= self.t_min {
            return Some(SegmentSample {
                x: self.seg.x[0],
                y: self.seg.y[0],
                amplitude: self.seg.amplitude[0],
                turbulence: self.seg.turbulence[0],
                blend: self.seg.blend[0],
            });
        }
        if t >= self.t_max {
            let i = self.n - 1;
            return Some(SegmentSample {
                x: self.seg.x[i],
                y: self.seg.y[i],
                amplitude: self.seg.amplitude[i],
                turbulence: self.seg.turbulence[i],
                blend: self.seg.blend[i],
            });
        }

        // Advance cursor forward until we bracket t
        while self.cursor < self.n - 2 && self.seg.t[self.cursor + 1] <= t {
            self.cursor += 1;
        }

        let left = self.cursor;
        let right = left + 1;
        let span = self.seg.t[right] - self.seg.t[left];
        let f = if span > 0.0 {
            (t - self.seg.t[left]) / span
        } else {
            0.0
        };
        Some(SegmentSample {
            x: lerp(self.seg.x[left], self.seg.x[right], f),
            y: lerp(self.seg.y[left], self.seg.y[right], f),
            amplitude: lerp(self.seg.amplitude[left], self.seg.amplitude[right], f),
            turbulence: lerp(self.seg.turbulence[left], self.seg.turbulence[right], f),
            blend: lerp(self.seg.blend[left], self.seg.blend[right], f),
        })
    }
}

fn normalized_error(error: f64, tolerance: f64) -> f64 {
    if tolerance <= 0.0 {
        return if error == 0.0 { 0.0 } else { f64::INFINITY };
    }
    error / tolerance
}

#[allow(clippy::too_many_arguments)]
fn evaluate_snapshot_removal(
    track: &SegmentTrack,
    snapshot_idx: usize,
    anchor_idx: usize,
    endpoint_idx: usize,
    k: f64,
    wave_dx: f64,
    wave_dy: f64,
    pos_tol_sq: f64,
    amp_tol: f64,
    phase_tol: f64,
    phase_per_step: f64,
) -> bool {
    let snapshot = &track.snapshots[snapshot_idx].segment;
    let anchor = &track.snapshots[anchor_idx].segment;
    let endpoint = &track.snapshots[endpoint_idx].segment;
    let span = endpoint_idx - anchor_idx;
    if span <= 1 {
        return false;
    }

    let fraction = (snapshot_idx - anchor_idx) as f64 / span as f64;
    let step_phase_base = snapshot.source_step_index as f64 * phase_per_step;
    let anchor_phase_base = anchor.source_step_index as f64 * phase_per_step;
    let endpoint_phase_base = endpoint.source_step_index as f64 * phase_per_step;

    let mut anchor_scan = SegmentScanner::new(anchor);
    let mut endpoint_scan = SegmentScanner::new(endpoint);

    for i in 0..snapshot.len() {
        let pt = snapshot.t[i];
        let a = match anchor_scan.sample(pt) {
            Some(s) => s,
            None => return false,
        };
        let e = match endpoint_scan.sample(pt) {
            Some(s) => s,
            None => return false,
        };

        let ix = lerp(a.x, e.x, fraction);
        let iy = lerp(a.y, e.y, fraction);
        let dx = snapshot.x[i] - ix;
        let dy = snapshot.y[i] - iy;
        if normalized_error(dx * dx + dy * dy, pos_tol_sq) > 1.0 {
            return false;
        }

        let i_amp = lerp(a.amplitude, e.amplitude, fraction);
        if normalized_error((snapshot.amplitude[i] - i_amp).abs(), amp_tol) > 1.0 {
            return false;
        }

        let i_turb = lerp(a.turbulence, e.turbulence, fraction);
        if normalized_error((snapshot.turbulence[i] - i_turb).abs(), amp_tol) > 1.0 {
            return false;
        }

        let i_blend = lerp(a.blend, e.blend, fraction);
        if normalized_error((snapshot.blend[i] - i_blend).abs(), amp_tol) > 1.0 {
            return false;
        }

        let actual_phase =
            step_phase_base - k * (snapshot.x[i] * wave_dx + snapshot.y[i] * wave_dy);
        let anchor_phase = anchor_phase_base - k * (a.x * wave_dx + a.y * wave_dy);
        let endpoint_phase = endpoint_phase_base - k * (e.x * wave_dx + e.y * wave_dy);
        let i_phase = lerp(anchor_phase, endpoint_phase, fraction);
        if normalized_error((actual_phase - i_phase).abs(), phase_tol) > 1.0 {
            return false;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn keep_mask_for_track(
    track: &SegmentTrack,
    k: f64,
    wave_dx: f64,
    wave_dy: f64,
    pos_tol_sq: f64,
    amp_tol: f64,
    phase_tol: f64,
    phase_per_step: f64,
) -> Vec<bool> {
    let len = track.snapshots.len();
    if len <= 2 {
        return vec![true; len];
    }

    let mut keep = vec![false; len];
    keep[0] = true;
    keep[len - 1] = true;

    let mut anchor = 0;
    let mut endpoint = 2;

    while endpoint < len {
        let removable = evaluate_snapshot_removal(
            track,
            endpoint - 1,
            anchor,
            endpoint,
            k,
            wave_dx,
            wave_dy,
            pos_tol_sq,
            amp_tol,
            phase_tol,
            phase_per_step,
        );
        if removable {
            if endpoint == len - 1 {
                break;
            }
            endpoint += 1;
        } else {
            keep[endpoint - 1] = true;
            anchor = endpoint - 1;
            endpoint = anchor + 2;
        }
    }
    keep
}

/// Result of decimating a single segment track.
pub struct SingleTrackDecimationResult {
    pub track: SegmentTrack,
    pub removed_snapshots: u64,
    pub removed_vertices: u64,
}

/// Decimate a track by removing snapshots and vertices that can be linearly
/// interpolated within the given tolerance.
pub fn decimate_track_snapshots(
    track: &SegmentTrack,
    wp: &WaveParams,
    tolerance: f64,
) -> SingleTrackDecimationResult {
    let k = wp.k;
    let pos_tol_sq = (tolerance * wp.wavelength).powi(2);
    let amp_tol = tolerance;
    let phase_tol = tolerance * std::f64::consts::PI;

    let mut verts_before: u64 = 0;
    for snap in &track.snapshots {
        verts_before += snap.segment.len() as u64;
    }

    let keep_mask = keep_mask_for_track(
        track,
        k,
        wp.wave_dx,
        wp.wave_dy,
        pos_tol_sq,
        amp_tol,
        phase_tol,
        wp.phase_per_step,
    );

    let mut decimated = SegmentTrack {
        track_id: track.track_id,
        parent_track_id: track.parent_track_id,
        child_track_ids: track.child_track_ids.clone(),
        snapshots: Vec::new(),
    };
    let mut removed_snapshots = 0u64;

    for (i, snap) in track.snapshots.iter().enumerate() {
        if !keep_mask[i] {
            removed_snapshots += 1;
            continue;
        }
        let decimated_seg = decimate_segment(&snap.segment, pos_tol_sq, amp_tol);
        decimated.snapshots.push(SegmentTrackSnapshot {
            step_index: snap.step_index,
            segment_index: snap.segment_index,
            source_step_index: snap.source_step_index,
            segment: decimated_seg,
        });
    }

    let mut verts_after: u64 = 0;
    for snap in &decimated.snapshots {
        verts_after += snap.segment.len() as u64;
    }

    SingleTrackDecimationResult {
        track: decimated,
        removed_snapshots,
        removed_vertices: verts_before.saturating_sub(verts_after),
    }
}
