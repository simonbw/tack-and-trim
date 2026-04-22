/**
 * Decorative free-end tail: a short Verlet chain attached at the last node
 * of a rope network. Gravity + drag; no rope-to-rope coupling. Provides
 * the visual flop / swing / coil the capstan-network physics doesn't
 * simulate.
 *
 * The tail does not feed back into the rope network's tension — it's pure
 * decoration. Its first particle is pinned to the anchor node's worldPos
 * each tick; subsequent particles hang from it under gravity.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { GameEventMap } from "../../core/entity/Entity";
import { V3d } from "../../core/Vector3";
import type { RopeNodeRef } from "./RopeNode";

/** Gravity applied to tail particles (ft/s²). Mild — tails are lightweight. */
const TAIL_GRAVITY = 18;
/** Linear damping per tick (fraction of velocity retained). */
const TAIL_DAMPING = 0.92;
/** Verlet constraint iterations per tick. */
const TAIL_ITERATIONS = 4;

export interface RopeTailConfig {
  /** Total length of the tail (ft). Segments are this / (count - 1). */
  length: number;
  /** Number of particles in the chain. Default 7. */
  count?: number;
}

export class RopeTail extends BaseEntity {
  private readonly anchorNode: RopeNodeRef;
  private readonly positions: V3d[];
  private readonly prevPositions: V3d[];
  private readonly restSegmentLength: number;
  private totalLength: number;

  constructor(anchorNode: RopeNodeRef, config: RopeTailConfig) {
    super();
    this.anchorNode = anchorNode;
    this.totalLength = Math.max(0.1, config.length);
    const count = Math.max(2, config.count ?? 7);
    this.restSegmentLength = this.totalLength / (count - 1);

    // Seed all particles at the anchor position so the tail hangs straight
    // down over the first few ticks (gravity pulls them apart).
    const a = anchorNode.worldPos;
    this.positions = [];
    this.prevPositions = [];
    for (let i = 0; i < count; i++) {
      this.positions.push(new V3d(a[0], a[1], a[2] - i * 0.001));
      this.prevPositions.push(new V3d(a[0], a[1], a[2] - i * 0.001));
    }
  }

  /** Update tail length (e.g., when rope ease/trim changes available tail). */
  setLength(length: number): void {
    this.totalLength = Math.max(0.1, length);
    // Note: `restSegmentLength` is fixed at construction. When length grows,
    // the tail stretches rather than spawning particles; when it shrinks,
    // particles crowd together. This is good enough for decoration.
  }

  getPositions(): readonly V3d[] {
    return this.positions;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Pin particle 0 to the anchor.
    const a = this.anchorNode.worldPos;
    this.positions[0][0] = a[0];
    this.positions[0][1] = a[1];
    this.positions[0][2] = a[2];
    this.prevPositions[0][0] = a[0];
    this.prevPositions[0][1] = a[1];
    this.prevPositions[0][2] = a[2];

    // Verlet integration for the rest.
    const g = TAIL_GRAVITY * dt * dt;
    const damping = TAIL_DAMPING;
    for (let i = 1; i < this.positions.length; i++) {
      const p = this.positions[i];
      const prev = this.prevPositions[i];
      const vx = (p[0] - prev[0]) * damping;
      const vy = (p[1] - prev[1]) * damping;
      const vz = (p[2] - prev[2]) * damping;
      prev[0] = p[0];
      prev[1] = p[1];
      prev[2] = p[2];
      p[0] += vx;
      p[1] += vy;
      p[2] += vz - g;
    }

    // Segment-length constraints. Length scales with totalLength so an
    // eased-out tail visibly lengthens.
    const segLen =
      (this.totalLength / (this.positions.length - 1)) *
      (this.totalLength >
      this.restSegmentLength * (this.positions.length - 1) * 1.5
        ? 1.5
        : 1);
    for (let iter = 0; iter < TAIL_ITERATIONS; iter++) {
      for (let i = 0; i < this.positions.length - 1; i++) {
        const a = this.positions[i];
        const b = this.positions[i + 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const dz = b[2] - a[2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const diff = (d - segLen) / d;
        // Pin particle 0 (i=0). For i>0, distribute correction between the two.
        if (i === 0) {
          b[0] -= dx * diff;
          b[1] -= dy * diff;
          b[2] -= dz * diff;
        } else {
          const half = diff * 0.5;
          a[0] += dx * half;
          a[1] += dy * half;
          a[2] += dz * half;
          b[0] -= dx * half;
          b[1] -= dy * half;
          b[2] -= dz * half;
        }
      }
    }
  }
}
