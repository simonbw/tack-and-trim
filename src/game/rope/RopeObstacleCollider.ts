/**
 * Per-rope obstacle collision collider.
 *
 * Each tick, iterates rope segments against a shared obstacle registry. When
 * a segment crosses an obstacle, activates a pulley-style wrap constraint
 * with the pivot at the geometrically-correct bend point. The pool of
 * pulley constraints is pre-allocated at construction; individual slots are
 * enabled/disabled per tick as contacts come and go.
 *
 * V1 supports gunwale-edge obstacles only. The prefilter uses the per-
 * particle inside/outside flag from DeckContactConstraint, so the rope must
 * have deck-contact constraints on its particles for the collider to do
 * anything useful.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import { PulleyConstraint3D } from "../../core/physics/constraints/PulleyConstraint3D";
import type { Rope } from "./Rope";
import type { GunwaleEdgeObstacle, RopeObstacle } from "./RopeObstacle";

/** Maximum simultaneous rope-obstacle contacts per rope. */
const DEFAULT_POOL_SIZE = 8;

/** How far above deckHeight a segment may sit before we skip obstacle tests. */
const Z_GATE_SLACK = 0.25;

/** Gunwale contact friction (Coulomb). Tunable. */
const GUNWALE_FRICTION = 0.3;

interface PoolSlot {
  constraint: PulleyConstraint3D;
  /** Segment index (particle i, particle i+1) this slot tracks, or -1 if free. */
  segIdx: number;
  /** Obstacle reference this slot tracks, or null if free. */
  obstacle: RopeObstacle | null;
}

interface Contact {
  segIdx: number;
  obstacle: GunwaleEdgeObstacle;
  bx: number;
  by: number;
  bz: number;
}

export class RopeObstacleCollider extends BaseEntity {
  private pool: PoolSlot[] = [];
  private workList: Contact[] = [];
  private poolTouched: boolean[] = [];
  private chainLinkLength: number = 0;

  constructor(
    private readonly rope: Rope,
    private readonly hullBody: Body,
    private readonly obstacles: readonly RopeObstacle[],
    poolSize: number = DEFAULT_POOL_SIZE,
  ) {
    super();

    const particles = this.rope.getParticles();
    if (particles.length < 2 || this.obstacles.length === 0) return;

    this.chainLinkLength = this.rope.getChainLinkLength();
    const constraints: PulleyConstraint3D[] = [];
    for (let i = 0; i < poolSize; i++) {
      // Initial totalLength = Infinity so the constraint self-disables
      // (its update() sets sumEquation.enabled = false when position <=
      // totalLength). When a contact activates, totalLength is set to
      // chainLinkLength; on deactivation, back to Infinity.
      const c = new PulleyConstraint3D(
        particles[0],
        particles[1],
        this.hullBody,
        {
          localAnchorA: [0, 0, 0],
          localAnchorB: [0, 0, 0],
          localAnchorC: [0, 0, 0],
          totalLength: Number.POSITIVE_INFINITY,
          collideConnected: true,
          radius: 0,
        },
      );
      c.frictionCoefficient = GUNWALE_FRICTION;
      constraints.push(c);
      this.pool.push({ constraint: c, segIdx: -1, obstacle: null });
      this.poolTouched.push(false);
    }
    this.constraints = constraints;
  }

  @on("tick")
  onTick(): void {
    const pool = this.pool;
    if (pool.length === 0) return;

    const rope = this.rope;
    const hull = this.hullBody;
    const particleEntities = rope.getParticleEntities();
    const particles = rope.getParticles();
    const numParticles = particles.length;
    if (numParticles < 2) return;

    const workList = this.workList;
    workList.length = 0;

    // Phase 1: gather active contacts.
    for (let i = 0; i < numParticles - 1; i++) {
      const p1e = particleEntities[i];
      const p2e = particleEntities[i + 1];
      const p1In = p1e.isInside();
      const p2In = p2e.isInside();
      // Gunwale prefilter: only segments that straddle the hull boundary can
      // cross a gunwale edge.
      if (p1In === p2In) continue;

      const p1 = particles[i];
      const p2 = particles[i + 1];

      // Convert to hull-local 3D.
      const [p1lx, p1ly, p1lz] = hull.toLocalFrame3D(
        p1.position[0],
        p1.position[1],
        p1.z,
      );
      const [p2lx, p2ly, p2lz] = hull.toLocalFrame3D(
        p2.position[0],
        p2.position[1],
        p2.z,
      );

      for (const obstacle of this.obstacles) {
        if (obstacle.kind !== "gunwaleEdge") continue;

        // Z gate: both particles well above the gunwale → no contact.
        if (
          p1lz > obstacle.z + Z_GATE_SLACK &&
          p2lz > obstacle.z + Z_GATE_SLACK
        ) {
          continue;
        }

        // 2D segment-vs-edge intersection. Returns the edge parameter t in
        // [0, 1] if the segments cross, or -1 otherwise.
        const t = segmentEdgeIntersection(
          p1lx,
          p1ly,
          p2lx,
          p2ly,
          obstacle.ax,
          obstacle.ay,
          obstacle.bx,
          obstacle.by,
        );
        if (t < 0) continue;

        const bx = obstacle.ax + t * (obstacle.bx - obstacle.ax);
        const by = obstacle.ay + t * (obstacle.by - obstacle.ay);
        workList.push({ segIdx: i, obstacle, bx, by, bz: obstacle.z });
      }
    }

    // Phase 2: reconcile work list against pool.
    const poolTouched = this.poolTouched;
    for (let s = 0; s < pool.length; s++) poolTouched[s] = false;

    for (const contact of workList) {
      // Try to find an existing slot with matching (segIdx, obstacle).
      let slotIdx = -1;
      for (let s = 0; s < pool.length; s++) {
        if (poolTouched[s]) continue;
        const slot = pool[s];
        if (
          slot.segIdx === contact.segIdx &&
          slot.obstacle === contact.obstacle
        ) {
          slotIdx = s;
          break;
        }
      }
      // Otherwise, grab any untouched slot (prefer empty, then reassign).
      if (slotIdx === -1) {
        for (let s = 0; s < pool.length; s++) {
          if (!poolTouched[s] && pool[s].obstacle === null) {
            slotIdx = s;
            break;
          }
        }
      }
      if (slotIdx === -1) {
        for (let s = 0; s < pool.length; s++) {
          if (!poolTouched[s]) {
            slotIdx = s;
            break;
          }
        }
      }
      if (slotIdx === -1) break; // pool exhausted — drop the overflow

      poolTouched[slotIdx] = true;
      const slot = pool[slotIdx];
      const c = slot.constraint;

      const bindingChanged =
        slot.segIdx !== contact.segIdx || slot.obstacle !== contact.obstacle;

      // Rebind particles if needed.
      const p1 = particles[contact.segIdx];
      const p2 = particles[contact.segIdx + 1];
      if (c.bodyA !== p1) {
        c.setParticleA(p1, [0, 0, 0]);
      }
      if (c.bodyB !== p2) {
        c.setParticleB(p2, [0, 0, 0]);
      }
      // Update pivot in place — the pulley constraint re-reads localAnchorC
      // every update() call.
      c.localAnchorC[0] = contact.bx;
      c.localAnchorC[1] = contact.by;
      c.localAnchorC[2] = contact.bz;

      // Set the active totalLength. PulleyConstraint3D's update() enables
      // sumEquation whenever position > totalLength; we don't toggle enabled
      // manually. Friction is also self-managed by the constraint.
      c.totalLength = this.chainLinkLength;

      if (bindingChanged) {
        // Clear stale warm-start multipliers from the slot's previous binding.
        for (const eq of c.equations) {
          eq.multiplier = 0;
        }
      }

      slot.segIdx = contact.segIdx;
      slot.obstacle = contact.obstacle;
    }

    // Phase 3: deactivate untouched slots by setting totalLength = Infinity,
    // which forces the constraint's update() to see position <= totalLength
    // and disable the sum equation.
    for (let s = 0; s < pool.length; s++) {
      if (poolTouched[s]) continue;
      const slot = pool[s];
      if (slot.obstacle === null) continue;
      slot.constraint.totalLength = Number.POSITIVE_INFINITY;
      for (const eq of slot.constraint.equations) {
        eq.multiplier = 0;
      }
      slot.segIdx = -1;
      slot.obstacle = null;
    }
  }
}

/**
 * 2D segment vs segment intersection.
 *
 * Returns the parameter `t` along the (a,b) segment where the two segments
 * cross, or -1 if they do not cross within their respective [0, 1] ranges.
 */
function segmentEdgeIntersection(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const d1x = p2x - p1x;
  const d1y = p2y - p1y;
  const d2x = bx - ax;
  const d2y = by - ay;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return -1; // parallel
  const ex = ax - p1x;
  const ey = ay - p1y;
  const s = (ex * d2y - ey * d2x) / denom;
  if (s < 0 || s > 1) return -1;
  const t = (ex * d1y - ey * d1x) / denom;
  if (t < 0 || t > 1) return -1;
  return t;
}
