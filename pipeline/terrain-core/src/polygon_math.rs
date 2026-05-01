//! Geometry helpers shared across the offline pipeline.
//!
//! The pipeline stores polygon rings in three different layouts:
//! - `&[(f64, f64)]` — slice of (x, y) tuples (build-level: extract, simplify)
//! - `&[f64]` with a `num_points` argument — flat `[x0, y0, x1, y1, …]`
//!   (build-level: validate, where contours come straight out of the binary)
//! - `&[[f64; 2]]` — slice of fixed-size arrays (terrain-core: level)
//!
//! Rather than force callers to convert to a single shape, this module
//! provides each helper in every layout it is actually used. The
//! implementations are kept short so the duplication is cheap.
//
// All functions assume rings are not necessarily closed (the wraparound
// from `points[n-1]` to `points[0]` is handled here), and the standard
// convention is positive signed area = counter-clockwise.

// ── signed_area ─────────────────────────────────────────────────────────────

/// Signed area of a polygon ring stored as `(x, y)` tuples.
///
/// Positive ⇒ counter-clockwise winding.
pub fn signed_area_tuples(points: &[(f64, f64)]) -> f64 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let (ax, ay) = points[i];
        let (bx, by) = points[(i + 1) % n];
        area += ax * by - bx * ay;
    }
    area * 0.5
}

/// Signed area of a polygon ring stored as a flat `[x0, y0, x1, y1, …]` array.
///
/// `num_points` is the vertex count (so the slice length should be `2 *
/// num_points`). Positive ⇒ counter-clockwise winding.
pub fn signed_area_flat(points: &[f64], num_points: usize) -> f64 {
    if num_points < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..num_points {
        let j = (i + 1) % num_points;
        area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
    }
    area * 0.5
}

/// Signed area of a polygon ring stored as `[x, y]` arrays.
///
/// Positive ⇒ counter-clockwise winding.
pub fn signed_area_arr2(points: &[[f64; 2]]) -> f64 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += points[i][0] * points[j][1];
        area -= points[j][0] * points[i][1];
    }
    area * 0.5
}

// ── ring_perimeter ──────────────────────────────────────────────────────────

/// Perimeter (closed ring) for points stored as `(x, y)` tuples.
pub fn ring_perimeter_tuples(points: &[(f64, f64)]) -> f64 {
    let n = points.len();
    if n < 2 {
        return 0.0;
    }
    let mut length = 0.0;
    for i in 0..n {
        let (ax, ay) = points[i];
        let (bx, by) = points[(i + 1) % n];
        length += ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
    }
    length
}

// ── point_in_polygon ────────────────────────────────────────────────────────

/// Even-odd rule point-in-polygon test for a ring of `(x, y)` tuples.
pub fn point_in_polygon_tuples(px: f64, py: f64, poly: &[(f64, f64)]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi) / (yj - yi)) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Even-odd rule point-in-polygon test for a flat `[x0, y0, x1, y1, …]` ring.
pub fn point_in_polygon_flat(px: f64, py: f64, poly: &[f64], num_points: usize) -> bool {
    if num_points < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = num_points - 1;
    for i in 0..num_points {
        let xi = poly[i * 2];
        let yi = poly[i * 2 + 1];
        let xj = poly[j * 2];
        let yj = poly[j * 2 + 1];
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi) / (yj - yi)) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Even-odd rule point-in-polygon test for a ring of `[x, y]` arrays.
pub fn point_in_polygon_arr2(px: f64, py: f64, polygon: &[[f64; 2]]) -> bool {
    let n = polygon.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let yi = polygon[i][1];
        let yj = polygon[j][1];
        if (yi > py) != (yj > py)
            && px < (polygon[j][0] - polygon[i][0]) * (py - yi) / (yj - yi) + polygon[i][0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// ── segments_intersect ──────────────────────────────────────────────────────

/// Test whether segments (p1→p2) and (p3→p4) properly intersect (strictly
/// interior on both sides; endpoint contact does not count).
///
/// This is the simple form: parallel segments — collinear or not — are
/// reported as non-intersecting. Use [`segments_intersect_collinear_aware`]
/// if collinear overlap should count as an intersection.
pub fn segments_intersect(
    p1x: f64,
    p1y: f64,
    p2x: f64,
    p2y: f64,
    p3x: f64,
    p3y: f64,
    p4x: f64,
    p4y: f64,
) -> bool {
    let d1x = p2x - p1x;
    let d1y = p2y - p1y;
    let d2x = p4x - p3x;
    let d2y = p4y - p3y;

    let denom = d1x * d2y - d1y * d2x;
    if denom.abs() < 1e-12 {
        return false;
    }

    let t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
    let u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;

    let eps = 1e-9;
    t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps
}

/// Test whether segments (p1→p2) and (p3→p4) properly intersect, treating
/// collinear segments that overlap as an intersection.
///
/// Used by the constrained simplifier where collinear overlap between
/// candidate edges and existing contour edges must be detected.
pub fn segments_intersect_collinear_aware(
    p1x: f64,
    p1y: f64,
    p2x: f64,
    p2y: f64,
    p3x: f64,
    p3y: f64,
    p4x: f64,
    p4y: f64,
) -> bool {
    let d1x = p2x - p1x;
    let d1y = p2y - p1y;
    let d2x = p4x - p3x;
    let d2y = p4y - p3y;

    let denom = d1x * d2y - d1y * d2x;
    if denom.abs() < 1e-12 {
        // Parallel — check if collinear and overlapping.
        let len_sq = d1x * d1x + d1y * d1y;
        if len_sq < 1e-24 {
            return false; // degenerate (zero-length) first segment
        }
        // Perpendicular distance of p3 from the line through p1→p2.
        let cross = (p3x - p1x) * d1y - (p3y - p1y) * d1x;
        if (cross * cross / len_sq) > 1e-6 {
            return false; // parallel but not collinear
        }
        // Collinear: project both segment endpoints onto the p1→p2 axis
        // and check overlap with the open interval (eps, 1-eps).
        let t3 = ((p3x - p1x) * d1x + (p3y - p1y) * d1y) / len_sq;
        let t4 = ((p4x - p1x) * d1x + (p4y - p1y) * d1y) / len_sq;
        let (t_min, t_max) = if t3 < t4 { (t3, t4) } else { (t4, t3) };
        let eps = 1e-9;
        return t_max > eps && t_min < 1.0 - eps;
    }

    let t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
    let u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;

    let eps = 1e-9;
    t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_area_ccw_square() {
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(signed_area_tuples(&pts) > 0.0);

        let flat: Vec<f64> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
        assert!((signed_area_flat(&flat, pts.len()) - signed_area_tuples(&pts)).abs() < 1e-9);

        let arr: Vec<[f64; 2]> = pts.iter().map(|p| [p.0, p.1]).collect();
        assert!((signed_area_arr2(&arr) - signed_area_tuples(&pts)).abs() < 1e-9);
    }

    #[test]
    fn signed_area_cw_square_negative() {
        let pts = [(0.0, 0.0), (0.0, 10.0), (10.0, 10.0), (10.0, 0.0)];
        assert!(signed_area_tuples(&pts) < 0.0);
    }

    #[test]
    fn ring_perimeter_unit_square() {
        let pts = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)];
        assert!((ring_perimeter_tuples(&pts) - 4.0).abs() < 1e-9);
    }

    #[test]
    fn point_in_polygon_inside_outside() {
        let pts = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0)];
        assert!(point_in_polygon_tuples(5.0, 5.0, &pts));
        assert!(!point_in_polygon_tuples(20.0, 5.0, &pts));

        let flat: Vec<f64> = pts.iter().flat_map(|p| [p.0, p.1]).collect();
        assert!(point_in_polygon_flat(5.0, 5.0, &flat, pts.len()));
        assert!(!point_in_polygon_flat(20.0, 5.0, &flat, pts.len()));

        let arr: Vec<[f64; 2]> = pts.iter().map(|p| [p.0, p.1]).collect();
        assert!(point_in_polygon_arr2(5.0, 5.0, &arr));
        assert!(!point_in_polygon_arr2(20.0, 5.0, &arr));
    }

    #[test]
    fn segments_intersect_basic() {
        // Crossing X
        assert!(segments_intersect(0.0, 0.0, 10.0, 10.0, 0.0, 10.0, 10.0, 0.0));
        // Disjoint
        assert!(!segments_intersect(0.0, 0.0, 1.0, 1.0, 5.0, 5.0, 6.0, 6.0));
        // Parallel — simple form rejects all parallel
        assert!(!segments_intersect(0.0, 0.0, 10.0, 0.0, 5.0, 0.0, 15.0, 0.0));
    }

    #[test]
    fn segments_intersect_collinear_overlap() {
        // Horizontal collinear overlap
        assert!(segments_intersect_collinear_aware(
            0.0, 0.0, 10.0, 0.0, 5.0, 0.0, 15.0, 0.0
        ));
        // Disjoint collinear
        assert!(!segments_intersect_collinear_aware(
            0.0, 0.0, 3.0, 0.0, 7.0, 0.0, 10.0, 0.0
        ));
        // Parallel but not collinear
        assert!(!segments_intersect_collinear_aware(
            0.0, 0.0, 10.0, 0.0, 0.0, 1.0, 10.0, 1.0
        ));
        // Touching only at endpoint
        assert!(!segments_intersect_collinear_aware(
            0.0, 0.0, 5.0, 0.0, 5.0, 0.0, 10.0, 0.0
        ));
    }
}
