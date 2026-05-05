use crate::segment_index::SegmentIndex;

/// 2D point as `(x, y)`. Canonical ring representation in build-level.
type Point = (f64, f64);

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
    let clamped_t = t.clamp(0.0, 1.0);
    let proj_x = x1 + clamped_t * dx;
    let proj_y = y1 + clamped_t * dy;
    ((x - proj_x).powi(2) + (y - proj_y).powi(2)).sqrt()
}

fn constrained_rdp(
    points: &[Point],
    tolerance: f64,
    contour_index: usize,
    segment_index: &SegmentIndex,
) -> Vec<Point> {
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
        let start = points[0];
        let end = points[points.len() - 1];
        if !segment_index.segment_intersects_any(start.0, start.1, end.0, end.1, contour_index) {
            return vec![start, end];
        }
    }

    let mut left = constrained_rdp(
        &points[..=split_index],
        tolerance,
        contour_index,
        segment_index,
    );
    let right = constrained_rdp(
        &points[split_index..],
        tolerance,
        contour_index,
        segment_index,
    );
    left.pop();
    left.extend(right);
    left
}

pub fn constrained_simplify_closed_ring(
    points: &[Point],
    tolerance: f64,
    contour_index: usize,
    segment_index: &SegmentIndex,
) -> Vec<Point> {
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

    let simplified_open = constrained_rdp(&open, tolerance, contour_index, segment_index);
    if simplified_open.len() <= 2 {
        return points.to_vec();
    }

    let simplified_ring = simplified_open[..simplified_open.len() - 1].to_vec();
    if simplified_ring.len() >= 3 {
        simplified_ring
    } else {
        points.to_vec()
    }
}
