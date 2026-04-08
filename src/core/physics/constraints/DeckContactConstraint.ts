import type { Body } from "../body/Body";
import { Equation } from "../equations/Equation";
import { Constraint, type ConstraintOptions } from "./Constraint";

/**
 * Surface contact constraint that keeps a particle above a tilting deck surface,
 * with Coulomb friction to resist sliding.
 *
 * Three equations:
 * - **Normal** (unilateral): prevents the particle from penetrating the deck.
 *   Active only when the particle is near/below the deck surface.
 * - **Friction 1 & 2** (bounded bilateral): resist tangential sliding along
 *   the deck plane. Force bounds = μ × normal force from the previous frame.
 *
 * The deck surface is defined by a callback `getDeckHeight(localX, localY)`
 * that returns the surface z-height in bodyB's local frame, or null if the
 * point is not over a surface. The deck normal and tangent vectors are derived
 * from bodyB's 3D orientation matrix, so they rotate correctly with pitch and roll.
 */
export class DeckContactConstraint extends Constraint {
  /** Callback returning deck z-height in bodyB-local coords, or null. */
  private getDeckHeight: (localX: number, localY: number) => number | null;

  /** Coulomb friction coefficient (0 = frictionless). */
  frictionCoefficient: number;

  /** Rope radius (ft). The particle center rests this far above the deck surface. */
  radius: number;

  /** Whether the constraint is currently engaged (particle on or near deck). */
  private _active: boolean = false;

  constructor(
    particle: Body,
    hullBody: Body,
    getDeckHeight: (localX: number, localY: number) => number | null,
    frictionCoefficient: number = 0.5,
    radius: number = 0,
    options?: ConstraintOptions,
  ) {
    super(particle, hullBody, options);

    this.getDeckHeight = getDeckHeight;
    this.frictionCoefficient = frictionCoefficient;
    this.radius = radius;

    // Normal equation: unilateral (can only push particle away from deck)
    const normal = new Equation(particle, hullBody, 0, Number.MAX_VALUE);

    // Friction equations: pure velocity constraints, no position error.
    // Force bounds are updated dynamically from the normal force.
    const friction1 = new Equation(particle, hullBody, 0, 0);
    const friction2 = new Equation(particle, hullBody, 0, 0);
    friction1.computeGq = () => 0;
    friction2.computeGq = () => 0;

    this.equations = [normal, friction1, friction2];
  }

  update(): this {
    const particle = this.bodyA;
    const hull = this.bodyB;
    const normal = this.equations[0];
    const friction1 = this.equations[1];
    const friction2 = this.equations[2];

    // Convert particle world position to hull-local coordinates
    const [lx, ly] = hull.toLocalFrame3D(
      particle.position[0],
      particle.position[1],
      particle.z,
    );

    // Query deck height at this hull-local XY position
    const deckZ = this.getDeckHeight(lx, ly);

    if (deckZ === null) {
      // Particle is not over any deck zone
      normal.enabled = false;
      friction1.enabled = false;
      friction2.enabled = false;
      this._active = false;
      return this;
    }

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
    // (deck + rope radius) along the deck normal.
    // Positive = above surface, negative = penetrating.
    const rawDist = nx * (px - dx) + ny * (py - dy) + nz * (pz - dz);
    const penetration = rawDist - this.radius;

    // Disable when particle is well above deck — the normal equation would
    // produce zero force anyway (unilateral), but disabling avoids solver work
    // and prevents friction from engaging on high-flying particles.
    if (penetration > 0.5) {
      normal.enabled = false;
      friction1.enabled = false;
      friction2.enabled = false;
      this._active = false;
      return this;
    }

    this._active = true;
    normal.enabled = true;

    // Lever arm from hull center to deck contact point (world frame)
    const rjX = dx - hull.position[0];
    const rjY = dy - hull.position[1];
    const rjZ = dz - hull.z;

    // ---- Normal equation Jacobian ----
    // G = [+n, 0, -n, -(rj×n)]
    // Positive lambda pushes particle up along normal (away from deck).
    const Gn = normal.G;
    Gn[0] = nx;
    Gn[1] = ny;
    Gn[2] = nz;
    Gn[3] = 0;
    Gn[4] = 0;
    Gn[5] = 0;
    Gn[6] = -nx;
    Gn[7] = -ny;
    Gn[8] = -nz;
    Gn[9] = -(rjY * nz - rjZ * ny);
    Gn[10] = -(rjZ * nx - rjX * nz);
    Gn[11] = -(rjX * ny - rjY * nx);

    // Position error: penetration depth (negative when penetrating).
    // The solver drives Gq → 0, which pushes the particle to the surface.
    const pen = penetration;
    normal.computeGq = () => pen;

    // ---- Friction equations ----
    // Bounds from previous frame's normal force (1-frame lag, stable).
    const normalForce = Math.abs(normal.multiplier);
    const slipForce = this.frictionCoefficient * normalForce;

    // Only enable friction when we have a prior normal force estimate
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
    const t1x = R[0];
    const t1y = R[3];
    const t1z = R[6];

    // Tangent 2: hull's local Y axis (starboard) in world space
    const t2x = R[1];
    const t2y = R[4];
    const t2z = R[7];

    // Friction 1 Jacobian: G = [+t1, 0, -t1, -(rj×t1)]
    const Gf1 = friction1.G;
    Gf1[0] = t1x;
    Gf1[1] = t1y;
    Gf1[2] = t1z;
    Gf1[3] = 0;
    Gf1[4] = 0;
    Gf1[5] = 0;
    Gf1[6] = -t1x;
    Gf1[7] = -t1y;
    Gf1[8] = -t1z;
    Gf1[9] = -(rjY * t1z - rjZ * t1y);
    Gf1[10] = -(rjZ * t1x - rjX * t1z);
    Gf1[11] = -(rjX * t1y - rjY * t1x);

    // Friction 2 Jacobian: G = [+t2, 0, -t2, -(rj×t2)]
    const Gf2 = friction2.G;
    Gf2[0] = t2x;
    Gf2[1] = t2y;
    Gf2[2] = t2z;
    Gf2[3] = 0;
    Gf2[4] = 0;
    Gf2[5] = 0;
    Gf2[6] = -t2x;
    Gf2[7] = -t2y;
    Gf2[8] = -t2z;
    Gf2[9] = -(rjY * t2z - rjZ * t2y);
    Gf2[10] = -(rjZ * t2x - rjX * t2z);
    Gf2[11] = -(rjX * t2y - rjY * t2x);

    return this;
  }

  /** Whether the constraint is currently active (particle on/near deck). */
  isActive(): boolean {
    return this._active;
  }
}
