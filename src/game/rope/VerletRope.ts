import { Renderer } from "../../core/graphics/Renderer";
import { V, V2d } from "../../core/Vector";

export interface VerletRopeConfig {
  /** Number of points in the rope (including endpoints). Default: 10 */
  pointCount?: number;

  /** Total rest length of the rope */
  restLength: number;

  /** Gravity vector applied to each point. Default: V(0, 9.8) */
  gravity?: V2d;

  /** Damping factor (0-1). Higher = less damping. Default: 0.98 */
  damping?: number;

  /** Number of constraint iterations per update. Default: 3 */
  constraintIterations?: number;

  /** Rope thickness for rendering. Default: 1.0 */
  thickness?: number;

  /** Rope color for rendering. Default: 0x444444 */
  color?: number;
}

/**
 * A visual rope simulation using Verlet integration.
 * This is purely for rendering - it does not affect physics constraints.
 *
 * The rope endpoints are locked to provided positions each frame,
 * while interior points simulate under gravity with distance constraints.
 */
export class VerletRope {
  // Configuration
  private readonly pointCount: number;
  private restLength: number;
  private segmentLength: number;
  private readonly gravity: V2d;
  private readonly damping: number;
  private readonly constraintIterations: number;
  private readonly thickness: number;
  private readonly color: number;

  // Simulation state
  private readonly positions: V2d[];
  private readonly previousPositions: V2d[];

  // Pre-allocated temp vectors to avoid allocations in hot path
  private readonly tempDelta: V2d = V(0, 0);

  constructor(config: VerletRopeConfig) {
    this.pointCount = config.pointCount ?? 10;
    this.restLength = config.restLength;
    this.segmentLength = this.restLength / (this.pointCount - 1);
    this.gravity = config.gravity ?? V(0, 9.8);
    this.damping = config.damping ?? 0.98;
    this.constraintIterations = config.constraintIterations ?? 3;
    this.thickness = config.thickness ?? 0.25;
    this.color = config.color ?? 0x444444;

    // Initialize positions arrays
    this.positions = [];
    this.previousPositions = [];
    for (let i = 0; i < this.pointCount; i++) {
      this.positions.push(V(0, 0));
      this.previousPositions.push(V(0, 0));
    }
  }

  /**
   * Initialize or reset the rope between two endpoints.
   * Call this when first setting up or when rope needs to "teleport".
   */
  reset(startPos: V2d, endPos: V2d): void {
    for (let i = 0; i < this.pointCount; i++) {
      const t = i / (this.pointCount - 1);
      const pos = startPos.lerp(endPos, t);
      this.positions[i].set(pos);
      this.previousPositions[i].set(pos);
    }
  }

  /**
   * Update the rest length of the rope (for adjustable sheets).
   */
  setRestLength(newLength: number): void {
    this.restLength = newLength;
    this.segmentLength = this.restLength / (this.pointCount - 1);
  }

  /**
   * Update the rope simulation for one time step.
   * @param startPos - World position of the first endpoint (locked)
   * @param endPos - World position of the second endpoint (locked)
   * @param dt - Delta time in seconds
   */
  update(startPos: V2d, endPos: V2d, dt: number): void {
    const dtSquared = dt * dt;

    // Step 1: Apply verlet integration to interior points
    for (let i = 1; i < this.pointCount - 1; i++) {
      const pos = this.positions[i];
      const prevPos = this.previousPositions[i];

      // Calculate velocity from position difference
      this.tempDelta.set(pos).isub(prevPos);

      // Store current position as previous
      prevPos.set(pos);

      // Verlet integration: newPos = pos + velocity * damping + gravity * dt^2
      pos.iadd(this.tempDelta.imul(this.damping));
      pos.iaddScaled(this.gravity, dtSquared);
    }

    // Step 2: Lock endpoints to provided positions
    this.positions[0].set(startPos);
    this.previousPositions[0].set(startPos);
    this.positions[this.pointCount - 1].set(endPos);
    this.previousPositions[this.pointCount - 1].set(endPos);

    // Step 3: Satisfy distance constraints
    for (let iter = 0; iter < this.constraintIterations; iter++) {
      this.satisfyConstraints(startPos, endPos);
    }
  }

  /**
   * Iteratively correct point positions to satisfy segment length constraints.
   */
  private satisfyConstraints(startPos: V2d, endPos: V2d): void {
    for (let i = 0; i < this.pointCount - 1; i++) {
      const p1 = this.positions[i];
      const p2 = this.positions[i + 1];

      // Get current distance
      this.tempDelta.set(p2).isub(p1);
      const distance = this.tempDelta.magnitude;

      if (distance < 0.0001) continue; // Avoid division by zero

      // Calculate correction needed
      const error = distance - this.segmentLength;

      // Normalize and scale by half the error
      this.tempDelta.inormalize().imul(error * 0.5);

      // Apply correction (skip if endpoint is locked)
      if (i !== 0) {
        p1.iadd(this.tempDelta);
      }
      if (i !== this.pointCount - 2) {
        p2.isub(this.tempDelta);
      }
    }

    // Re-lock endpoints after constraint solving
    this.positions[0].set(startPos);
    this.positions[this.pointCount - 1].set(endPos);
  }

  /**
   * Render the rope to a Renderer.
   * Draws a smooth curve through all points using quadratic beziers.
   */
  render(renderer: Renderer): void {
    if (this.pointCount < 2) return;

    const start = this.positions[0];
    renderer.beginPath();
    renderer.moveTo(start.x, start.y);

    if (this.pointCount === 2) {
      // Just two points - draw a straight line
      const end = this.positions[1];
      renderer.lineTo(end.x, end.y);
    } else {
      // Draw smooth curve using quadratic beziers
      // Points become control points, curve passes through midpoints
      for (let i = 0; i < this.pointCount - 2; i++) {
        const p1 = this.positions[i + 1];
        const p2 = this.positions[i + 2];

        // Midpoint between p1 and p2 is where the curve will pass through
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        // Curve to midpoint, using p1 as control point
        renderer.quadraticCurveTo(p1.x, p1.y, midX, midY);
      }

      // Last segment: curve from last midpoint to end, control point is second-to-last
      const pLast = this.positions[this.pointCount - 1];
      const pSecondLast = this.positions[this.pointCount - 2];
      renderer.quadraticCurveTo(pSecondLast.x, pSecondLast.y, pLast.x, pLast.y);
    }

    // Stroke without closing the path (rope is not a closed shape)
    renderer.stroke(this.color, this.thickness, 1.0, false);
  }

  /**
   * Get a specific point position (for debugging or extensions).
   */
  getPoint(index: number): V2d {
    return this.positions[index];
  }

  /**
   * Get all points (readonly).
   */
  getPoints(): readonly V2d[] {
    return this.positions;
  }
}
