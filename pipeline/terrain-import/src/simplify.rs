pub type Point = (f64, f64);

fn perpendicular_distance(point: Point, line_start: Point, line_end: Point) -> f64 {
    let (x, y) = point;
    let (x1, y1) = line_start;
    let (x2, y2) = line_end;

    let dx = x2 - x1;
    let dy = y2 - y1;
    let length_squared = dx * dx + dy * dy;

    if length_squared == 0.0 {
        return ((x - x1).powi(2) + (y - y1).powi(2)).sqrt();
    }

    let t = ((x - x1) * dx + (y - y1) * dy) / length_squared;
    let clamped = t.clamp(0.0, 1.0);
    let proj_x = x1 + clamped * dx;
    let proj_y = y1 + clamped * dy;

    ((x - proj_x).powi(2) + (y - proj_y).powi(2)).sqrt()
}

fn rdp(points: &[Point], tolerance: f64) -> Vec<Point> {
    if points.len() <= 2 {
        return points.to_vec();
    }

    let mut max_distance = 0.0;
    let mut split_index = 0usize;

    for i in 1..points.len() - 1 {
        let distance = perpendicular_distance(points[i], points[0], points[points.len() - 1]);
        if distance > max_distance {
            max_distance = distance;
            split_index = i;
        }
    }

    if max_distance <= tolerance {
        return vec![points[0], points[points.len() - 1]];
    }

    let mut left = rdp(&points[..=split_index], tolerance);
    let right = rdp(&points[split_index..], tolerance);
    left.pop();
    left.extend(right);
    left
}

pub fn simplify_polyline(points: &[Point], tolerance: f64) -> Vec<Point> {
    if tolerance <= 0.0 || points.len() < 3 {
        return points.to_vec();
    }
    rdp(points, tolerance)
}

pub fn simplify_closed_ring(points: &[Point], tolerance: f64) -> Vec<Point> {
    if points.len() < 4 || tolerance <= 0.0 {
        return points.to_vec();
    }

    let mut anchor_index = 0usize;
    let mut max_x = points[0].0;
    for (i, point) in points.iter().enumerate().skip(1) {
        if point.0 > max_x {
            max_x = point.0;
            anchor_index = i;
        }
    }

    let mut rotated = Vec::with_capacity(points.len());
    for i in 0..points.len() {
        rotated.push(points[(anchor_index + i) % points.len()]);
    }

    let mut open = rotated.clone();
    open.push(rotated[0]);

    let simplified_open = rdp(&open, tolerance);
    if simplified_open.len() <= 2 {
        return points.to_vec();
    }

    let simplified_ring = &simplified_open[..simplified_open.len() - 1];
    if simplified_ring.len() >= 3 {
        simplified_ring.to_vec()
    } else {
        points.to_vec()
    }
}

pub fn signed_area(points: &[Point]) -> f64 {
    let mut area = 0.0;
    for i in 0..points.len() {
        let (ax, ay) = points[i];
        let (bx, by) = points[(i + 1) % points.len()];
        area += ax * by - bx * ay;
    }
    area * 0.5
}

pub fn ring_perimeter(points: &[Point]) -> f64 {
    if points.len() < 2 {
        return 0.0;
    }

    let mut length = 0.0;
    for i in 0..points.len() {
        let (ax, ay) = points[i];
        let (bx, by) = points[(i + 1) % points.len()];
        length += ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    }
    length
}
