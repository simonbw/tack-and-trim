import { V, V2d } from "../Vector";
import { WebGLRenderer } from "./WebGLRenderer";

/**
 * Self-contained fluent path builder for complex shapes.
 * Stores path state internally and converts to triangles on fill/stroke.
 */
export class PathBuilder {
  private points: V2d[] = [];
  private pathStarted = false;
  private closed = false;

  constructor(private renderer: WebGLRenderer) {}

  /** Move to a point without drawing */
  moveTo(x: number, y: number): this {
    this.points = [V(x, y)];
    this.pathStarted = true;
    return this;
  }

  /** Draw a line to a point */
  lineTo(x: number, y: number): this {
    if (!this.pathStarted) {
      this.moveTo(x, y);
    } else {
      this.points.push(V(x, y));
    }
    return this;
  }

  /** Draw a quadratic curve */
  quadraticTo(cpx: number, cpy: number, x: number, y: number): this {
    if (!this.pathStarted || this.points.length === 0) {
      this.moveTo(cpx, cpy);
      this.lineTo(x, y);
      return this;
    }

    // Approximate quadratic bezier with line segments
    const start = this.points[this.points.length - 1];
    const cp = V(cpx, cpy);
    const end = V(x, y);
    const segments = 8;

    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const t2 = t * t;
      const mt = 1 - t;
      const mt2 = mt * mt;

      // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
      const px = mt2 * start.x + 2 * mt * t * cp.x + t2 * end.x;
      const py = mt2 * start.y + 2 * mt * t * cp.y + t2 * end.y;
      this.points.push(V(px, py));
    }
    return this;
  }

  /** Close the path back to the starting point */
  close(): this {
    this.closed = true;
    return this;
  }

  /** Fill the path with a color */
  fill(color: number, alpha: number = 1): void {
    if (this.points.length < 3) return;

    // Simple fan triangulation (works for convex polygons)
    const indices: number[] = [];
    for (let i = 1; i < this.points.length - 1; i++) {
      indices.push(0, i, i + 1);
    }

    this.renderer.submitTriangles(this.points, indices, color, alpha);
  }

  /** Stroke the path outline */
  stroke(color: number, width: number = 1, alpha: number = 1): void {
    const points = this.points;
    if (points.length < 2) return;

    // For closed paths, we need to handle the wrap-around at start/end
    const shouldClose = this.closed && points.length >= 3;

    const halfWidth = width / 2;
    const vertices: V2d[] = [];
    const indices: number[] = [];

    // Helper to get perpendicular (rotate 90 degrees CCW)
    const perp = (dx: number, dy: number): [number, number] => {
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) return [0, 0];
      return [-dy / len, dx / len];
    };

    // For each point, compute the left and right offset vertices
    for (let i = 0; i < points.length; i++) {
      const curr = points[i];

      // Get previous and next points (handling endpoints and closed paths)
      let prev: V2d | null = null;
      let next: V2d | null = null;

      if (i > 0) {
        prev = points[i - 1];
      } else if (shouldClose) {
        prev = points[points.length - 1];
      }

      if (i < points.length - 1) {
        next = points[i + 1];
      } else if (shouldClose) {
        next = points[0];
      }

      let nx: number, ny: number;

      if (prev === null && next !== null) {
        // Start point (open path): use direction to next
        const [px, py] = perp(next.x - curr.x, next.y - curr.y);
        nx = px;
        ny = py;
      } else if (next === null && prev !== null) {
        // End point (open path): use direction from prev
        const [px, py] = perp(curr.x - prev.x, curr.y - prev.y);
        nx = px;
        ny = py;
      } else if (prev !== null && next !== null) {
        // Interior point or closed path endpoints: compute miter
        const d1x = curr.x - prev.x;
        const d1y = curr.y - prev.y;
        const d2x = next.x - curr.x;
        const d2y = next.y - curr.y;

        const [n1x, n1y] = perp(d1x, d1y);
        const [n2x, n2y] = perp(d2x, d2y);

        // Miter direction is average of the two normals
        let mx = n1x + n2x;
        let my = n1y + n2y;
        const mLen = Math.sqrt(mx * mx + my * my);

        if (mLen < 0.001) {
          // Nearly parallel lines going in opposite directions
          nx = n1x;
          ny = n1y;
        } else {
          mx /= mLen;
          my /= mLen;

          // Miter length: halfWidth / cos(theta/2) where theta is the angle between normals
          // cos(theta/2) = dot(n1, miter) = n1x*mx + n1y*my
          const cosHalfAngle = n1x * mx + n1y * my;

          // Clamp miter length to avoid spikes at sharp angles (miter limit of 2)
          const miterScale = Math.min(1 / Math.max(cosHalfAngle, 0.5), 2);

          nx = mx * miterScale;
          ny = my * miterScale;
        }
      } else {
        // Single point path (shouldn't happen with length >= 2)
        nx = 1;
        ny = 0;
      }

      // Add left and right vertices
      vertices.push(V(curr.x + nx * halfWidth, curr.y + ny * halfWidth));
      vertices.push(V(curr.x - nx * halfWidth, curr.y - ny * halfWidth));
    }

    // Build triangle strip indices for the line segments
    const segmentCount = shouldClose ? points.length : points.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const i0 = i * 2;
      const i1 = ((i + 1) % points.length) * 2;

      // Two triangles per segment
      indices.push(i0, i0 + 1, i1);
      indices.push(i0 + 1, i1 + 1, i1);
    }

    if (vertices.length > 0 && indices.length > 0) {
      this.renderer.submitTriangles(vertices, indices, color, alpha);
    }
  }
}
