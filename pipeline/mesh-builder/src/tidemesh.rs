//! Tidal flow mesh builder: CDT mesh generation, FEM solver, velocity recovery.
//!
//! Builds an adaptive triangle mesh from terrain contours using Constrained
//! Delaunay Triangulation, solves for steady-state tidal flow using finite
//! elements, and produces per-vertex velocity fields for runtime sampling.

use pipeline_core::level::TerrainCPUData;
use pipeline_core::terrain::{compute_terrain_height, parse_contours, ContourLookupGrid, ParsedContour};

use nalgebra_sparse::CooMatrix;
use spade::{ConstrainedDelaunayTriangulation, Point2, Triangulation};

// ── Configuration ───────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct TidemeshConfig {
    pub tide_levels: Vec<f64>,
    pub min_depth_threshold: f64,
    pub decimation_velocity_tolerance: f64,
    pub domain_margin: f64,
}

pub fn resolve_tidemesh_config() -> TidemeshConfig {
    let mut config = TidemeshConfig {
        tide_levels: vec![-2.0, 0.0, 2.0],
        min_depth_threshold: 0.1,
        decimation_velocity_tolerance: 0.02,
        domain_margin: 500.0,
    };

    if let Ok(val) = std::env::var("TIDEMESH_MIN_DEPTH") {
        if let Ok(v) = val.parse::<f64>() {
            config.min_depth_threshold = v;
        }
    }
    if let Ok(val) = std::env::var("TIDEMESH_DECIMATION_TOLERANCE") {
        if let Ok(v) = val.parse::<f64>() {
            config.decimation_velocity_tolerance = v;
        }
    }
    if let Ok(val) = std::env::var("TIDEMESH_MARGIN") {
        if let Ok(v) = val.parse::<f64>() {
            config.domain_margin = v;
        }
    }

    config
}

// ── Output ──────────────────────────────────────────────────────────────────

pub struct TideMeshData {
    /// Vertex positions: x, y per vertex (2 f32s each)
    pub vertex_positions: Vec<f32>,
    /// Triangle indices: 3 per triangle
    pub indices: Vec<u32>,
    pub vertex_count: usize,
    pub triangle_count: usize,
    /// Per tide level flow data (flat): for each tide level, vertexCount * 4 f32s
    /// Layout: [vx_a, vy_a, vx_b, vy_b] per vertex
    pub flow_data: Vec<f32>,
    pub tide_levels: Vec<f64>,
    // Spatial grid
    pub grid_cols: usize,
    pub grid_rows: usize,
    pub grid_min_x: f64,
    pub grid_min_y: f64,
    pub grid_cell_width: f64,
    pub grid_cell_height: f64,
    pub grid_cell_offsets: Vec<u32>,
    pub grid_cell_counts: Vec<u32>,
    pub grid_triangle_lists: Vec<u32>,
}

// ── Main entry point ────────────────────────────────────────────────────────

pub fn build_tide_mesh(terrain: &TerrainCPUData, config: &TidemeshConfig) -> TideMeshData {
    let (contours, lookup_grid) = parse_contours(terrain);

    if contours.is_empty() {
        return empty_tide_mesh(&config.tide_levels);
    }

    // 1. Extract contour polylines
    let polylines = extract_contour_polylines(terrain, &contours);

    // 2. Compute domain bounds
    let (min_x, min_y, max_x, max_y) = compute_domain_bounds(terrain, config.domain_margin);

    // 3. Build CDT mesh
    let (vertices, triangles, boundary_verts) =
        build_cdt_mesh(&polylines, min_x, min_y, max_x, max_y);

    if vertices.is_empty() || triangles.is_empty() {
        return empty_tide_mesh(&config.tide_levels);
    }

    // 4. For each tide level, solve FEM
    let mut all_flow_data: Vec<f32> = Vec::new();
    let vertex_count = vertices.len();

    for &tide_height in &config.tide_levels {
        let (vel_a, vel_b) = solve_for_tide_level(
            &vertices,
            &triangles,
            &boundary_verts,
            terrain,
            &contours,
            &lookup_grid,
            tide_height,
            config.min_depth_threshold,
        );

        // Pack as vx_a, vy_a, vx_b, vy_b per vertex
        for i in 0..vertex_count {
            all_flow_data.push(vel_a[i * 2] as f32);
            all_flow_data.push(vel_a[i * 2 + 1] as f32);
            all_flow_data.push(vel_b[i * 2] as f32);
            all_flow_data.push(vel_b[i * 2 + 1] as f32);
        }
    }

    // 5. Build spatial grid
    let vertex_positions: Vec<f32> = vertices
        .iter()
        .flat_map(|v| [v[0] as f32, v[1] as f32])
        .collect();

    let indices: Vec<u32> = triangles
        .iter()
        .flat_map(|t| [t[0] as u32, t[1] as u32, t[2] as u32])
        .collect();

    let triangle_count = triangles.len();
    let (grid_cols, grid_rows, grid_min_x, grid_min_y, grid_cell_width, grid_cell_height, grid_cell_offsets, grid_cell_counts, grid_triangle_lists) =
        build_spatial_grid(&vertices, &triangles, min_x, min_y, max_x, max_y);

    TideMeshData {
        vertex_positions,
        indices,
        vertex_count,
        triangle_count,
        flow_data: all_flow_data,
        tide_levels: config.tide_levels.clone(),
        grid_cols,
        grid_rows,
        grid_min_x,
        grid_min_y,
        grid_cell_width,
        grid_cell_height,
        grid_cell_offsets,
        grid_cell_counts,
        grid_triangle_lists,
    }
}

// ── Contour extraction ──────────────────────────────────────────────────────

struct ContourPolyline {
    points: Vec<[f64; 2]>,
}

fn extract_contour_polylines(
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
) -> Vec<ContourPolyline> {
    let mut polylines = Vec::new();
    for c in contours {
        let mut points = Vec::with_capacity(c.point_count);
        for i in 0..c.point_count {
            let idx = (c.point_start + i) * 2;
            if idx + 1 < terrain.vertex_data.len() {
                let x = terrain.vertex_data[idx] as f64;
                let y = terrain.vertex_data[idx + 1] as f64;
                points.push([x, y]);
            }
        }
        if points.len() >= 3 {
            polylines.push(ContourPolyline { points });
        }
    }
    polylines
}

// ── Domain bounds ───────────────────────────────────────────────────────────

fn compute_domain_bounds(terrain: &TerrainCPUData, margin: f64) -> (f64, f64, f64, f64) {
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

    (min_x - margin, min_y - margin, max_x + margin, max_y + margin)
}

// ── CDT mesh generation ─────────────────────────────────────────────────────

fn build_cdt_mesh(
    polylines: &[ContourPolyline],
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
) -> (Vec<[f64; 2]>, Vec<[usize; 3]>, Vec<bool>) {
    let mut cdt = ConstrainedDelaunayTriangulation::<Point2<f64>>::new();

    // Minimum distance between points to avoid degenerate triangles
    const MIN_DIST_SQ: f64 = 0.5 * 0.5;

    // Track all inserted points for de-duplication
    let mut inserted_points: Vec<[f64; 2]> = Vec::new();

    // Helper: find or insert a point, returning its vertex handle
    let find_or_insert =
        |cdt: &mut ConstrainedDelaunayTriangulation<Point2<f64>>,
         inserted: &mut Vec<[f64; 2]>,
         x: f64,
         y: f64| {
            // Check for near-duplicate
            for (idx, p) in inserted.iter().enumerate() {
                let dx = p[0] - x;
                let dy = p[1] - y;
                if dx * dx + dy * dy < MIN_DIST_SQ {
                    // Return existing handle
                    let handles: Vec<_> = cdt.vertices().map(|v| v.fix()).collect();
                    if idx < handles.len() {
                        return handles[idx];
                    }
                }
            }
            let handle = cdt.insert(Point2::new(x, y)).expect("CDT insert failed");
            inserted.push([x, y]);
            handle
        };

    // Insert contour vertices and constraints
    for polyline in polylines {
        let mut handles = Vec::with_capacity(polyline.points.len());
        for &[x, y] in &polyline.points {
            let handle = find_or_insert(&mut cdt, &mut inserted_points, x, y);
            handles.push(handle);
        }

        // Add constraint edges along the contour
        for i in 0..handles.len() {
            let j = (i + 1) % handles.len();
            if handles[i] != handles[j] {
                let _ = cdt.add_constraint(handles[i], handles[j]);
            }
        }
    }

    // Insert boundary rectangle
    let boundary_handles = [
        find_or_insert(&mut cdt, &mut inserted_points, min_x, min_y),
        find_or_insert(&mut cdt, &mut inserted_points, max_x, min_y),
        find_or_insert(&mut cdt, &mut inserted_points, max_x, max_y),
        find_or_insert(&mut cdt, &mut inserted_points, min_x, max_y),
    ];

    // Add boundary constraint edges
    for i in 0..4 {
        let j = (i + 1) % 4;
        if boundary_handles[i] != boundary_handles[j] {
            let _ = cdt.add_constraint(boundary_handles[i], boundary_handles[j]);
        }
    }

    // Extract vertices
    let vertices: Vec<[f64; 2]> = cdt
        .vertices()
        .map(|v| {
            let p = v.position();
            [p.x, p.y]
        })
        .collect();

    // Build handle-to-index map
    let handle_to_index: std::collections::HashMap<_, _> = cdt
        .vertices()
        .enumerate()
        .map(|(i, v)| (v.fix(), i))
        .collect();

    // Extract triangles
    let triangles: Vec<[usize; 3]> = cdt
        .inner_faces()
        .map(|face| {
            let vs = face.vertices();
            [
                handle_to_index[&vs[0].fix()],
                handle_to_index[&vs[1].fix()],
                handle_to_index[&vs[2].fix()],
            ]
        })
        .collect();

    // Identify boundary vertices (on domain rectangle edges)
    let boundary_verts: Vec<bool> = vertices
        .iter()
        .map(|v| {
            let eps = 1.0;
            (v[0] - min_x).abs() < eps
                || (v[0] - max_x).abs() < eps
                || (v[1] - min_y).abs() < eps
                || (v[1] - max_y).abs() < eps
        })
        .collect();

    (vertices, triangles, boundary_verts)
}

// ── FEM solver ──────────────────────────────────────────────────────────────

fn solve_for_tide_level(
    vertices: &[[f64; 2]],
    triangles: &[[usize; 3]],
    boundary_verts: &[bool],
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    _lookup_grid: &ContourLookupGrid,
    tide_height: f64,
    min_depth: f64,
) -> (Vec<f64>, Vec<f64>) {
    let n = vertices.len();

    // Compute depth at each vertex
    let depths: Vec<f64> = vertices
        .iter()
        .map(|v| {
            let terrain_h = compute_terrain_height(v[0], v[1], terrain, contours);
            tide_height - terrain_h
        })
        .collect();

    // Classify vertices
    let is_dry: Vec<bool> = depths.iter().map(|&d| d <= min_depth).collect();

    // Free DOFs: interior wet vertices
    let mut free_indices: Vec<usize> = Vec::new();
    let mut vertex_to_free: Vec<Option<usize>> = vec![None; n];
    for i in 0..n {
        if !is_dry[i] && !boundary_verts[i] {
            vertex_to_free[i] = Some(free_indices.len());
            free_indices.push(i);
        }
    }

    let n_free = free_indices.len();
    if n_free == 0 {
        // No free DOFs — return zero velocity
        return (vec![0.0; n * 2], vec![0.0; n * 2]);
    }

    // Normalize domain for BC values
    let (domain_min_x, domain_min_y, domain_max_x, domain_max_y) = {
        let mut mnx = f64::INFINITY;
        let mut mny = f64::INFINITY;
        let mut mxx = f64::NEG_INFINITY;
        let mut mxy = f64::NEG_INFINITY;
        for v in vertices {
            mnx = mnx.min(v[0]);
            mny = mny.min(v[1]);
            mxx = mxx.max(v[0]);
            mxy = mxy.max(v[1]);
        }
        (mnx, mny, mxx, mxy)
    };
    let domain_w = (domain_max_x - domain_min_x).max(1.0);
    let domain_h = (domain_max_y - domain_min_y).max(1.0);

    // Solve twice: field A (N-S) and field B (E-W)
    let vel_a = solve_one_field(
        vertices,
        triangles,
        &depths,
        &is_dry,
        boundary_verts,
        &vertex_to_free,
        &free_indices,
        n_free,
        min_depth,
        // Field A: psi = normalized y on boundary, 0 on dry
        |i| {
            if is_dry[i] {
                0.0
            } else if boundary_verts[i] {
                (vertices[i][1] - domain_min_y) / domain_h * 2.0 - 1.0
            } else {
                0.0 // free — will be solved
            }
        },
    );

    let vel_b = solve_one_field(
        vertices,
        triangles,
        &depths,
        &is_dry,
        boundary_verts,
        &vertex_to_free,
        &free_indices,
        n_free,
        min_depth,
        // Field B: psi = normalized x on boundary, 0 on dry
        |i| {
            if is_dry[i] {
                0.0
            } else if boundary_verts[i] {
                (vertices[i][0] - domain_min_x) / domain_w * 2.0 - 1.0
            } else {
                0.0
            }
        },
    );

    (vel_a, vel_b)
}

fn solve_one_field(
    vertices: &[[f64; 2]],
    triangles: &[[usize; 3]],
    depths: &[f64],
    is_dry: &[bool],
    _boundary_verts: &[bool],
    vertex_to_free: &[Option<usize>],
    free_indices: &[usize],
    n_free: usize,
    min_depth: f64,
    bc_value: impl Fn(usize) -> f64,
) -> Vec<f64> {
    let n = vertices.len();

    // Prescribed values for all fixed vertices
    let psi_fixed: Vec<f64> = (0..n).map(|i| bc_value(i)).collect();

    // Assemble stiffness matrix (only free-free block) and RHS
    let mut triplets: Vec<(usize, usize, f64)> = Vec::new();
    let mut rhs = vec![0.0; n_free];

    for tri in triangles {
        let [i0, i1, i2] = *tri;

        // Skip fully dry triangles
        if is_dry[i0] && is_dry[i1] && is_dry[i2] {
            continue;
        }

        let v0 = vertices[i0];
        let v1 = vertices[i1];
        let v2 = vertices[i2];

        // Triangle area
        let area = 0.5
            * ((v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1]));
        let area_abs = area.abs();
        if area_abs < 1e-10 {
            continue; // degenerate
        }

        // Average depth (clamped)
        let h_avg = ((depths[i0] + depths[i1] + depths[i2]) / 3.0).max(min_depth);

        // Gradient basis functions for P1 elements:
        // grad(N_i) = (1/(2*area)) * [y_j - y_k, x_k - x_j]
        let local = [i0, i1, i2];
        let mut grad = [[0.0f64; 2]; 3];
        let inv2a = 1.0 / (2.0 * area);
        grad[0] = [
            (v1[1] - v2[1]) * inv2a,
            (v2[0] - v1[0]) * inv2a,
        ];
        grad[1] = [
            (v2[1] - v0[1]) * inv2a,
            (v0[0] - v2[0]) * inv2a,
        ];
        grad[2] = [
            (v0[1] - v1[1]) * inv2a,
            (v1[0] - v0[0]) * inv2a,
        ];

        // Element stiffness: K_e[a][b] = h_avg * area_abs * dot(grad_a, grad_b)
        for a in 0..3 {
            let gi = local[a];
            for b in 0..3 {
                let gj = local[b];
                let k_val =
                    h_avg * area_abs * (grad[a][0] * grad[b][0] + grad[a][1] * grad[b][1]);

                let fi = vertex_to_free[gi];
                let fj = vertex_to_free[gj];

                match (fi, fj) {
                    (Some(fi), Some(fj)) => {
                        // Both free: add to stiffness matrix
                        triplets.push((fi, fj, k_val));
                    }
                    (Some(fi), None) => {
                        // i is free, j is fixed: contribute to RHS
                        rhs[fi] -= k_val * psi_fixed[gj];
                    }
                    _ => {
                        // i is fixed: skip
                    }
                }
            }
        }
    }

    // Build sparse matrix and solve
    let psi_free = if n_free > 0 && !triplets.is_empty() {
        let mut coo = CooMatrix::new(n_free, n_free);
        for (r, c, v) in &triplets {
            coo.push(*r, *c, *v);
        }
        let csc: nalgebra_sparse::CscMatrix<f64> = (&coo).into();

        // Use Cholesky factorization
        match nalgebra_sparse::factorization::CscCholesky::factor(&csc) {
            Ok(cholesky) => {
                let rhs_vec = nalgebra::DVector::from_vec(rhs);
                let solution = cholesky.solve(&rhs_vec);
                solution.as_slice().to_vec()
            }
            Err(_) => {
                // Fallback: return zeros if Cholesky fails (e.g., matrix not SPD)
                eprintln!(
                    "Warning: Cholesky factorization failed for tide mesh solve. \
                     Returning zero flow for this field."
                );
                vec![0.0; n_free]
            }
        }
    } else {
        vec![0.0; n_free]
    };

    // Reconstruct full psi vector
    let mut psi = psi_fixed.clone();
    for (fi, &gi) in free_indices.iter().enumerate() {
        psi[gi] = psi_free[fi];
    }

    // Recover velocity per triangle, then smooth to vertices
    let mut vel_x_sum = vec![0.0; n];
    let mut vel_y_sum = vec![0.0; n];
    let mut area_sum = vec![0.0; n];

    for tri in triangles {
        let [i0, i1, i2] = *tri;

        if is_dry[i0] && is_dry[i1] && is_dry[i2] {
            continue;
        }

        let v0 = vertices[i0];
        let v1 = vertices[i1];
        let v2 = vertices[i2];

        let area = 0.5
            * ((v1[0] - v0[0]) * (v2[1] - v0[1]) - (v2[0] - v0[0]) * (v1[1] - v0[1]));
        let area_abs = area.abs();
        if area_abs < 1e-10 {
            continue;
        }

        let h_avg = ((depths[i0] + depths[i1] + depths[i2]) / 3.0).max(min_depth);
        let inv2a = 1.0 / (2.0 * area);

        // grad(N_i) for computing dpsi/dx and dpsi/dy
        let grad0 = [(v1[1] - v2[1]) * inv2a, (v2[0] - v1[0]) * inv2a];
        let grad1 = [(v2[1] - v0[1]) * inv2a, (v0[0] - v2[0]) * inv2a];
        let grad2 = [(v0[1] - v1[1]) * inv2a, (v1[0] - v0[0]) * inv2a];

        // dpsi/dx = sum psi_i * grad_i_x
        let dpsi_dx =
            psi[i0] * grad0[0] + psi[i1] * grad1[0] + psi[i2] * grad2[0];
        let dpsi_dy =
            psi[i0] * grad0[1] + psi[i1] * grad1[1] + psi[i2] * grad2[1];

        // Velocity from stream function: vx = (1/h) * dpsi/dy, vy = -(1/h) * dpsi/dx
        let vx = dpsi_dy / h_avg;
        let vy = -dpsi_dx / h_avg;

        // Area-weighted accumulation for vertex averaging
        for &vi in &[i0, i1, i2] {
            vel_x_sum[vi] += vx * area_abs;
            vel_y_sum[vi] += vy * area_abs;
            area_sum[vi] += area_abs;
        }
    }

    // Average and normalize
    let mut velocity = vec![0.0; n * 2];
    let mut max_mag = 0.0f64;

    for i in 0..n {
        if area_sum[i] > 0.0 {
            velocity[i * 2] = vel_x_sum[i] / area_sum[i];
            velocity[i * 2 + 1] = vel_y_sum[i] / area_sum[i];
            let mag = (velocity[i * 2].powi(2) + velocity[i * 2 + 1].powi(2)).sqrt();
            max_mag = max_mag.max(mag);
        }
    }

    // Normalize to unit max magnitude
    if max_mag > 1e-10 {
        for v in &mut velocity {
            *v /= max_mag;
        }
    }

    velocity
}

// ── Spatial grid ────────────────────────────────────────────────────────────

#[allow(clippy::type_complexity)]
fn build_spatial_grid(
    vertices: &[[f64; 2]],
    triangles: &[[usize; 3]],
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
) -> (
    usize,
    usize,
    f64,
    f64,
    f64,
    f64,
    Vec<u32>,
    Vec<u32>,
    Vec<u32>,
) {
    let tri_count = triangles.len();
    if tri_count == 0 {
        return (1, 1, min_x, min_y, max_x - min_x, max_y - min_y, vec![0], vec![0], vec![]);
    }

    // Target ~4 triangles per cell
    let domain_area = (max_x - min_x) * (max_y - min_y);
    let cell_area = (domain_area / tri_count as f64) * 4.0;
    let cell_size = cell_area.sqrt().max(1.0);

    let cols = ((max_x - min_x) / cell_size).ceil() as usize;
    let rows = ((max_y - min_y) / cell_size).ceil() as usize;
    let cols = cols.max(1).min(1024);
    let rows = rows.max(1).min(1024);

    let cell_w = (max_x - min_x) / cols as f64;
    let cell_h = (max_y - min_y) / rows as f64;

    // Assign triangles to cells
    let cell_count = cols * rows;
    let mut cell_lists: Vec<Vec<u32>> = vec![Vec::new(); cell_count];

    for (ti, tri) in triangles.iter().enumerate() {
        let v0 = vertices[tri[0]];
        let v1 = vertices[tri[1]];
        let v2 = vertices[tri[2]];

        // Triangle AABB
        let t_min_x = v0[0].min(v1[0]).min(v2[0]);
        let t_min_y = v0[1].min(v1[1]).min(v2[1]);
        let t_max_x = v0[0].max(v1[0]).max(v2[0]);
        let t_max_y = v0[1].max(v1[1]).max(v2[1]);

        let col_start = ((t_min_x - min_x) / cell_w).floor() as isize;
        let col_end = ((t_max_x - min_x) / cell_w).floor() as isize;
        let row_start = ((t_min_y - min_y) / cell_h).floor() as isize;
        let row_end = ((t_max_y - min_y) / cell_h).floor() as isize;

        for r in row_start.max(0)..=(row_end.min(rows as isize - 1)) {
            for c in col_start.max(0)..=(col_end.min(cols as isize - 1)) {
                let cell_idx = r as usize * cols + c as usize;
                cell_lists[cell_idx].push(ti as u32);
            }
        }
    }

    // Flatten to offset/count format
    let mut offsets = Vec::with_capacity(cell_count);
    let mut counts = Vec::with_capacity(cell_count);
    let mut flat_list: Vec<u32> = Vec::new();

    for cell in &cell_lists {
        offsets.push(flat_list.len() as u32);
        counts.push(cell.len() as u32);
        flat_list.extend_from_slice(cell);
    }

    (cols, rows, min_x, min_y, cell_w, cell_h, offsets, counts, flat_list)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

fn empty_tide_mesh(tide_levels: &[f64]) -> TideMeshData {
    TideMeshData {
        vertex_positions: vec![],
        indices: vec![],
        vertex_count: 0,
        triangle_count: 0,
        flow_data: vec![],
        tide_levels: tide_levels.to_vec(),
        grid_cols: 1,
        grid_rows: 1,
        grid_min_x: 0.0,
        grid_min_y: 0.0,
        grid_cell_width: 1.0,
        grid_cell_height: 1.0,
        grid_cell_offsets: vec![0],
        grid_cell_counts: vec![0],
        grid_triangle_lists: vec![],
    }
}
