/**
 * A single rope particle: owns its physics body, optional fluid drag,
 * optional deck contact, and optional terrain floor constraint.
 *
 * Each particle is a lightweight BaseEntity added as a child of the
 * rope's owner (Sheet, Anchor, etc). Per-particle queries (wind, water,
 * terrain) are owned as children — the QueryManager batches all queries
 * into a single GPU dispatch regardless of how many exist, so per-particle
 * ownership has no GPU cost.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import {
  DeckContactConstraint,
  type HullBoundaryData,
} from "../../core/physics/constraints/DeckContactConstraint";
import { V, V2d } from "../../core/Vector";
import { LBF_TO_ENGINE, RHO_AIR, RHO_WATER } from "../physics-constants";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";

export interface RopeParticleConfig {
  mass: number;
  damping: number;
  position: [number, number];
  zPosition: number;
  initialVelocity?: [number, number];
  gravity: number;

  drag?: {
    airDrag: boolean;
    waterDrag: boolean;
    /** Precomputed 0.5 * Cd * diameter * chainLinkLength. */
    halfCdA: number;
  };

  deckContact?: {
    hullBody: Body;
    getDeckHeight: (localX: number, localY: number) => number | null;
    hullBoundary: HullBoundaryData;
    frictionCoefficient: number;
    ropeRadius: number;
  };

  terrainFloor?: {
    floorFriction: number;
  };
}

export class RopeParticle extends BaseEntity {
  body: DynamicBody;

  private readonly gravity: number;

  // Drag state
  private readonly airDrag: boolean;
  private readonly waterDrag: boolean;
  private readonly dragHalfCdA: number;

  // Terrain floor
  private readonly floorFriction: number;
  private readonly hasTerrainFloor: boolean;

  // Single-point query infrastructure
  private readonly queryPoint: V2d;
  private readonly queryPoints: V2d[];
  private windQuery: WindQuery | null = null;
  private waterQuery: WaterQuery | null = null;
  private terrainQuery: TerrainQuery | null = null;

  constructor(config: RopeParticleConfig) {
    super();

    this.body = new DynamicBody({
      mass: config.mass,
      position: config.position,
      fixedRotation: true,
      damping: config.damping,
      allowSleep: false,
      sixDOF: {
        rollInertia: 1,
        pitchInertia: 1,
        zMass: config.mass,
        zDamping: config.damping,
        rollPitchDamping: 0,
        zPosition: config.zPosition,
      },
    });

    if (config.initialVelocity) {
      this.body.velocity[0] = config.initialVelocity[0];
      this.body.velocity[1] = config.initialVelocity[1];
    }

    this.gravity = config.gravity;

    // Drag
    this.airDrag = config.drag?.airDrag ?? false;
    this.waterDrag = config.drag?.waterDrag ?? false;
    this.dragHalfCdA = config.drag?.halfCdA ?? 0;

    // Query point (single-element array, pre-allocated)
    this.queryPoint = V(config.position[0], config.position[1]);
    this.queryPoints = [this.queryPoint];

    const needsWater = this.waterDrag || config.terrainFloor != null;

    if (this.airDrag) {
      this.windQuery = this.addChild(new WindQuery(() => this.queryPoints));
    }
    if (needsWater) {
      this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
    }

    // Deck contact constraint
    if (config.deckContact) {
      const dc = config.deckContact;
      this.constraints = [
        new DeckContactConstraint(
          this.body,
          dc.hullBody,
          dc.getDeckHeight,
          dc.hullBoundary,
          dc.frictionCoefficient,
          dc.ropeRadius,
          { collideConnected: true, wakeUpBodies: false },
        ),
      ];
    }

    // Terrain floor
    this.hasTerrainFloor = config.terrainFloor != null;
    this.floorFriction = config.terrainFloor?.floorFriction ?? 0;
    if (this.hasTerrainFloor) {
      this.terrainQuery = this.addChild(
        new TerrainQuery(() => this.queryPoints),
      );
    }
  }

  @on("tick")
  onTick(): void {
    const p = this.body;

    // Sync query point with body position
    this.queryPoint.set(p.position[0], p.position[1]);

    // Gravity
    if (this.gravity > 0) {
      p.applyForce3D(0, 0, -this.gravity * p.mass, 0, 0, 0);
    }

    // Fluid drag
    this.applyDrag(p);

    // Terrain floor
    this.applyTerrainFloor(p);
  }

  private applyDrag(p: DynamicBody): void {
    const halfCdA = this.dragHalfCdA;
    if (halfCdA <= 0) return;

    const waterAvail = this.waterQuery != null && this.waterQuery.length > 0;
    const windAvail = this.windQuery != null && this.windQuery.length > 0;
    const bothMedia = this.airDrag && this.waterDrag;

    let rho: number;
    let fluidVx: number;
    let fluidVy: number;

    if (bothMedia && waterAvail) {
      const water = this.waterQuery!.get(0);
      if (p.z <= water.surfaceHeight) {
        rho = RHO_WATER;
        const wv = water.velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else if (windAvail) {
        rho = RHO_AIR;
        const wv = this.windQuery!.get(0).velocity;
        fluidVx = wv.x;
        fluidVy = wv.y;
      } else {
        return;
      }
    } else if (this.waterDrag && waterAvail) {
      rho = RHO_WATER;
      const wv = this.waterQuery!.get(0).velocity;
      fluidVx = wv.x;
      fluidVy = wv.y;
    } else if (this.airDrag && windAvail) {
      rho = RHO_AIR;
      const wv = this.windQuery!.get(0).velocity;
      fluidVx = wv.x;
      fluidVy = wv.y;
    } else {
      return;
    }

    // Relative velocity: particle velocity minus fluid velocity
    const vrx = p.velocity[0] - fluidVx;
    const vry = p.velocity[1] - fluidVy;
    const vrz = p.zVelocity; // fluid has no vertical component
    const vrMag = Math.sqrt(vrx * vrx + vry * vry + vrz * vrz);
    if (vrMag < 0.001) return;

    // F = -0.5 * rho * Cd * A * |v_rel|² * v̂_rel, converted to engine units
    const forceMag = rho * halfCdA * vrMag * vrMag * LBF_TO_ENGINE;
    const clampedMag = Math.min(forceMag, 1e6);
    const s = -clampedMag / vrMag;
    p.applyForce3D(s * vrx, s * vry, s * vrz, 0, 0, 0);
  }

  private applyTerrainFloor(p: DynamicBody): void {
    if (!this.hasTerrainFloor) return;
    if (
      this.terrainQuery == null ||
      this.terrainQuery.length === 0 ||
      this.waterQuery == null ||
      this.waterQuery.length === 0
    ) {
      return;
    }

    const terrainHeight = this.terrainQuery.get(0).height;
    const surfaceHeight = this.waterQuery.get(0).surfaceHeight;
    const floorZ = terrainHeight - surfaceHeight;

    if (p.z < floorZ) {
      p.z = floorZ;
      if (p.zVelocity < 0) p.zVelocity = 0;
      p.velocity.imul(1 - this.floorFriction);
    }
  }
}
