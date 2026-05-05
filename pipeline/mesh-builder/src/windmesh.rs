use pipeline_core::level::TerrainCPUData;
use pipeline_core::terrain::{compute_terrain_height_and_gradient, parse_contours};

pub const WIND_VERTEX_FLOATS: usize = 5;

// ── Configuration ────────────────────────────────────────────────────────────

/// Tunable parameters for the wind mesh marching algorithm.
struct WindMeshConfig {
    /// Spacing between adjacent rays (cross-axis), and output vertex spacing
    /// along the march axis. Controls output mesh density.
    ray_spacing: f64,
    /// Fine march step for physics integration. Multiple march steps may be
    /// taken per output vertex row.
    march_step: f64,
    /// How strongly terrain gradient deflects rays laterally.
    terrain_force_scale: f64,
    /// Spring constant for neighbor pressure between adjacent rays.
    spring_k: f64,
    /// Lateral velocity damping per march step (0.9–0.99).
    damping: f64,
    /// Domain margin beyond terrain AABB (ft).
    margin: f64,
    /// Minimum allowed gap between adjacent rays (ft).
    min_ray_gap: f64,
    /// Cap on speed-up factor from ray compression.
    max_speed_factor: f64,
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

impl WindMeshConfig {
    fn resolve() -> Self {
        let mut c = Self {
            ray_spacing: 200.0,
            march_step: 50.0,
            terrain_force_scale: 0.005,
            spring_k: 0.001,
            damping: 0.95,
            margin: 500.0,
            min_ray_gap: 10.0,
            max_speed_factor: 3.0,
        };
        env_override!(c.ray_spacing, "WIND_RAY_SPACING", f64);
        env_override!(c.march_step, "WIND_MARCH_STEP", f64);
        env_override!(c.terrain_force_scale, "WIND_TERRAIN_FORCE_SCALE", f64);
        env_override!(c.spring_k, "WIND_SPRING_K", f64);
        env_override!(c.damping, "WIND_DAMPING", f64);
        env_override!(c.margin, "WIND_MARGIN", f64);
        env_override!(c.min_ray_gap, "WIND_MIN_RAY_GAP", f64);
        env_override!(c.max_speed_factor, "WIND_MAX_SPEED_FACTOR", f64);
        c
    }
}

// ── Per-ray state ────────────────────────────────────────────────────────────

struct WindRay {
    x: f64,
    y: f64,
    lateral_velocity: f64,
}

// ── Output ───────────────────────────────────────────────────────────────────

pub struct WindMeshData {
    pub direction: f64,
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub vertex_count: usize,
    pub index_count: usize,
    pub grid_cols: usize,
    pub grid_rows: usize,
    pub grid_min_x: f64,
    pub grid_min_y: f64,
    pub grid_cell_width: f64,
    pub grid_cell_height: f64,
}

const MIN_SPEED_FACTOR: f64 = 0.1;

// ── Marching algorithm ───────────────────────────────────────────────────────

pub fn build_wind_grid(
    terrain: &TerrainCPUData,
    _grid_spacing: f64,
    wind_direction: f64,
) -> WindMeshData {
    let config = WindMeshConfig::resolve();
    let (contours, lookup_grid) = parse_contours(terrain);

    // Compute terrain AABB + margin
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    let vert_count = terrain.vertex_data.len() / 2;
    for i in 0..vert_count {
        let x = terrain.vertex_data[i * 2] as f64;
        let y = terrain.vertex_data[i * 2 + 1] as f64;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    min_x -= config.margin;
    min_y -= config.margin;
    max_x += config.margin;
    max_y += config.margin;

    let width = max_x - min_x;
    let height = max_y - min_y;
    let cx = (min_x + max_x) / 2.0;
    let cy = (min_y + max_y) / 2.0;

    // Use AABB diagonal so all wind directions produce the same ray/step counts
    // (required for shared indices in the windmesh file format).
    let diagonal = (width * width + height * height).sqrt();
    let half_extent = diagonal / 2.0;

    // Wind-aligned coordinate system
    let march_dx = wind_direction.cos();
    let march_dy = wind_direction.sin();
    let perp_dx = -march_dy; // perpendicular, "right" when facing downwind
    let perp_dy = march_dx;

    // Output mesh dimensions: ray_spacing controls both cross and march vertex density
    let num_rays = (diagonal / config.ray_spacing).ceil() as usize + 1;
    let equilibrium_spacing = if num_rays > 1 {
        diagonal / (num_rays - 1) as f64
    } else {
        diagonal
    };

    // March at fine step for physics, output a vertex row every output_stride steps
    let output_stride = (config.ray_spacing / config.march_step).round().max(1.0) as usize;
    let num_march_steps = (diagonal / config.march_step).ceil() as usize;
    let num_output_rows = num_march_steps / output_stride + 1;

    eprintln!(
        "  Wind march: {} rays, {} march steps (stride {}), {} output rows",
        num_rays, num_march_steps, output_stride, num_output_rows
    );

    // Initialize rays at upwind edge
    let upwind_x = cx - march_dx * half_extent;
    let upwind_y = cy - march_dy * half_extent;

    let mut rays: Vec<WindRay> = (0..num_rays)
        .map(|i| {
            let cross_offset = -half_extent + i as f64 * equilibrium_spacing;
            WindRay {
                x: upwind_x + perp_dx * cross_offset,
                y: upwind_y + perp_dy * cross_offset,
                lateral_velocity: 0.0,
            }
        })
        .collect();

    let vertex_count = num_rays * num_output_rows;
    let mut vertices = Vec::with_capacity(vertex_count * WIND_VERTEX_FLOATS);
    let mut prev_spacings = vec![equilibrium_spacing; num_rays];

    // Record initial positions (step 0)
    record_vertices(
        &rays,
        &mut vertices,
        &mut prev_spacings,
        cx,
        cy,
        perp_dx,
        perp_dy,
        equilibrium_spacing,
        &config,
    );

    for step in 1..=num_march_steps {
        // Advance all rays one march step in the wind direction
        for ray in rays.iter_mut() {
            ray.x += march_dx * config.march_step;
            ray.y += march_dy * config.march_step;
        }

        // Compute forces on each ray
        let mut forces = vec![0.0f64; num_rays];

        // Terrain force: lateral gradient pushes rays away from rising terrain
        for (i, force) in forces.iter_mut().enumerate() {
            let thg = compute_terrain_height_and_gradient(
                rays[i].x,
                rays[i].y,
                terrain,
                &contours,
                &lookup_grid,
            );
            if thg.height > 0.0 {
                let lateral_grad = thg.gradient_x * perp_dx + thg.gradient_y * perp_dy;
                *force -= lateral_grad * thg.height * config.terrain_force_scale;
            }
        }

        // Neighbor pressure: springs between adjacent rays
        let cross_positions: Vec<f64> = rays
            .iter()
            .map(|r| (r.x - cx) * perp_dx + (r.y - cy) * perp_dy)
            .collect();

        for i in 0..num_rays {
            let left_spacing = if i > 0 {
                cross_positions[i] - cross_positions[i - 1]
            } else {
                equilibrium_spacing
            };
            let right_spacing = if i < num_rays - 1 {
                cross_positions[i + 1] - cross_positions[i]
            } else {
                equilibrium_spacing
            };

            // Pressure from left: positive when compressed, pushes ray rightward
            let f_left = config.spring_k * (equilibrium_spacing - left_spacing);
            // Pressure from right: positive when compressed, pushes ray leftward
            let f_right = config.spring_k * (equilibrium_spacing - right_spacing);
            forces[i] += f_left - f_right;
        }

        // Update lateral velocity and apply displacement
        for i in 0..num_rays {
            rays[i].lateral_velocity += forces[i];
            rays[i].lateral_velocity *= config.damping;
            rays[i].x += perp_dx * rays[i].lateral_velocity * config.march_step;
            rays[i].y += perp_dy * rays[i].lateral_velocity * config.march_step;
        }

        // Enforce no-crossing constraint (forward pass)
        for i in 1..num_rays {
            let cross_i = (rays[i].x - cx) * perp_dx + (rays[i].y - cy) * perp_dy;
            let cross_prev = (rays[i - 1].x - cx) * perp_dx + (rays[i - 1].y - cy) * perp_dy;
            if cross_i < cross_prev + config.min_ray_gap {
                let delta = cross_prev + config.min_ray_gap - cross_i;
                rays[i].x += perp_dx * delta;
                rays[i].y += perp_dy * delta;
                rays[i].lateral_velocity = 0.0;
            }
        }

        // Record vertices at output stride intervals
        if step % output_stride == 0 {
            record_vertices(
                &rays,
                &mut vertices,
                &mut prev_spacings,
                cx,
                cy,
                perp_dx,
                perp_dy,
                equilibrium_spacing,
                &config,
            );
        }
    }

    // If the last march step didn't align with the stride, record final positions
    let recorded_rows = vertices.len() / (num_rays * WIND_VERTEX_FLOATS);
    assert_eq!(
        recorded_rows, num_output_rows,
        "Expected {} output rows but recorded {}",
        num_output_rows, recorded_rows
    );

    // Triangulate: strip mesh between adjacent rays at consecutive output rows
    let index_count = 2 * (num_rays - 1) * (num_output_rows - 1) * 3;
    let mut indices = Vec::with_capacity(index_count);

    for row in 0..(num_output_rows - 1) {
        for ray in 0..(num_rays - 1) {
            let tl = (row * num_rays + ray) as u32;
            let tr = tl + 1;
            let bl = ((row + 1) * num_rays + ray) as u32;
            let br = bl + 1;

            indices.push(tl);
            indices.push(bl);
            indices.push(tr);

            indices.push(tr);
            indices.push(bl);
            indices.push(br);
        }
    }

    // Spatial grid metadata: consistent bounds across all wind directions.
    // The marched domain is a square of side `diagonal` rotated by the wind angle.
    // Its axis-aligned bounding box is at most diagonal * sqrt(2) on each side.
    let grid_side = diagonal * std::f64::consts::SQRT_2;
    let grid_half = grid_side / 2.0;
    let grid_min_x_val = cx - grid_half;
    let grid_min_y_val = cy - grid_half;
    let cell_size = config.ray_spacing * 2.0;
    let grid_cols = (grid_side / cell_size).ceil() as usize;
    let grid_rows = grid_cols; // square grid
    let grid_cell_width = grid_side / grid_cols as f64;
    let grid_cell_height = grid_side / grid_rows as f64;

    // Log summary statistics
    let mut sheltered_count = 0usize;
    let mut channeled_count = 0usize;
    let mut min_speed = f32::MAX;
    let mut max_speed = 0.0f32;
    let mut max_turbulence = 0.0f32;
    for i in 0..vertex_count {
        let sf = vertices[i * WIND_VERTEX_FLOATS + 2];
        let turb = vertices[i * WIND_VERTEX_FLOATS + 4];
        if sf < 0.99 {
            sheltered_count += 1;
        }
        if sf > 1.01 {
            channeled_count += 1;
        }
        if sf < min_speed {
            min_speed = sf;
        }
        if sf > max_speed {
            max_speed = sf;
        }
        if turb > max_turbulence {
            max_turbulence = turb;
        }
    }
    eprintln!(
        "  Wind result: {}/{} sheltered, {}/{} channeled, speed=[{:.3}, {:.3}], max turb={:.3}",
        sheltered_count,
        vertex_count,
        channeled_count,
        vertex_count,
        min_speed,
        max_speed,
        max_turbulence
    );

    WindMeshData {
        direction: wind_direction,
        vertices,
        indices,
        vertex_count,
        index_count,
        grid_cols,
        grid_rows,
        grid_min_x: grid_min_x_val,
        grid_min_y: grid_min_y_val,
        grid_cell_width,
        grid_cell_height,
    }
}

/// Record vertex attributes for all rays at the current march position.
fn record_vertices(
    rays: &[WindRay],
    vertices: &mut Vec<f32>,
    prev_spacings: &mut [f64],
    cx: f64,
    cy: f64,
    perp_dx: f64,
    perp_dy: f64,
    equilibrium_spacing: f64,
    config: &WindMeshConfig,
) {
    let num_rays = rays.len();

    // Compute cross-axis positions
    let cross_positions: Vec<f64> = rays
        .iter()
        .map(|r| (r.x - cx) * perp_dx + (r.y - cy) * perp_dy)
        .collect();

    for i in 0..num_rays {
        let left_spacing = if i > 0 {
            cross_positions[i] - cross_positions[i - 1]
        } else {
            equilibrium_spacing
        };
        let right_spacing = if i < num_rays - 1 {
            cross_positions[i + 1] - cross_positions[i]
        } else {
            equilibrium_spacing
        };
        let avg_spacing = if i > 0 && i < num_rays - 1 {
            (left_spacing + right_spacing) / 2.0
        } else if i > 0 {
            left_spacing
        } else {
            right_spacing
        };

        let speed_factor = (equilibrium_spacing / avg_spacing.max(config.min_ray_gap))
            .min(config.max_speed_factor)
            .max(MIN_SPEED_FACTOR);

        let direction_offset = rays[i].lateral_velocity.atan2(1.0);

        let spacing_change =
            ((avg_spacing - prev_spacings[i]).abs() / equilibrium_spacing).min(1.0);
        let lateral_turb = (rays[i].lateral_velocity.abs() * 0.5).min(1.0);
        let turbulence = (spacing_change * 0.5 + lateral_turb * 0.5).min(1.0);

        vertices.push(rays[i].x as f32);
        vertices.push(rays[i].y as f32);
        vertices.push(speed_factor as f32);
        vertices.push(direction_offset as f32);
        vertices.push(turbulence as f32);

        prev_spacings[i] = avg_spacing;
    }
}
