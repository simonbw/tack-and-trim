use crate::level::TerrainCPUData;

pub const WIND_VERTEX_FLOATS: usize = 5;

pub struct WindMeshData {
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

pub fn build_wind_grid(terrain: &TerrainCPUData, grid_spacing: f64) -> WindMeshData {
    // Compute AABB from terrain vertex data (pairs of f32 x, y)
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    let vert_count = terrain.vertex_data.len() / 2;
    for i in 0..vert_count {
        let x = terrain.vertex_data[i * 2] as f64;
        let y = terrain.vertex_data[i * 2 + 1] as f64;
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
    }

    // Add 500ft margin
    let margin = 500.0;
    min_x -= margin;
    min_y -= margin;
    max_x += margin;
    max_y += margin;

    let width = max_x - min_x;
    let height = max_y - min_y;

    let cols = (width / grid_spacing).ceil() as usize + 1;
    let rows = (height / grid_spacing).ceil() as usize + 1;

    let cell_width = if cols > 1 {
        width / (cols - 1) as f64
    } else {
        width
    };
    let cell_height = if rows > 1 {
        height / (rows - 1) as f64
    } else {
        height
    };

    // Generate vertices
    let vertex_count = cols * rows;
    let mut vertices = Vec::with_capacity(vertex_count * WIND_VERTEX_FLOATS);

    for r in 0..rows {
        for c in 0..cols {
            let x = min_x + c as f64 * cell_width;
            let y = min_y + r as f64 * cell_height;
            vertices.push(x as f32);
            vertices.push(y as f32);
            vertices.push(1.0_f32); // speedFactor (neutral)
            vertices.push(0.0_f32); // directionOffset (neutral)
            vertices.push(0.0_f32); // turbulence (neutral)
        }
    }

    // Generate indices (two triangles per grid cell)
    let grid_cells = (cols - 1) * (rows - 1);
    let index_count = grid_cells * 6;
    let mut indices = Vec::with_capacity(index_count);

    for r in 0..(rows - 1) {
        for c in 0..(cols - 1) {
            let tl = (r * cols + c) as u32;
            let tr = tl + 1;
            let bl = ((r + 1) * cols + c) as u32;
            let br = bl + 1;

            // Triangle 1: tl, bl, tr
            indices.push(tl);
            indices.push(bl);
            indices.push(tr);

            // Triangle 2: tr, bl, br
            indices.push(tr);
            indices.push(bl);
            indices.push(br);
        }
    }

    WindMeshData {
        vertices,
        indices,
        vertex_count,
        index_count,
        grid_cols: cols,
        grid_rows: rows,
        grid_min_x: min_x,
        grid_min_y: min_y,
        grid_cell_width: cell_width,
        grid_cell_height: cell_height,
    }
}
