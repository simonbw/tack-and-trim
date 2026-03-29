/**
 * Boat grounding physics.
 *
 * Applies friction forces when boat components contact terrain.
 * Checks keel (centerboard), rudder, and hull against terrain height.
 * Uses TerrainQuery for GPU-accelerated terrain height queries (1-frame latency).
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { V, type V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import type { Boat } from "./Boat";
import type { GroundingConfig } from "./BoatConfig";

/**
 * Boat grounding physics entity.
 * Applies friction when underwater components contact terrain.
 */
export class BoatGrounding extends BaseEntity {
  private readonly boat: Boat;
  private readonly config: GroundingConfig;
  private readonly hullDraft: number;
  private readonly keelDraft: number;
  private readonly rudderDraft: number;

  // Terrain query child entity - automatically discovered by TerrainQueryManager
  private terrainQuery = this.addChild(
    new TerrainQuery(() => this.getQueryPoints()),
  );

  constructor(boat: Boat) {
    super();
    this.boat = boat;
    this.config = boat.config.grounding;
    this.hullDraft = boat.config.hull.draft;
    this.keelDraft = boat.config.keel.draft;
    this.rudderDraft = boat.config.rudder.draft;
  }

  /**
   * Get all points that need terrain height queries.
   * Returns: keel vertices + rudder position + hull center
   */
  private getQueryPoints(): V2d[] {
    const hull = this.boat.hull?.body;
    if (!hull) return [];

    const points: V2d[] = [];

    // Keel vertices
    for (const v of this.boat.config.keel.vertices) {
      points.push(hull.toWorldFrame(v));
    }

    // Rudder position
    points.push(hull.toWorldFrame(this.boat.config.rudder.position));

    // Hull center
    points.push(V(hull.position));

    return points;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    // Skip if no terrain results yet (first frame)
    if (this.terrainQuery.results.length === 0) return;

    const hull = this.boat.hull;
    const body = hull.body;

    // Get boat velocity for friction calculation
    const velocity = body.velocity;
    const speed = velocity.magnitude;

    // Skip grounding calculation if not moving
    if (speed < 0.01) return;

    const bb = this.boat.buoyantBody;
    const velDir = velocity.normalize();

    // Results are ordered: keel vertices, then rudder, then hull center
    const keelVertexCount = this.boat.config.keel.vertices.length;
    let resultIndex = 0;

    // Check keel grounding
    for (let i = 0; i < keelVertexCount; i++) {
      const result = this.terrainQuery.results[resultIndex++];
      const terrainHeight = result.height;
      const penetration = terrainHeight - -this.keelDraft;

      if (penetration > 0) {
        const friction = this.computeFriction(
          penetration,
          speed,
          this.config.keelFriction,
        );
        const keelVertex = this.boat.config.keel.vertices[i];
        // Apply at keel depth — friction at depth naturally produces pitch torque
        bb.applyForce3D(
          -velDir.x * friction,
          -velDir.y * friction,
          0,
          keelVertex.x,
          keelVertex.y,
          -this.keelDraft,
        );

        this.boat.hullDamage.applyGroundingDamage(penetration * 0.3, speed, dt);
      }
    }

    // Check rudder grounding
    const rudderResult = this.terrainQuery.results[resultIndex++];
    const rudderPenetration = rudderResult.height - -this.rudderDraft;

    if (rudderPenetration > 0) {
      const friction = this.computeFriction(
        rudderPenetration,
        speed,
        this.config.rudderFriction,
      );
      const rudderPos = this.boat.config.rudder.position;
      bb.applyForce3D(
        -velDir.x * friction,
        -velDir.y * friction,
        0,
        rudderPos.x,
        rudderPos.y,
        -this.rudderDraft,
      );

      this.boat.rudderDamage.applyGroundingDamage(rudderPenetration, speed, dt);
    }

    // Check hull grounding (use center of hull)
    const hullResult = this.terrainQuery.results[resultIndex++];
    const hullPenetration = hullResult.height - -this.hullDraft;

    if (hullPenetration > 0) {
      const friction = this.computeFriction(
        hullPenetration,
        speed,
        this.config.hullFriction,
      );
      // Apply at hull bottom depth
      bb.applyForce3D(
        -velDir.x * friction,
        -velDir.y * friction,
        0,
        0,
        0,
        -this.hullDraft,
      );

      this.boat.hullDamage.applyGroundingDamage(hullPenetration, speed, dt);
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
