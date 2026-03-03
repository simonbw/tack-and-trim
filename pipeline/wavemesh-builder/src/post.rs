//! Post-processing — amplitude, diffraction, turbulence diffusion.
//! Mirrors wavefrontPost.ts.
//!
//! Note: these functions are currently unused — the same logic is inlined in
//! `marching.rs::post_process_segments`. They are kept for reference and testing.

use crate::config::MeshBuildPostConfig;
use crate::wavefront::{WaveParams, WavefrontSegment};

fn compute_shoaling_factor(depth: f64, k: f64) -> f64 {
    let kh = k * depth;
    if kh > 10.0 {
        return 1.0;
    }
    let sinh2kh = (2.0 * kh).sinh();
    let n = 0.5 * (1.0 + (2.0 * kh) / sinh2kh);
    1.0 / (2.0 * n * kh.tanh()).sqrt()
}

/// Compute amplitude for every point in a set of wavefront segments using
/// shoaling factor and divergence-based scaling.
pub fn compute_amplitudes(
    segments: &mut [WavefrontSegment],
    wp: &WaveParams,
    config: &MeshBuildPostConfig,
) {
    let spacing_per_t = wp.vertex_spacing / wp.initial_delta_t;

    for wf in segments.iter_mut() {
        let n = wf.len();
        if n == 0 {
            continue;
        }

        for i in 0..n {
            if wf.t[i] == 0.0 || wf.t[i] == 1.0 {
                wf.amplitude[i] = 1.0;
                continue;
            }

            let p_depth = wf.depth[i];
            let shoaling = if p_depth > 0.0 {
                compute_shoaling_factor(p_depth, wp.k).min(config.max_amplification)
            } else {
                1.0
            };

            let (local_spacing, delta_t) = if n <= 1 {
                (wp.vertex_spacing, wp.initial_delta_t)
            } else if i == 0 {
                let dx = wf.x[0] - wf.x[1];
                let dy = wf.y[0] - wf.y[1];
                ((dx * dx + dy * dy).sqrt(), wf.t[1] - wf.t[0])
            } else if i == n - 1 {
                let prev = n - 2;
                let dx = wf.x[n - 1] - wf.x[prev];
                let dy = wf.y[n - 1] - wf.y[prev];
                ((dx * dx + dy * dy).sqrt(), wf.t[n - 1] - wf.t[prev])
            } else {
                let dxp = wf.x[i] - wf.x[i - 1];
                let dyp = wf.y[i] - wf.y[i - 1];
                let dp = (dxp * dxp + dyp * dyp).sqrt();
                let dxn = wf.x[i] - wf.x[i + 1];
                let dyn_ = wf.y[i] - wf.y[i + 1];
                let dn = (dxn * dxn + dyn_ * dyn_).sqrt();
                ((dp + dn) / 2.0, (wf.t[i + 1] - wf.t[i - 1]) / 2.0)
            };

            let expected = delta_t * spacing_per_t;
            let divergence = (expected / local_spacing)
                .sqrt()
                .min(config.max_amplification);
            wf.amplitude[i] = wf.energy[i] * shoaling * divergence;
        }
    }
}

/// Lateral diffusion of amplitude across wavefront segments (diffraction).
pub fn apply_diffraction(
    segments: &mut [WavefrontSegment],
    wp: &WaveParams,
    config: &MeshBuildPostConfig,
) {
    let d = (wp.step_size / (2.0 * wp.k * wp.vertex_spacing * wp.vertex_spacing))
        .min(config.max_diffusion_d);
    let mut scratch = Vec::new();

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 1 {
            continue;
        }

        let edge_threshold = wp.initial_delta_t * 0.5;
        let left_is_edge = seg.t[0] < edge_threshold;
        let right_is_edge = seg.t[n - 1] > 1.0 - edge_threshold;

        scratch.resize(n, 0.0);

        for _ in 0..config.diffraction_iterations {
            scratch[..n].copy_from_slice(&seg.amplitude[..n]);

            for i in 0..n {
                let left = if i > 0 {
                    scratch[i - 1]
                } else if left_is_edge {
                    1.0
                } else {
                    0.0
                };
                let right = if i < n - 1 {
                    scratch[i + 1]
                } else if right_is_edge {
                    1.0
                } else {
                    0.0
                };
                seg.amplitude[i] = (scratch[i] + d * (left - 2.0 * scratch[i] + right)).max(0.0);
            }
        }
    }
}

/// Lateral diffusion of turbulence across wavefront segments.
pub fn diffuse_turbulence_step(segments: &mut [WavefrontSegment], config: &MeshBuildPostConfig) {
    let mut scratch = Vec::new();

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 2 {
            continue;
        }

        scratch.resize(n, 0.0);

        for _ in 0..config.turbulence_diffusion_iterations {
            scratch[..n].copy_from_slice(&seg.turbulence[..n]);
            for i in 0..n {
                let left = if i > 0 { scratch[i - 1] } else { 0.0 };
                let right = if i < n - 1 { scratch[i + 1] } else { 0.0 };
                seg.turbulence[i] = (scratch[i]
                    + config.turbulence_diffusion_d * (left - 2.0 * scratch[i] + right))
                    .max(0.0);
            }
        }
    }
}
