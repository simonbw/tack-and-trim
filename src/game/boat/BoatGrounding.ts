/**
 * Boat grounding physics.
 *
 * Applies friction forces when boat components contact terrain.
 * Checks keel (centerboard), rudder, and hull against terrain height.
 * Uses TerrainQuery for GPU-accelerated terrain lookups.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V, V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/query/TerrainQuery";
import type { Boat } from "./Boat";
import type { GroundingConfig } from "./BoatConfig";

/**
 * Boat grounding physics entity.
 * Applies friction when underwater components contact terrain.
 */
export class BoatGrounding extends BaseEntity {
  tickLayer = "physics" as const;

  private readonly boat: Boat;
  private readonly config: GroundingConfig;
  private readonly hullDraft: number;
  private readonly keelDraft: number;
  private readonly rudderDraft: number;

  private terrainQuery: TerrainQuery;

  constructor(boat: Boat) {
    super();
    this.boat = boat;
    this.config = boat.config.grounding;
    this.hullDraft = boat.config.hull.draft;
    this.keelDraft = boat.config.keel.draft;
    this.rudderDraft = boat.config.rudder.draft;

    // Create terrain query with callback that returns points to check
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => this.getQueryPoints()),
    );
  }

  /**
   * Get all points to query for terrain height.
   * Called each frame by TerrainQuery.
   */
  private getQueryPoints(): V2d[] {
    const hull = this.boat.hull;
    const body = hull.body;
    if (!body) return [];

    const points: V2d[] = [];

    // Add keel vertices
    for (const localPos of this.boat.config.keel.vertices) {
      points.push(body.toWorldFrame(localPos));
    }

    // Add rudder position
    points.push(body.toWorldFrame(this.boat.config.rudder.position));

    // Add hull center
    points.push(body.position);

    return points;
  }

  @on("tick")
  onTick() {
    const hull = this.boat.hull;
    const body = hull.body;

    // Get boat velocity for friction calculation
    const velocity = body.velocity;
    const speed = velocity.magnitude;

    // Skip grounding calculation if not moving
    if (speed < 0.01) return;

    // Get query results (returns empty if no results yet - one frame latency)
    const results = this.terrainQuery.results;
    if (results.length === 0) return;

    let totalForce = V(0, 0);

    // Results are in the same order as getQueryPoints():
    // [keel vertices..., rudder, hull center]
    const keelVertexCount = this.boat.config.keel.vertices.length;

    // Check keel grounding
    for (let i = 0; i < keelVertexCount; i++) {
      const terrainHeight = results[i].height;

      // Keel penetration: terrain height + keel draft
      // If terrain is above water level by terrainHeight, and keel extends
      // keelDraft below water, they intersect when terrainHeight > -keelDraft
      const penetration = terrainHeight - -this.keelDraft;

      if (penetration > 0) {
        const friction = this.computeFriction(
          penetration,
          speed,
          this.config.keelFriction,
        );
        totalForce.isub(velocity.normalize().mul(friction));
      }
    }

    // Check rudder grounding
    const rudderResult = results[keelVertexCount];
    if (rudderResult) {
      const rudderPenetration = rudderResult.height - -this.rudderDraft;

      if (rudderPenetration > 0) {
        const friction = this.computeFriction(
          rudderPenetration,
          speed,
          this.config.rudderFriction,
        );
        totalForce.isub(velocity.normalize().mul(friction));
      }
    }

    // Check hull grounding
    const hullResult = results[keelVertexCount + 1];
    if (hullResult) {
      const hullPenetration = hullResult.height - -this.hullDraft;

      if (hullPenetration > 0) {
        const friction = this.computeFriction(
          hullPenetration,
          speed,
          this.config.hullFriction,
        );
        totalForce.isub(velocity.normalize().mul(friction));
      }
    }

    // Apply grounding force
    if (totalForce.magnitude > 0) {
      body.applyForce(totalForce);
    }
  }

  /**
   * Compute friction force based on penetration depth and speed.
   * F = coefficient * penetration * speed
   */
  private computeFriction(
    penetration: number,
    speed: number,
    coefficient: number,
  ): number {
    return coefficient * penetration * speed;
  }
}
