//! Ray step physics — Snell's law refraction, energy dissipation, turbulence.
//! Mirrors rayStepPhysics.ts.

use crate::config::MeshBuildPhysicsConfig;
use crate::level::TerrainCPUData;
use crate::terrain::{compute_terrain_height_and_gradient, ContourLookupGrid, ParsedContour};
use crate::wavefront::{WaveBounds, WaveParams};

/// Current state of a ray being advanced through the wave field.
pub struct RayState {
    pub x: f64,
    pub y: f64,
    pub energy: f64,
    pub turbulence: f64,
    pub dir_x: f64,
    pub dir_y: f64,
    pub depth: f64,
    pub terrain_grad_x: f64,
    pub terrain_grad_y: f64,
}

fn normalized_speed(depth: f64, k: f64) -> f64 {
    if depth <= 0.0 {
        return 0.0;
    }
    (k * depth).tanh().sqrt()
}

/// Result of advancing a sentinel (boundary) ray by one step.
pub struct SentinelResult {
    pub nx: f64,
    pub ny: f64,
}

/// Advance a sentinel ray one step along the wave direction.
pub fn advance_sentinel_ray(
    px: f64,
    py: f64,
    wp: &WaveParams,
    bounds: &WaveBounds,
) -> Option<SentinelResult> {
    let nx = px + wp.wave_dx * wp.step_size;
    let ny = py + wp.wave_dy * wp.step_size;
    let proj = nx * wp.wave_dx + ny * wp.wave_dy;
    if proj < bounds.min_proj || proj > bounds.max_proj {
        return None;
    }
    Some(SentinelResult { nx, ny })
}

/// Result of advancing an interior ray by one physics step.
pub struct InteriorRayResult {
    pub nx: f64,
    pub ny: f64,
    pub dir_x: f64,
    pub dir_y: f64,
    pub energy: f64,
    pub turbulence: f64,
    pub depth: f64,
    pub terrain_grad_x: f64,
    pub terrain_grad_y: f64,
}

/// Advance an interior ray one step: refraction, position update, energy dissipation.
pub fn advance_interior_ray(
    ray: &RayState,
    wp: &WaveParams,
    bounds: &WaveBounds,
    breaking_depth: f64,
    physics: &MeshBuildPhysicsConfig,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
) -> Option<InteriorRayResult> {
    let mut depth = ray.depth;
    let mut grad_x = ray.terrain_grad_x;
    let mut grad_y = ray.terrain_grad_y;

    if !depth.is_finite() || !grad_x.is_finite() || !grad_y.is_finite() {
        let thg = compute_terrain_height_and_gradient(ray.x, ray.y, terrain, contours, lookup_grid);
        depth = (-thg.height).max(0.0);
        grad_x = thg.gradient_x;
        grad_y = thg.gradient_y;
    }

    let base_speed = normalized_speed(depth, wp.k);
    let current_speed = physics.min_speed_factor.max(base_speed);
    let local_step = wp.step_size * current_speed;

    let mut dir_x = ray.dir_x;
    let mut dir_y = ray.dir_y;
    let mut abs_d_theta = 0.0;

    if depth > 0.0 {
        let tanh_kd = base_speed * base_speed;
        let sech2_kd = 1.0 - tanh_kd * tanh_kd;
        let dc_d_depth = if base_speed > 1e-6 {
            (wp.k * sech2_kd) / (2.0 * base_speed)
        } else {
            0.0
        };
        let dcdx = -dc_d_depth * grad_x;
        let dcdy = -dc_d_depth * grad_y;
        let dc_perp = -dcdx * dir_y + dcdy * dir_x;
        let raw_d_theta = -(1.0 / current_speed) * dc_perp * local_step;
        let d_theta = raw_d_theta.clamp(
            -physics.max_turn_per_step_rad,
            physics.max_turn_per_step_rad,
        );
        abs_d_theta = d_theta.abs();
        let cos_d = d_theta.cos();
        let sin_d = d_theta.sin();
        dir_x = ray.dir_x * cos_d - ray.dir_y * sin_d;
        dir_y = ray.dir_x * sin_d + ray.dir_y * cos_d;
    }

    let nx = ray.x + dir_x * local_step;
    let ny = ray.y + dir_y * local_step;

    let proj = nx * wp.wave_dx + ny * wp.wave_dy;
    let perp = nx * wp.perp_dx + ny * wp.perp_dy;
    if proj < bounds.min_proj
        || proj > bounds.max_proj
        || perp < bounds.min_perp
        || perp > bounds.max_perp
    {
        return None;
    }

    let new_thg = compute_terrain_height_and_gradient(nx, ny, terrain, contours, lookup_grid);
    let new_depth = -new_thg.height;
    let normalized_step = local_step / wp.wavelength;

    let mut energy = ray.energy;

    if abs_d_theta > 0.0 {
        energy *= (-physics.refraction_dissipation * abs_d_theta).exp();
    }

    let energy_before = energy;
    if new_depth < wp.wavelength {
        let friction = physics.bottom_friction_rate * (-wp.k * new_depth).exp() * normalized_step;
        energy *= (-friction).exp();
        if new_depth < breaking_depth {
            energy *= (-physics.breaking_decay_rate * normalized_step).exp();
        }
    }

    let carry = ray.turbulence * (-physics.turbulence_decay_rate * normalized_step).exp();
    let local_turb = (energy_before - energy) * physics.turbulence_scale;
    let turbulence = carry + local_turb;

    Some(InteriorRayResult {
        nx,
        ny,
        dir_x,
        dir_y,
        energy,
        turbulence,
        depth: new_depth.max(0.0),
        terrain_grad_x: new_thg.gradient_x,
        terrain_grad_y: new_thg.gradient_y,
    })
}
