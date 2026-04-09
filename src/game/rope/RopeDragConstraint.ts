/**
 * Applies quadratic fluid drag to rope particles based on their medium.
 *
 * Owns its own WindQuery and/or WaterQuery so the caller just needs:
 *   this.addChild(new RopeDragConstraint(particles, { airDrag: true, waterDrag: true, ... }))
 *
 * Drag model: F = −0.5 · ρ · Cd · A · |v_rel|² · v̂_rel
 * where v_rel is particle velocity minus fluid velocity (wind or current).
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import { V, V2d } from "../../core/Vector";
import { LBF_TO_ENGINE, RHO_AIR, RHO_WATER } from "../physics-constants";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";

export interface RopeDragOptions {
  /** Apply aerodynamic drag above the water surface. Default false. */
  airDrag?: boolean;
  /** Apply hydrodynamic drag below the water surface. Default false. */
  waterDrag?: boolean;
  /** Rope diameter in feet (drag area). Default 0.026 (5/16"). */
  ropeDiameter?: number;
  /** Drag coefficient for cylinder cross-section. Default 1.2. */
  ropeDragCd?: number;
  /** Rest length of one chain link (uniform segment spacing). */
  chainLinkLength: number;
}

export class RopeDragConstraint extends BaseEntity {
  private particles: DynamicBody[];
  private queryPoints: V2d[];
  private readonly airDrag: boolean;
  private readonly waterDrag: boolean;
  private readonly dragHalfCdA: number;

  private windQuery: WindQuery | null = null;
  private waterQuery: WaterQuery | null = null;

  constructor(
    particles: DynamicBody[] | readonly DynamicBody[],
    options: RopeDragOptions,
  ) {
    super();

    this.particles = [...particles];
    this.airDrag = options.airDrag ?? false;
    this.waterDrag = options.waterDrag ?? false;

    const cd = options.ropeDragCd ?? 1.2;
    const diameter = options.ropeDiameter ?? 0.026;
    this.dragHalfCdA = 0.5 * cd * diameter * options.chainLinkLength;

    this.queryPoints = this.particles.map((p) =>
      V(p.position[0], p.position[1]),
    );

    if (this.airDrag) {
      this.windQuery = this.addChild(new WindQuery(() => this.queryPoints));
    }
    if (this.waterDrag) {
      this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
    }
  }

  @on("tick")
  onTick(): void {
    const particles = this.particles;

    // Sync query points with particle positions
    for (let i = 0; i < particles.length; i++) {
      this.queryPoints[i].set(
        particles[i].position[0],
        particles[i].position[1],
      );
    }

    const halfCdA = this.dragHalfCdA;
    const bothMedia = this.airDrag && this.waterDrag;
    const waterAvail = this.waterQuery != null && this.waterQuery.length > 0;
    const windAvail = this.windQuery != null && this.windQuery.length > 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      let rho: number;
      let fluidVx: number;
      let fluidVy: number;

      if (bothMedia && waterAvail) {
        // Both media: use water surface height to pick air vs water
        const water = this.waterQuery!.get(i);
        if (p.z <= water.surfaceHeight) {
          rho = RHO_WATER;
          const wv = water.velocity;
          fluidVx = wv.x;
          fluidVy = wv.y;
        } else if (windAvail) {
          rho = RHO_AIR;
          const wv = this.windQuery!.get(i).velocity;
          fluidVx = wv.x;
          fluidVy = wv.y;
        } else {
          continue;
        }
      } else if (this.waterDrag && waterAvail) {
        // Water drag only
        rho = RHO_WATER;
        const wv = this.waterQuery!.get(i).velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else if (this.airDrag && windAvail) {
        // Air drag only
        rho = RHO_AIR;
        const wv = this.windQuery!.get(i).velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else {
        continue;
      }

      // Relative velocity: particle velocity minus fluid velocity
      const vrx = p.velocity[0] - fluidVx;
      const vry = p.velocity[1] - fluidVy;
      const vrz = p.zVelocity; // fluid has no vertical component
      const vrMag = Math.sqrt(vrx * vrx + vry * vry + vrz * vrz);
      if (vrMag < 0.001) continue;

      // F = -0.5 * rho * Cd * A * |v_rel| * v_rel, converted to engine units
      const forceMag = rho * halfCdA * vrMag * vrMag * LBF_TO_ENGINE;
      const clampedMag = Math.min(forceMag, 1e6);
      const s = -clampedMag / vrMag;
      p.applyForce3D(s * vrx, s * vry, s * vrz, 0, 0, 0);
    }
  }
}
