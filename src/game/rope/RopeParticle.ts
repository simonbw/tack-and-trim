/**
 * A single rope particle: owns its physics body, gravity, and optional
 * deck-contact and terrain-floor constraints.
 *
 * Drag and chain constraints live on RopeSegment (between adjacent particles)
 * because they need a direction vector that a single point doesn't have.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import type { DynamicPointMass3D } from "../../core/physics/body/bodyInterfaces";
import { createPointMass3D } from "../../core/physics/body/bodyFactories";
import {
  DeckContactConstraint,
  type HullBoundaryData,
} from "../../core/physics/constraints/DeckContactConstraint";
import { V, V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";

export interface RopeParticleConfig {
  mass: number;
  damping: number;
  position: [number, number];
  zPosition: number;
  initialVelocity?: [number, number];
  gravity: number;

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
  body: Body & DynamicPointMass3D;

  private readonly gravity: number;

  // Terrain floor
  private readonly floorFriction: number;
  private readonly hasTerrainFloor: boolean;

  // Single-point query infrastructure (only used for terrain floor)
  private queryPoint: V2d | null = null;
  private queryPoints: V2d[] | null = null;
  private waterQuery: WaterQuery | null = null;
  private terrainQuery: TerrainQuery | null = null;

  constructor(config: RopeParticleConfig) {
    super();

    this.body = createPointMass3D({
      motion: "dynamic",
      mass: config.mass,
      position: config.position,
      damping: config.damping,
      allowSleep: false,
      zMass: config.mass,
      zDamping: config.damping,
      z: config.zPosition,
    });

    if (config.initialVelocity) {
      this.body.velocity[0] = config.initialVelocity[0];
      this.body.velocity[1] = config.initialVelocity[1];
    }

    this.gravity = config.gravity;

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
      this.queryPoint = V(config.position[0], config.position[1]);
      this.queryPoints = [this.queryPoint];
      this.terrainQuery = this.addChild(
        new TerrainQuery(() => this.queryPoints!),
      );
      this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints!));
    }
  }

  @on("tick")
  onTick(): void {
    const p = this.body;

    // Gravity
    if (this.gravity > 0) {
      p.applyForce3D(0, 0, -this.gravity * p.mass, 0, 0, 0);
    }

    // Terrain floor
    this.applyTerrainFloor(p);
  }

  /**
   * Whether this particle is currently inside the hull (on the cockpit/deck
   * side of the deck outline). Returns false if the particle has no
   * deck-contact constraint.
   */
  isInside(): boolean {
    const constraint = this.getDeckContact();
    return constraint != null ? constraint.isInside() : false;
  }

  /**
   * The particle's {@link DeckContactConstraint}, or null if this particle
   * has no deck contact configured. Used by {@link RopeSegment}'s wrap
   * constraint, which needs the per-particle inside/outside flag each
   * substep.
   */
  getDeckContact(): DeckContactConstraint | null {
    const constraint = this.constraints?.[0];
    return constraint instanceof DeckContactConstraint ? constraint : null;
  }

  private applyTerrainFloor(p: Body & DynamicPointMass3D): void {
    if (!this.hasTerrainFloor) return;
    if (
      this.terrainQuery == null ||
      this.terrainQuery.length === 0 ||
      this.waterQuery == null ||
      this.waterQuery.length === 0
    ) {
      return;
    }

    // Sync query point to current position
    this.queryPoint!.set(p.position[0], p.position[1]);

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
