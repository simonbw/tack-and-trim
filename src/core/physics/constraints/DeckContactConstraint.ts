import type { Body } from "../body/Body";
import { Equation } from "../equations/Equation";
import { Constraint, type ConstraintOptions } from "./Constraint";

// ── Hull boundary data ─────────────────────────────────────────────

/** Pre-computed edge geometry for a single z-level hull cross-section. */
export interface HullBoundaryLevel {
  /** Hull-local z-height of this slice. */
  z: number;
  /** Vertex X coords (hull-local). */
  vx: Float64Array;
  /** Vertex Y coords (hull-local). */
  vy: Float64Array;
  /** Outward normal X per edge. */
  edgeNx: Float64Array;
  /** Outward normal Y per edge. */
  edgeNy: Float64Array;
  /** Unit tangent X per edge (along edge direction). */
  edgeTx: Float64Array;
  /** Unit tangent Y per edge. */
  edgeTy: Float64Array;
  /** Number of vertices/edges. */
  count: number;
}

/** Hull boundary sampled at multiple z-levels, shared across all constraints on the same hull. */
export interface HullBoundaryData {
  /** Sorted ascending by z (bottom → deck). */
  levels: HullBoundaryLevel[];
  /** Gunwale z in hull-local frame (top of hull wall, "open edge"). */
  deckHeight: number;
  /** Hull bottom z = -draft. */
  draft: number;
}

/**
 * Build a HullBoundaryLevel from a CCW polygon outline.
 * The outline is an array of [x, y] tuples in hull-local coordinates.
 */
export function buildBoundaryLevel(
  outline: ReadonlyArray<readonly [number, number]>,
  z: number,
): HullBoundaryLevel | null {
  const n = outline.length;
  if (n < 3) return null;

  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  const edgeNx = new Float64Array(n);
  const edgeNy = new Float64Array(n);
  const edgeTx = new Float64Array(n);
  const edgeTy = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    vx[i] = outline[i][0];
    vy[i] = outline[i][1];
  }

  // Compute signed area to determine winding
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += vx[i] * vy[j] - vx[j] * vy[i];
  }
  // area > 0 → CCW, < 0 → CW
  const sign = area >= 0 ? 1 : -1;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = vx[j] - vx[i];
    const ey = vy[j] - vy[i];
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-10) {
      edgeTx[i] = 1;
      edgeTy[i] = 0;
      edgeNx[i] = 0;
      edgeNy[i] = -sign;
    } else {
      const invLen = 1 / len;
      edgeTx[i] = ex * invLen;
      edgeTy[i] = ey * invLen;
      // CCW outward normal: (ty, -tx). CW: (-ty, tx). Handled by sign.
      edgeNx[i] = sign * edgeTy[i];
      edgeNy[i] = sign * -edgeTx[i];
    }
  }

  return { z, vx, vy, edgeNx, edgeNy, edgeTx, edgeTy, count: n };
}

// ── Constraint ─────────────────────────────────────────────────────

/**
 * Stateful 3D hull contact constraint that keeps a particle either above
 * the deck (inside mode) or outside the hull walls (outside mode), with
 * Coulomb friction in both cases.
 *
 * Three equations (reused for both modes):
 * - **Normal** (unilateral): prevents penetration through deck or wall.
 * - **Friction 1 & 2** (bounded bilateral): resist tangential sliding.
 *
 * State transitions happen only at the gunwale ("open edge" at deckHeight):
 * - Inside → Outside: particle's hull-local XY exits the deck-level outline
 * - Outside → Inside: XY enters deck outline AND Z ≥ deckHeight (open top)
 */
export class DeckContactConstraint extends Constraint {
  /** Callback returning deck z-height in bodyB-local coords, or null. */
  private getDeckHeight: (localX: number, localY: number) => number | null;

  /** Hull boundary data shared across constraints on the same hull. */
  private boundary: HullBoundaryData;

  /** Coulomb friction coefficient (0 = frictionless). */
  frictionCoefficient: number;

  /** Rope radius (ft). The particle center rests this far above surfaces. */
  radius: number;

  /** Whether the constraint is currently engaged (particle on or near a surface). */
  private _active: boolean = false;

  /** Persistent inside/outside state. true = particle is within the hull. */
  private inside: boolean;

  constructor(
    particle: Body,
    hullBody: Body,
    getDeckHeight: (localX: number, localY: number) => number | null,
    hullBoundary: HullBoundaryData,
    frictionCoefficient: number = 0.5,
    radius: number = 0,
    options?: ConstraintOptions,
  ) {
    super(particle, hullBody, options);

    this.getDeckHeight = getDeckHeight;
    this.boundary = hullBoundary;
    this.frictionCoefficient = frictionCoefficient;
    this.radius = radius;

    // Normal equation: unilateral (can only push particle away from surface)
    const normal = new Equation(particle, hullBody, 0, Number.MAX_VALUE);

    // Friction equations: pure velocity constraints, no position error.
    const friction1 = new Equation(particle, hullBody, 0, 0);
    const friction2 = new Equation(particle, hullBody, 0, 0);
    friction1.computeGq = () => 0;
    friction2.computeGq = () => 0;

    this.equations = [normal, friction1, friction2];

    // Determine initial inside/outside state from current particle position
    const deckLevel = hullBoundary.levels[hullBoundary.levels.length - 1];
    if (deckLevel) {
      const [lx, ly] = hullBody.toLocalFrame3D(
        particle.position[0],
        particle.position[1],
        particle.z,
      );
      this.inside = this.pointInPolygon(deckLevel, lx, ly);
    } else {
      this.inside = true;
    }
  }

  update(): this {
    const particle = this.bodyA;
    const hull = this.bodyB;
    const normal = this.equations[0];
    const friction1 = this.equations[1];
    const friction2 = this.equations[2];
    const boundary = this.boundary;

    // Convert particle world position to hull-local coordinates
    const [lx, ly, lz] = hull.toLocalFrame3D(
      particle.position[0],
      particle.position[1],
      particle.z,
    );

    // Use the topmost level (deck-level outline) for state transitions
    const deckLevel = boundary.levels[boundary.levels.length - 1];
    if (!deckLevel) {
      this.disableAll(normal, friction1, friction2);
      return this;
    }

    const insideDeckOutline = this.pointInPolygon(deckLevel, lx, ly);

    // ── State transitions ──────────────────────────────────────────
    if (this.inside && !insideDeckOutline) {
      // Was inside, slid over gunwale → outside
      this.inside = false;
      this.resetWarmStart();
    } else if (!this.inside && insideDeckOutline) {
      // Was outside, XY is now within deck outline
      if (lz >= boundary.deckHeight - this.radius - 0.1) {
        // Entered from above the gunwale (open edge) → allowed
        this.inside = true;
        this.resetWarmStart();
      }
      // else: below gunwale → stay outside, wall blocks re-entry
    }

    // ── Dispatch to mode ───────────────────────────────────────────
    if (this.inside) {
      this.updateInside(lx, ly, lz, normal, friction1, friction2);
    } else {
      this.updateOutside(lx, ly, lz, normal, friction1, friction2);
    }

    return this;
  }

  // ── Inside mode: deck surface contact ────────────────────────────

  private updateInside(
    lx: number,
    ly: number,
    lz: number,
    normal: Equation,
    friction1: Equation,
    friction2: Equation,
  ): void {
    const particle = this.bodyA;
    const hull = this.bodyB;

    // Query deck height (with fallback to gunwale height)
    const deckZ = this.getDeckHeight(lx, ly) ?? this.boundary.deckHeight;

    // Deck surface point in world space
    const [dx, dy, dz] = hull.toWorldFrame3D(lx, ly, deckZ);

    // Particle world position
    const px = particle.position[0];
    const py = particle.position[1];
    const pz = particle.z;

    // Hull orientation matrix (row-major 3x3)
    const R = hull.orientation;

    // World deck normal: hull's local Z axis
    const nx = R[2];
    const ny = R[5];
    const nz = R[8];

    // Signed distance from particle center to the effective surface
    const rawDist = nx * (px - dx) + ny * (py - dy) + nz * (pz - dz);
    const penetration = rawDist - this.radius;

    // Disable when particle is well above deck
    if (penetration > 0.5) {
      this.disableAll(normal, friction1, friction2);
      return;
    }

    this._active = true;
    normal.enabled = true;

    // Lever arm from hull center to deck contact point (world frame)
    const rjX = dx - hull.position[0];
    const rjY = dy - hull.position[1];
    const rjZ = dz - hull.z;

    // Normal equation Jacobian: G = [+n, 0, -n, -(rj×n)]
    this.setNormalJacobian(normal, nx, ny, nz, rjX, rjY, rjZ);

    // Position error: penetration depth
    const pen = penetration;
    normal.computeGq = () => pen;

    // Friction
    this.setFriction(normal, friction1, friction2, R, rjX, rjY, rjZ);
  }

  // ── Outside mode: hull wall contact ──────────────────────────────

  private updateOutside(
    lx: number,
    ly: number,
    lz: number,
    normal: Equation,
    friction1: Equation,
    friction2: Equation,
  ): void {
    const particle = this.bodyA;
    const hull = this.bodyB;
    const boundary = this.boundary;

    // Above gunwale → no wall constraint (open edge)
    if (lz > boundary.deckHeight + this.radius) {
      this.disableAll(normal, friction1, friction2);
      return;
    }

    // Find the z-appropriate hull outline level
    const zLevel = this.findLevelForZ(lz);
    if (!zLevel) {
      this.disableAll(normal, friction1, friction2);
      return;
    }

    // Find nearest hull edge at this z-level
    const nearest = this.findNearestEdge(zLevel, lx, ly);
    if (nearest.distSq > 25) {
      // > 5 ft from hull → disable
      this.disableAll(normal, friction1, friction2);
      return;
    }

    // Below hull bottom → bottom contact (push downward, away from hull)
    if (lz <= -boundary.draft + this.radius) {
      this.updateBottomContact(lx, ly, lz, normal, friction1, friction2);
      return;
    }

    // Wall contact: push particle outward from nearest hull edge

    // Wall normal: always use pre-computed edge outward normal.
    // (Using particle-to-edge direction would point inward when penetrating.)
    const localNx = zLevel.edgeNx[nearest.edgeIndex];
    const localNy = zLevel.edgeNy[nearest.edgeIndex];

    // Signed distance along outward normal from nearest edge point to particle.
    // Positive = outside hull (gap), negative = penetrating through wall.
    const signedDist =
      (lx - nearest.cx) * localNx + (ly - nearest.cy) * localNy;
    const penetration = signedDist - this.radius;

    if (penetration > 0.5) {
      this.disableAll(normal, friction1, friction2);
      return;
    }

    // Transform wall normal to world frame
    const R = hull.orientation;
    const wnx = R[0] * localNx + R[1] * localNy;
    const wny = R[3] * localNx + R[4] * localNy;
    const wnz = R[6] * localNx + R[7] * localNy;

    // Contact point on the wall in world space
    const [wx, wy, wz] = hull.toWorldFrame3D(nearest.cx, nearest.cy, lz);

    this._active = true;
    normal.enabled = true;

    // Lever arm from hull center to wall contact point
    const rjX = wx - hull.position[0];
    const rjY = wy - hull.position[1];
    const rjZ = wz - hull.z;

    // Normal equation Jacobian: pushes particle outward from wall
    this.setNormalJacobian(normal, wnx, wny, wnz, rjX, rjY, rjZ);

    const pen = penetration;
    normal.computeGq = () => pen;

    // Friction tangents for wall contact
    const normalForce = Math.abs(normal.multiplier);
    const slipForce = this.frictionCoefficient * normalForce;

    if (slipForce > 0) {
      friction1.enabled = true;
      friction1.minForce = -slipForce;
      friction1.maxForce = slipForce;
      friction2.enabled = true;
      friction2.minForce = -slipForce;
      friction2.maxForce = slipForce;
    } else {
      friction1.enabled = false;
      friction2.enabled = false;
    }

    // Tangent 1: along the hull edge in world space
    const t1lx = zLevel.edgeTx[nearest.edgeIndex];
    const t1ly = zLevel.edgeTy[nearest.edgeIndex];
    const t1x = R[0] * t1lx + R[1] * t1ly;
    const t1y = R[3] * t1lx + R[4] * t1ly;
    const t1z = R[6] * t1lx + R[7] * t1ly;

    // Tangent 2: hull Z axis (vertical along wall)
    const t2x = R[2];
    const t2y = R[5];
    const t2z = R[8];

    this.setFrictionJacobian(friction1, t1x, t1y, t1z, rjX, rjY, rjZ);
    this.setFrictionJacobian(friction2, t2x, t2y, t2z, rjX, rjY, rjZ);
  }

  // ── Bottom contact (outside, below hull) ─────────────────────────

  private updateBottomContact(
    lx: number,
    ly: number,
    lz: number,
    normal: Equation,
    friction1: Equation,
    friction2: Equation,
  ): void {
    const hull = this.bodyB;
    const R = hull.orientation;

    // Push particle downward (hull's -Z axis in world = away from hull interior)
    const nx = -R[2];
    const ny = -R[5];
    const nz = -R[8];

    // Contact point: on the hull bottom surface
    const [bx, by, bz] = hull.toWorldFrame3D(lx, ly, -this.boundary.draft);

    const px = this.bodyA.position[0];
    const py = this.bodyA.position[1];
    const pz = this.bodyA.z;

    const rawDist = nx * (px - bx) + ny * (py - by) + nz * (pz - bz);
    const penetration = rawDist - this.radius;

    if (penetration > 0.5) {
      this.disableAll(normal, friction1, friction2);
      return;
    }

    this._active = true;
    normal.enabled = true;

    const rjX = bx - hull.position[0];
    const rjY = by - hull.position[1];
    const rjZ = bz - hull.z;

    this.setNormalJacobian(normal, nx, ny, nz, rjX, rjY, rjZ);

    const pen = penetration;
    normal.computeGq = () => pen;

    // Friction on hull bottom: hull X and Y axes
    this.setFriction(normal, friction1, friction2, R, rjX, rjY, rjZ);
  }

  // ── Jacobian helpers ─────────────────────────────────────────────

  private setNormalJacobian(
    eq: Equation,
    nx: number,
    ny: number,
    nz: number,
    rjX: number,
    rjY: number,
    rjZ: number,
  ): void {
    const G = eq.G;
    G[0] = nx;
    G[1] = ny;
    G[2] = nz;
    G[3] = 0;
    G[4] = 0;
    G[5] = 0;
    G[6] = -nx;
    G[7] = -ny;
    G[8] = -nz;
    G[9] = -(rjY * nz - rjZ * ny);
    G[10] = -(rjZ * nx - rjX * nz);
    G[11] = -(rjX * ny - rjY * nx);
  }

  private setFrictionJacobian(
    eq: Equation,
    tx: number,
    ty: number,
    tz: number,
    rjX: number,
    rjY: number,
    rjZ: number,
  ): void {
    const G = eq.G;
    G[0] = tx;
    G[1] = ty;
    G[2] = tz;
    G[3] = 0;
    G[4] = 0;
    G[5] = 0;
    G[6] = -tx;
    G[7] = -ty;
    G[8] = -tz;
    G[9] = -(rjY * tz - rjZ * ty);
    G[10] = -(rjZ * tx - rjX * tz);
    G[11] = -(rjX * ty - rjY * tx);
  }

  /** Set up both friction equations using hull X/Y axes as tangents. */
  private setFriction(
    normal: Equation,
    friction1: Equation,
    friction2: Equation,
    R: Float64Array,
    rjX: number,
    rjY: number,
    rjZ: number,
  ): void {
    const normalForce = Math.abs(normal.multiplier);
    const slipForce = this.frictionCoefficient * normalForce;

    if (slipForce > 0) {
      friction1.enabled = true;
      friction1.minForce = -slipForce;
      friction1.maxForce = slipForce;
      friction2.enabled = true;
      friction2.minForce = -slipForce;
      friction2.maxForce = slipForce;
    } else {
      friction1.enabled = false;
      friction2.enabled = false;
    }

    // Tangent 1: hull's local X axis (forward) in world space
    this.setFrictionJacobian(friction1, R[0], R[3], R[6], rjX, rjY, rjZ);
    // Tangent 2: hull's local Y axis (starboard) in world space
    this.setFrictionJacobian(friction2, R[1], R[4], R[7], rjX, rjY, rjZ);
  }

  // ── Geometry helpers ─────────────────────────────────────────────

  /** Point-in-polygon test (ray-casting) on flat arrays. */
  private pointInPolygon(
    level: HullBoundaryLevel,
    px: number,
    py: number,
  ): boolean {
    const n = level.count;
    const vx = level.vx;
    const vy = level.vy;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = vy[i],
        yj = vy[j];
      if (
        yi > py !== yj > py &&
        px < ((vx[j] - vx[i]) * (py - yi)) / (yj - yi) + vx[i]
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  /** Find the nearest point on the hull polygon boundary at a given z-level. */
  private findNearestEdge(
    level: HullBoundaryLevel,
    px: number,
    py: number,
  ): { edgeIndex: number; cx: number; cy: number; distSq: number } {
    const n = level.count;
    const vx = level.vx;
    const vy = level.vy;

    let bestDistSq = Infinity;
    let bestIdx = 0;
    let bestCx = 0;
    let bestCy = 0;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = vx[i],
        ay = vy[i];
      const ex = vx[j] - ax;
      const ey = vy[j] - ay;
      const lenSq = ex * ex + ey * ey;

      // Project point onto edge, clamped to [0, 1]
      let t: number;
      if (lenSq < 1e-16) {
        t = 0;
      } else {
        t = ((px - ax) * ex + (py - ay) * ey) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
      }

      const cx = ax + t * ex;
      const cy = ay + t * ey;
      const dx = px - cx;
      const dy = py - cy;
      const dSq = dx * dx + dy * dy;

      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        bestIdx = i;
        bestCx = cx;
        bestCy = cy;
      }
    }

    return { edgeIndex: bestIdx, cx: bestCx, cy: bestCy, distSq: bestDistSq };
  }

  /** Find the hull outline level at or just below the given z-height (conservative: narrower). */
  private findLevelForZ(z: number): HullBoundaryLevel | null {
    const levels = this.boundary.levels;
    if (levels.length === 0) return null;

    // Below everything → use bottom level
    if (z <= levels[0].z) return levels[0];

    // Walk up to find the level at or just below z
    for (let i = levels.length - 1; i >= 0; i--) {
      if (levels[i].z <= z) return levels[i];
    }
    return levels[0];
  }

  private disableAll(
    normal: Equation,
    friction1: Equation,
    friction2: Equation,
  ): void {
    normal.enabled = false;
    friction1.enabled = false;
    friction2.enabled = false;
    this._active = false;
  }

  /** Reset warm-starting impulses on state transition to prevent stale directional impulses. */
  private resetWarmStart(): void {
    for (const eq of this.equations) {
      eq.warmLambda = 0;
      eq.multiplier = 0;
    }
  }

  /** Whether the constraint is currently active (particle on/near a surface). */
  isActive(): boolean {
    return this._active;
  }

  /** Whether the particle is currently inside the hull. */
  isInside(): boolean {
    return this.inside;
  }
}
