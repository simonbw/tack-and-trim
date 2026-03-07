pub type Point = (f64, f64);

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
