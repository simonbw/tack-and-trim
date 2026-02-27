/// All configuration for the wave-mesh builder, mirroring meshBuildConfig.ts.

#[derive(Clone, Debug)]
pub struct MeshBuildResolutionConfig {
    pub step_size_ft: f64,
    pub vertex_spacing_ft: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildBoundsConfig {
    pub upwave_margin_wavelengths: f64,
    pub downwave_margin_wavelengths: f64,
    pub crosswave_margin_wavelengths: f64,
    pub min_margin_ft: f64,
    pub fallback_half_extent_ft: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildPhysicsConfig {
    pub min_speed_factor: f64,
    pub max_turn_per_step_rad: f64,
    pub refraction_dissipation: f64,
    pub bottom_friction_rate: f64,
    pub breaking_depth_ratio: f64,
    pub breaking_decay_rate: f64,
    pub turbulence_decay_rate: f64,
    pub turbulence_scale: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildRefinementConfig {
    pub merge_ratio: f64,
    pub base_split_ratio: f64,
    pub max_split_ratio: f64,
    pub split_escalation: f64,
    pub max_segment_points: usize,
    pub max_splits_per_segment: usize,
    pub min_energy: f64,
    pub max_energy_ratio: f64,
    pub min_split_energy: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildPostConfig {
    pub max_amplification: f64,
    pub diffraction_iterations: usize,
    pub max_diffusion_d: f64,
    pub turbulence_diffusion_iterations: usize,
    pub turbulence_diffusion_d: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildDecimationConfig {
    pub tolerance: f64,
}

#[derive(Clone, Debug)]
pub struct MeshBuildConfig {
    pub resolution: MeshBuildResolutionConfig,
    pub bounds: MeshBuildBoundsConfig,
    pub physics: MeshBuildPhysicsConfig,
    pub refinement: MeshBuildRefinementConfig,
    pub post: MeshBuildPostConfig,
    pub decimation: MeshBuildDecimationConfig,
}

macro_rules! env_override {
    ($field:expr, $env_name:expr, $parse:ty) => {
        if let Ok(val) = std::env::var($env_name) {
            if let Ok(parsed) = val.parse::<$parse>() {
                $field = parsed as _;
            }
        }
    };
}

pub fn resolve_config() -> MeshBuildConfig {
    let mut config = MeshBuildConfig {
        resolution: MeshBuildResolutionConfig {
            step_size_ft: 10.0,
            vertex_spacing_ft: 20.0,
        },
        bounds: MeshBuildBoundsConfig {
            upwave_margin_wavelengths: 2.0,
            downwave_margin_wavelengths: 10.0,
            crosswave_margin_wavelengths: 5.0,
            min_margin_ft: 200.0,
            fallback_half_extent_ft: 5000.0,
        },
        physics: MeshBuildPhysicsConfig {
            min_speed_factor: 0.05,
            max_turn_per_step_rad: std::f64::consts::PI / 8.0,
            refraction_dissipation: 0.3,
            bottom_friction_rate: 2.0,
            breaking_depth_ratio: 0.06,
            breaking_decay_rate: 3.0,
            turbulence_decay_rate: 0.5,
            turbulence_scale: 0.8,
        },
        refinement: MeshBuildRefinementConfig {
            merge_ratio: 0.3,
            base_split_ratio: 2.0,
            max_split_ratio: 5.0,
            split_escalation: 1.4,
            max_segment_points: 50000,
            max_splits_per_segment: 500,
            min_energy: 0.005,
            max_energy_ratio: 100.0,
            min_split_energy: 0.01,
        },
        post: MeshBuildPostConfig {
            max_amplification: 4.0,
            diffraction_iterations: 3,
            max_diffusion_d: 0.4,
            turbulence_diffusion_iterations: 2,
            turbulence_diffusion_d: 0.3,
        },
        decimation: MeshBuildDecimationConfig {
            tolerance: 0.08,
        },
    };

    env_override!(config.resolution.step_size_ft, "MESH_BUILD_STEP_SIZE_FT", f64);
    env_override!(config.resolution.vertex_spacing_ft, "MESH_BUILD_VERTEX_SPACING_FT", f64);
    env_override!(config.decimation.tolerance, "MESH_BUILD_DECIMATION_TOLERANCE", f64);
    env_override!(config.physics.max_turn_per_step_rad, "MESH_BUILD_MAX_TURN_PER_STEP_RAD", f64);
    env_override!(config.refinement.min_energy, "MESH_BUILD_MIN_ENERGY", f64);
    env_override!(config.refinement.max_energy_ratio, "MESH_BUILD_MAX_ENERGY_RATIO", f64);
    env_override!(config.post.diffraction_iterations, "MESH_BUILD_DIFFRACTION_ITERATIONS", usize);
    env_override!(config.post.max_diffusion_d, "MESH_BUILD_MAX_DIFFUSION_D", f64);

    config
}
