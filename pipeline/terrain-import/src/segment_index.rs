use std::collections::{HashMap, HashSet};

use crate::simplify::Point;

#[derive(Clone, Copy, Debug)]
struct CellEntry {
    contour_index: usize,
    seg_index: usize,
}

fn segments_intersect(
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

pub struct SegmentIndex {
    min_x: f64,
    min_y: f64,
    cell_size: f64,
    cols: usize,
    rows: usize,
    cells: Vec<Vec<CellEntry>>,
    stored_contours: HashMap<usize, Vec<Point>>,
}

impl SegmentIndex {
    pub fn new(min_x: f64, min_y: f64, max_x: f64, max_y: f64, cell_size: f64) -> Self {
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
            stored_contours: HashMap::new(),
        }
    }

    pub fn add_contour_segments(&mut self, contour_index: usize, points: &[Point]) {
        self.stored_contours.insert(contour_index, points.to_vec());
        let n = points.len();
        if n == 0 {
            return;
        }

        for seg_index in 0..n {
            let (x1, y1) = points[seg_index];
            let (x2, y2) = points[(seg_index + 1) % n];

            let min_cx = self.clamp_x((x1.min(x2) - self.min_x) / self.cell_size);
            let max_cx = self.clamp_x((x1.max(x2) - self.min_x) / self.cell_size);
            let min_cy = self.clamp_y((y1.min(y2) - self.min_y) / self.cell_size);
            let max_cy = self.clamp_y((y1.max(y2) - self.min_y) / self.cell_size);

            let entry = CellEntry {
                contour_index,
                seg_index,
            };
            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    let key = self.cell_key(cx, cy);
                    self.cells[key].push(entry);
                }
            }
        }
    }

    pub fn remove_contour_segments(&mut self, contour_index: usize) {
        if self.stored_contours.remove(&contour_index).is_none() {
            return;
        }

        for cell in &mut self.cells {
            if cell.is_empty() {
                continue;
            }
            cell.retain(|entry| entry.contour_index != contour_index);
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
        let min_cx = self.clamp_x((ax.min(bx) - self.min_x) / self.cell_size);
        let max_cx = self.clamp_x((ax.max(bx) - self.min_x) / self.cell_size);
        let min_cy = self.clamp_y((ay.min(by) - self.min_y) / self.cell_size);
        let max_cy = self.clamp_y((ay.max(by) - self.min_y) / self.cell_size);

        let mut tested = HashSet::new();

        for cy in min_cy..=max_cy {
            for cx in min_cx..=max_cx {
                let key = self.cell_key(cx, cy);
                for entry in &self.cells[key] {
                    if entry.contour_index == exclude_contour {
                        continue;
                    }

                    let test_key = ((entry.contour_index as u64) << 32) | entry.seg_index as u64;
                    if !tested.insert(test_key) {
                        continue;
                    }

                    let Some(points) = self.stored_contours.get(&entry.contour_index) else {
                        continue;
                    };
                    if points.is_empty() {
                        continue;
                    }

                    let next = (entry.seg_index + 1) % points.len();
                    let (p3x, p3y) = points[entry.seg_index];
                    let (p4x, p4y) = points[next];

                    if segments_intersect(ax, ay, bx, by, p3x, p3y, p4x, p4y) {
                        return true;
                    }
                }
            }
        }

        false
    }

    fn clamp_x(&self, value: f64) -> usize {
        (value.floor() as isize).clamp(0, self.cols as isize - 1) as usize
    }

    fn clamp_y(&self, value: f64) -> usize {
        (value.floor() as isize).clamp(0, self.rows as isize - 1) as usize
    }

    fn cell_key(&self, cx: usize, cy: usize) -> usize {
        cy * self.cols + cx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_intersection_against_existing_segments() {
        let mut index = SegmentIndex::new(0.0, 0.0, 100.0, 100.0, 10.0);
        index.add_contour_segments(0, &[(10.0, 10.0), (90.0, 90.0), (90.0, 10.0)]);

        assert!(index.segment_intersects_any(10.0, 90.0, 90.0, 10.0, 1));
        assert!(!index.segment_intersects_any(0.0, 0.0, 5.0, 5.0, 1));
    }
}
