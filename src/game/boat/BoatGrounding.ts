/**
 * Boat grounding physics.
 *
 * Applies friction forces when boat components contact terrain.
 * Checks keel (centerboard), rudder, and hull against terrain height.
 * Implements TerrainQuerier to request terrain tiles for efficient lookup.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { AABB } from "../../core/util/SparseSpatialHash";
import { V } from "../../core/Vector";
import type { QueryForecast } from "../world-data/datatiles/DataTileTypes";
import type { TerrainQuerier } from "../world-data/terrain/TerrainQuerier";
import { TerrainInfo } from "../world-data/terrain/TerrainInfo";
import type { Boat } from "./Boat";
import type { GroundingConfig } from "./BoatConfig";

// Margin around hull AABB for query forecast (ft)
const QUERY_MARGIN = 2;

/**
 * Boat grounding physics entity.
 * Applies friction when underwater components contact terrain.
 */
export class BoatGrounding extends BaseEntity implements TerrainQuerier {
  tags = ["terrainQuerier"];
  tickLayer = "physics" as const;

  // Reusable AABB to avoid allocations
  private cachedAABB: AABB = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  private readonly boat: Boat;
  private readonly config: GroundingConfig;
  private readonly hullDraft: number;
  private readonly keelDraft: number;
  private readonly rudderDraft: number;

  constructor(boat: Boat) {
    super();
    this.boat = boat;
    this.config = boat.config.grounding;
    this.hullDraft = boat.config.hull.draft;
    this.keelDraft = boat.config.keel.draft;
    this.rudderDraft = boat.config.rudder.draft;
  }

  getTerrainQueryForecast(): QueryForecast | null {
    const hull = this.boat.hull;
    if (!hull?.body) return null;

    // Get AABB directly from physics body
    const bodyAABB = hull.body.getAABB();

    // Add margin
    this.cachedAABB.minX = bodyAABB.lowerBound[0] - QUERY_MARGIN;
    this.cachedAABB.minY = bodyAABB.lowerBound[1] - QUERY_MARGIN;
    this.cachedAABB.maxX = bodyAABB.upperBound[0] + QUERY_MARGIN;
    this.cachedAABB.maxY = bodyAABB.upperBound[1] + QUERY_MARGIN;

    // Query count: keel (all vertices) + rudder (1) + hull center (1)
    const queryCount = this.boat.config.keel.vertices.length + 2;

    return {
      aabb: this.cachedAABB,
      queryCount,
    };
  }

  @on("tick")
  onTick() {
    // Skip if no terrain system
    const terrainInfo = TerrainInfo.maybeFromGame(this.game);
    if (!terrainInfo) return;

    const hull = this.boat.hull;
    const body = hull.body;

    // Get boat velocity for friction calculation
    const velocity = body.velocity;
    const speed = velocity.magnitude;

    // Skip grounding calculation if not moving
    if (speed < 0.01) return;

    let totalForce = V(0, 0);

    // Check keel grounding
    const keelVertices = this.boat.config.keel.vertices;
    for (const localPos of keelVertices) {
      const worldPos = body.toWorldFrame(localPos);
      const terrainHeight = terrainInfo.getHeightAtPoint(worldPos);

      // Keel penetration: terrain height + keel draft (both are positive)
      // If terrain is above water level by terrainHeight, and keel extends
      // keelDraft below water, they intersect when terrainHeight > -keelDraft
      // Since terrain height is positive (above water) and we're checking if
      // the keel (below water) hits it, penetration = terrainHeight + keelDraft
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
    const rudderWorldPos = body.toWorldFrame(this.boat.config.rudder.position);
    const rudderTerrainHeight = terrainInfo.getHeightAtPoint(rudderWorldPos);
    const rudderPenetration = rudderTerrainHeight - -this.rudderDraft;

    if (rudderPenetration > 0) {
      const friction = this.computeFriction(
        rudderPenetration,
        speed,
        this.config.rudderFriction,
      );
      totalForce.isub(velocity.normalize().mul(friction));
    }

    // Check hull grounding (use center of hull)
    const hullCenterPos = body.position;
    const hullTerrainHeight = terrainInfo.getHeightAtPoint(hullCenterPos);
    const hullPenetration = hullTerrainHeight - -this.hullDraft;

    if (hullPenetration > 0) {
      const friction = this.computeFriction(
        hullPenetration,
        speed,
        this.config.hullFriction,
      );
      totalForce.isub(velocity.normalize().mul(friction));
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
