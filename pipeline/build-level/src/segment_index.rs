use terrain_core::polygon_math::segments_intersect_collinear_aware;

/// 2D point as `(x, y)`. Canonical ring representation in build-level.
type Point = (f64, f64);

#[derive(Clone, Copy, Debug)]
struct CellEntry {
    contour_index: usize,
    seg_index: usize,
}

pub struct SegmentIndex {
    min_x: f64,
    min_y: f64,
    cell_size: f64,
    cols: usize,
    rows: usize,
    cells: Vec<Vec<CellEntry>>,
    stored_contours: Vec<Vec<Point>>,
    contour_cells: Vec<Vec<usize>>,
}

fn clamp_coord(value: f64, size: usize) -> usize {
    (value.floor() as isize).clamp(0, size as isize - 1) as usize
}

impl SegmentIndex {
    pub fn new(
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
        cell_size: f64,
        num_contours: usize,
    ) -> Self {
        let cols = (((max_x - min_x) / cell_size).ceil() as usize)
            .saturating_add(1)
            .max(1);
        let rows = (((max_y - min_y) / cell_size).ceil() as usize)
            .saturating_add(1)
            .max(1);
        let cells = vec![Vec::new(); cols * rows];

        Self {
            min_x,
            min_y,
            cell_size,
            cols,
            rows,
            cells,
            stored_contours: vec![Vec::new(); num_contours],
            contour_cells: vec![Vec::new(); num_contours],
        }
    }

    pub fn add_contour_segments(&mut self, contour_index: usize, points: &[Point]) {
        self.stored_contours[contour_index] = points.to_vec();
        let n = points.len();
        if n == 0 {
            return;
        }

        let min_x = self.min_x;
        let min_y = self.min_y;
        let cell_size = self.cell_size;
        let cols = self.cols;
        let rows = self.rows;
        let touched = &mut self.contour_cells[contour_index];

        for seg_index in 0..n {
            let (x1, y1) = points[seg_index];
            let (x2, y2) = points[(seg_index + 1) % n];

            let min_cx = clamp_coord((x1.min(x2) - min_x) / cell_size, cols);
            let max_cx = clamp_coord((x1.max(x2) - min_x) / cell_size, cols);
            let min_cy = clamp_coord((y1.min(y2) - min_y) / cell_size, rows);
            let max_cy = clamp_coord((y1.max(y2) - min_y) / cell_size, rows);

            let entry = CellEntry {
                contour_index,
                seg_index,
            };
            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    let key = cy * cols + cx;
                    self.cells[key].push(entry);
                    touched.push(key);
                }
            }
        }
    }

    pub fn remove_contour_segments(&mut self, contour_index: usize) {
        self.stored_contours[contour_index].clear();

        let touched = std::mem::take(&mut self.contour_cells[contour_index]);
        for key in touched {
            self.cells[key].retain(|entry| entry.contour_index != contour_index);
        }
    }

    pub fn segment_intersects_any(
        &self,
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        exclude_contour: usize,
    ) -> bool {
        let min_cx = clamp_coord((ax.min(bx) - self.min_x) / self.cell_size, self.cols);
        let max_cx = clamp_coord((ax.max(bx) - self.min_x) / self.cell_size, self.cols);
        let min_cy = clamp_coord((ay.min(by) - self.min_y) / self.cell_size, self.rows);
        let max_cy = clamp_coord((ay.max(by) - self.min_y) / self.cell_size, self.rows);

        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = cy * self.cols + cx;
                for entry in &self.cells[key] {
                    if entry.contour_index == exclude_contour {
                        continue;
                    }

                    let points = &self.stored_contours[entry.contour_index];
                    if points.is_empty() {
                        continue;
                    }

                    let next = (entry.seg_index + 1) % points.len();
                    let (p3x, p3y) = points[entry.seg_index];
                    let (p4x, p4y) = points[next];

                    if segments_intersect_collinear_aware(ax, ay, bx, by, p3x, p3y, p4x, p4y) {
                        return true;
                    }
                }
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_intersection_against_existing_segments() {
        let mut index = SegmentIndex::new(0.0, 0.0, 100.0, 100.0, 10.0, 2);
        index.add_contour_segments(0, &[(10.0, 10.0), (90.0, 90.0), (90.0, 10.0)]);

        assert!(index.segment_intersects_any(10.0, 90.0, 90.0, 10.0, 1));
        assert!(!index.segment_intersects_any(0.0, 0.0, 5.0, 5.0, 1));
    }

    #[test]
    fn detects_collinear_overlapping_segments() {
        // Horizontal overlap
        assert!(segments_intersect_collinear_aware(0.0, 0.0, 10.0, 0.0, 5.0, 0.0, 15.0, 0.0));
        // One fully inside the other
        assert!(segments_intersect_collinear_aware(0.0, 0.0, 10.0, 0.0, 2.0, 0.0, 8.0, 0.0));
        // Vertical overlap
        assert!(segments_intersect_collinear_aware(5.0, 0.0, 5.0, 10.0, 5.0, 5.0, 5.0, 15.0));
        // Diagonal overlap
        assert!(segments_intersect_collinear_aware(
            0.0, 0.0, 10.0, 10.0, 5.0, 5.0, 15.0, 15.0
        ));
    }

    #[test]
    fn rejects_collinear_non_overlapping_segments() {
        // Same line but disjoint
        assert!(!segments_intersect_collinear_aware(0.0, 0.0, 3.0, 0.0, 7.0, 0.0, 10.0, 0.0));
    }

    #[test]
    fn rejects_parallel_non_collinear_segments() {
        // Parallel but offset
        assert!(!segments_intersect_collinear_aware(
            0.0, 0.0, 10.0, 0.0, 0.0, 1.0, 10.0, 1.0
        ));
    }

    #[test]
    fn rejects_collinear_touching_only_at_endpoint() {
        // Touching at exactly one endpoint (t=1 for first, t=0 for second)
        assert!(!segments_intersect_collinear_aware(0.0, 0.0, 5.0, 0.0, 5.0, 0.0, 10.0, 0.0));
    }
}
