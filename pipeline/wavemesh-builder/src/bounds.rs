//! Wave-aligned bounding box computation from root terrain contours.
//! Mirrors computeBounds.ts.

use crate::config::MeshBuildBoundsConfig;
use terrain_core::level::{TerrainCPUData, FLOATS_PER_CONTOUR};
use crate::wavefront::{WaveBounds, WaveParams};

/// Compute a wave-aligned bounding box from root terrain contours, with
/// wavelength-scaled margins for upwave, downwave, and crosswave directions.
pub fn compute_bounds(
    terrain: &TerrainCPUData,
    wp: &WaveParams,
    config: &MeshBuildBoundsConfig,
) -> WaveBounds {
    let cd = &terrain.contour_data;

    let mut min_proj = f64::INFINITY;
    let mut max_proj = f64::NEG_INFINITY;
    let mut min_perp = f64::INFINITY;
    let mut max_perp = f64::NEG_INFINITY;

    for ci in 0..terrain.contour_count {
        let base = ci * FLOATS_PER_CONTOUR * 4;
        let b = &cd[base..base + FLOATS_PER_CONTOUR * 4];
        let depth = u32::from_le_bytes([b[16], b[17], b[18], b[19]]);
        if depth != 0 {
            continue;
        } // only root contours

        let b_min_x = f32::from_le_bytes([b[32], b[33], b[34], b[35]]) as f64;
        let b_min_y = f32::from_le_bytes([b[36], b[37], b[38], b[39]]) as f64;
        let b_max_x = f32::from_le_bytes([b[40], b[41], b[42], b[43]]) as f64;
        let b_max_y = f32::from_le_bytes([b[44], b[45], b[46], b[47]]) as f64;

        for &(cx, cy) in &[
            (b_min_x, b_min_y),
            (b_max_x, b_min_y),
            (b_max_x, b_max_y),
            (b_min_x, b_max_y),
        ] {
            let proj = cx * wp.wave_dx + cy * wp.wave_dy;
            let perp = cx * wp.perp_dx + cy * wp.perp_dy;
            if proj < min_proj {
                min_proj = proj;
            }
            if proj > max_proj {
                max_proj = proj;
            }
            if perp < min_perp {
                min_perp = perp;
            }
            if perp > max_perp {
                max_perp = perp;
            }
        }
    }

    if min_proj == f64::INFINITY {
        let half = config.fallback_half_extent_ft;
        return WaveBounds {
            min_proj: -half,
            max_proj: half,
            min_perp: -half,
            max_perp: half,
        };
    }

    let upwave = (wp.wavelength * config.upwave_margin_wavelengths).max(config.min_margin_ft);
    let downwave = (wp.wavelength * config.downwave_margin_wavelengths).max(config.min_margin_ft);
    let crosswave = (wp.wavelength * config.crosswave_margin_wavelengths).max(config.min_margin_ft);

    WaveBounds {
        min_proj: min_proj - upwave,
        max_proj: max_proj + downwave,
        min_perp: min_perp - crosswave,
        max_perp: max_perp + crosswave,
    }
}
