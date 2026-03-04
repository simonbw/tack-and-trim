//! Wavefront refinement — split/merge pass.
//! Mirrors wavefrontRefine.ts.

use crate::config::MeshBuildRefinementConfig;
use crate::wavefront::WavefrontSegment;

/// Counters for split and merge operations during wavefront refinement.
pub struct RefineStats {
    pub splits: u64,
    pub merges: u64,
}

/// Single pass of merge/split refinement on a wavefront segment.
pub fn refine_wavefront(
    wf: &WavefrontSegment,
    vertex_spacing: f64,
    initial_delta_t: f64,
    stats: &mut RefineStats,
    config: &MeshBuildRefinementConfig,
) -> WavefrontSegment {
    let src_len = wf.len();
    if src_len <= 1 {
        return wf.clone();
    }

    let min_dist = vertex_spacing * config.merge_ratio;
    let min_dist_sq = min_dist * min_dist;
    let can_split = src_len < config.max_segment_points;
    let split_escalation_exp = config.split_escalation.ln() / 2.0_f64.ln();

    // Pre-allocate for roughly the same size — splits/merges make it vary slightly
    let mut result = WavefrontSegment::with_capacity(
        wf.track_id,
        wf.parent_track_id,
        wf.source_step_index,
        src_len + src_len / 4,
    );

    // Push first point
    result.push(
        wf.x[0],
        wf.y[0],
        wf.t[0],
        wf.dir_x[0],
        wf.dir_y[0],
        wf.energy[0],
        wf.turbulence[0],
        wf.depth[0],
        wf.terrain_grad_x[0],
        wf.terrain_grad_y[0],
        0.0,
        wf.blend[0],
    );

    let mut split_count = 0usize;

    for i in 1..src_len {
        let prev_idx = result.len() - 1;
        let prev_x = result.x[prev_idx];
        let prev_y = result.y[prev_idx];
        let prev_t = result.t[prev_idx];
        let prev_energy = result.energy[prev_idx];
        let prev_blend = result.blend[prev_idx];

        let curr_x = wf.x[i];
        let curr_y = wf.y[i];
        let curr_t = wf.t[i];
        let curr_energy = wf.energy[i];

        let dx = curr_x - prev_x;
        let dy = curr_y - prev_y;
        let dist_sq = dx * dx + dy * dy;

        // Merge check — never merge sentinels
        if dist_sq < min_dist_sq && prev_t != 0.0 && prev_t != 1.0 && curr_t != 0.0 && curr_t != 1.0
        {
            stats.merges += 1;
            continue;
        }

        // Split check
        let delta_t = (curr_t - prev_t).abs();
        let t_scale = if delta_t > 1e-12 {
            initial_delta_t / delta_t
        } else {
            config.max_split_ratio
        };
        let escalation = t_scale.powf(split_escalation_exp);
        let effective_ratio = (config.base_split_ratio * escalation).min(config.max_split_ratio);
        let max_dist = vertex_spacing * effective_ratio;
        let max_dist_sq = max_dist * max_dist;

        let prev_is_sentinel = prev_t == 0.0 || prev_t == 1.0;
        let curr_is_sentinel = curr_t == 0.0 || curr_t == 1.0;

        if can_split
            && dist_sq > max_dist_sq
            && split_count < config.max_splits_per_segment
            && prev_energy >= config.min_split_energy
            && curr_energy >= config.min_split_energy
            && !prev_is_sentinel
            && !curr_is_sentinel
        {
            let mut mid_dir_x = result.dir_x[prev_idx] + wf.dir_x[i];
            let mut mid_dir_y = result.dir_y[prev_idx] + wf.dir_y[i];
            let len = (mid_dir_x * mid_dir_x + mid_dir_y * mid_dir_y).sqrt();
            if len > 0.0 {
                mid_dir_x /= len;
                mid_dir_y /= len;
            }

            result.push(
                (prev_x + curr_x) / 2.0,
                (prev_y + curr_y) / 2.0,
                (prev_t + curr_t) / 2.0,
                mid_dir_x,
                mid_dir_y,
                (prev_energy + curr_energy) / 2.0,
                (result.turbulence[prev_idx] + wf.turbulence[i]) / 2.0,
                (result.depth[prev_idx] + wf.depth[i]) / 2.0,
                (result.terrain_grad_x[prev_idx] + wf.terrain_grad_x[i]) / 2.0,
                (result.terrain_grad_y[prev_idx] + wf.terrain_grad_y[i]) / 2.0,
                0.0,
                (prev_blend + wf.blend[i]) / 2.0,
            );
            split_count += 1;
            stats.splits += 1;
        }

        result.push(
            curr_x,
            curr_y,
            curr_t,
            wf.dir_x[i],
            wf.dir_y[i],
            wf.energy[i],
            wf.turbulence[i],
            wf.depth[i],
            wf.terrain_grad_x[i],
            wf.terrain_grad_y[i],
            0.0,
            wf.blend[i],
        );
    }

    result
}
