/// Ray step physics — Snell's law refraction, energy dissipation, turbulence.
/// Mirrors rayStepPhysics.ts.

use crate::config::MeshBuildPhysicsConfig;
use crate::level::TerrainCPUData;
use crate::terrain::{compute_terrain_height_and_gradient, ParsedContour};

fn normalized_speed(depth: f64, k: f64) -> f64 {
    if depth <= 0.0 { return 0.0; }
    (k * depth).tanh().sqrt()
}

pub struct SentinelResult {
    pub nx: f64,
    pub ny: f64,
}

pub fn advance_sentinel_ray(
    px: f64, py: f64,
    wave_dx: f64, wave_dy: f64,
    step_size: f64,
    min_proj: f64, max_proj: f64,
) -> Option<SentinelResult> {
    let nx = px + wave_dx * step_size;
    let ny = py + wave_dy * step_size;
    let proj = nx * wave_dx + ny * wave_dy;
    if proj < min_proj || proj > max_proj { return None; }
    Some(SentinelResult { nx, ny })
}

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
    pub refracted: bool,
    pub turn_clamped: bool,
}

#[allow(clippy::too_many_arguments)]
pub fn advance_interior_ray(
    px: f64, py: f64,
    start_energy: f64,
    prev_turbulence: f64,
    base_dir_x: f64, base_dir_y: f64,
    wave_dx: f64, wave_dy: f64,
    perp_dx: f64, perp_dy: f64,
    min_proj: f64, max_proj: f64,
    min_perp: f64, max_perp: f64,
    step_size: f64,
    wavelength: f64,
    k: f64,
    breaking_depth: f64,
    physics: &MeshBuildPhysicsConfig,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    current_depth: f64,
    current_grad_x: f64,
    current_grad_y: f64,
) -> Option<InteriorRayResult> {
    let mut depth = current_depth;
    let mut grad_x = current_grad_x;
    let mut grad_y = current_grad_y;

    if !depth.is_finite() || !grad_x.is_finite() || !grad_y.is_finite() {
        let thg = compute_terrain_height_and_gradient(px, py, terrain, contours);
        depth = (-thg.height).max(0.0);
        grad_x = thg.gradient_x;
        grad_y = thg.gradient_y;
    }

    let base_speed = normalized_speed(depth, k);
    let current_speed = physics.min_speed_factor.max(base_speed);
    let local_step = step_size * current_speed;

    let mut dir_x = base_dir_x;
    let mut dir_y = base_dir_y;
    let mut abs_d_theta = 0.0;
    let mut refracted = false;
    let mut turn_clamped = false;

    if depth > 0.0 {
        let tanh_kd = base_speed * base_speed;
        let sech2_kd = 1.0 - tanh_kd * tanh_kd;
        let dc_d_depth = if base_speed > 1e-6 { (k * sech2_kd) / (2.0 * base_speed) } else { 0.0 };
        let dcdx = -dc_d_depth * grad_x;
        let dcdy = -dc_d_depth * grad_y;
        let dc_perp = -dcdx * dir_y + dcdy * dir_x;
        let raw_d_theta = -(1.0 / current_speed) * dc_perp * local_step;
        let d_theta = raw_d_theta.clamp(-physics.max_turn_per_step_rad, physics.max_turn_per_step_rad);
        abs_d_theta = d_theta.abs();
        refracted = true;
        if raw_d_theta.abs() > physics.max_turn_per_step_rad {
            turn_clamped = true;
        }
        let cos_d = d_theta.cos();
        let sin_d = d_theta.sin();
        dir_x = base_dir_x * cos_d - base_dir_y * sin_d;
        dir_y = base_dir_x * sin_d + base_dir_y * cos_d;
    }

    let nx = px + dir_x * local_step;
    let ny = py + dir_y * local_step;

    let proj = nx * wave_dx + ny * wave_dy;
    let perp = nx * perp_dx + ny * perp_dy;
    if proj < min_proj || proj > max_proj || perp < min_perp || perp > max_perp {
        return None;
    }

    let new_thg = compute_terrain_height_and_gradient(nx, ny, terrain, contours);
    let new_depth = -new_thg.height;
    let normalized_step = local_step / wavelength;

    let mut energy = start_energy;

    if abs_d_theta > 0.0 {
        energy *= (-physics.refraction_dissipation * abs_d_theta).exp();
    }

    let energy_before = energy;
    if new_depth < wavelength {
        let friction = physics.bottom_friction_rate * (-k * new_depth).exp() * normalized_step;
        energy *= (-friction).exp();
        if new_depth < breaking_depth {
            energy *= (-physics.breaking_decay_rate * normalized_step).exp();
        }
    }

    let carry = prev_turbulence * (-physics.turbulence_decay_rate * normalized_step).exp();
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
        refracted,
        turn_clamped,
    })
}
