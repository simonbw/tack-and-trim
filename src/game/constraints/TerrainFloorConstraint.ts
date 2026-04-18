/**
 * Keeps a set of 6DOF bodies above the terrain floor.
 *
 * Owns its own TerrainQuery and WaterQuery so the caller just needs:
 *   this.addChild(new TerrainFloorConstraint(bodies))
 *
 * Each tick, clamps body.z to terrainHeight − waterSurfaceHeight and
 * applies floor friction to XY velocity on contact.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Body } from "../../core/physics/body/Body";
import { V, V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";

export interface TerrainFloorOptions {
  /** Friction coefficient applied to XY velocity when resting on the floor. Default 0.8. */
  floorFriction?: number;
}

export class TerrainFloorConstraint extends BaseEntity {
  private constrainedBodies: Body[];
  private queryPoints: V2d[];
  private terrainQuery: TerrainQuery;
  private waterQuery: WaterQuery;
  private floorFriction: number;

  constructor(
    bodies: Body[] | readonly Body[],
    options?: TerrainFloorOptions,
  ) {
    super();

    this.constrainedBodies = [...bodies];
    this.floorFriction = options?.floorFriction ?? 0.8;
    this.queryPoints = this.constrainedBodies.map((b) =>
      V(b.position[0], b.position[1]),
    );
    this.terrainQuery = this.addChild(new TerrainQuery(() => this.queryPoints));
    this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
  }

  @on("tick")
  onTick(): void {
    const bodies = this.constrainedBodies;

    // Sync query points with body positions
    for (let i = 0; i < bodies.length; i++) {
      this.queryPoints[i].set(bodies[i].position[0], bodies[i].position[1]);
    }

    if (this.terrainQuery.length === 0 || this.waterQuery.length === 0) return;

    for (let i = 0; i < bodies.length; i++) {
      if (i >= this.terrainQuery.length || i >= this.waterQuery.length) {
        continue;
      }

      const terrainHeight = this.terrainQuery.get(i).height;
      const surfaceHeight = this.waterQuery.get(i).surfaceHeight;
      const floorZ = terrainHeight - surfaceHeight;

      const body = bodies[i];
      if (body.z < floorZ) {
        body.z = floorZ;
        if (body.zVelocity < 0) body.zVelocity = 0;
        body.velocity.imul(1 - this.floorFriction);
      }
    }
  }
}
