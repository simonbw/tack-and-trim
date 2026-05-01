/// 2D point as `(x, y)`. Used as the canonical ring representation in
/// build-level (extract, marching, segment_index, constrained_simplify).
///
/// Geometry helpers (`signed_area`, `ring_perimeter`, `point_in_polygon`,
/// `segments_intersect`) live in `terrain_core::polygon_math`; this module
/// only carries the type alias.
pub type Point = (f64, f64);
