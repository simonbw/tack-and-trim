/**
 * Grounding physics system for boats.
 *
 * Applies drag forces when the boat enters shallow water where the
 * keel or hull would contact the bottom. This creates a "soft grounding"
 * effect where the boat gradually slows rather than stopping abruptly.
 */

import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Boat } from "../boat/Boat";
import { WaterInfo } from "../water/WaterInfo";
import { TerrainInfo } from "./TerrainInfo";

// Grounding physics constants
const HULL_DRAFT = 1.5; // How deep the hull sits in the water (feet)
const KEEL_DRAFT = 3.5; // How deep the keel extends below waterline (feet)
const GROUNDING_DRAG_SCALE = 80; // Drag multiplier when grounded
const SOFT_GROUNDING_RANGE = 1.5; // Feet of "soft" grounding before heavy drag
const ANGULAR_DAMPING = 0.92; // Angular velocity retention when grounded

/**
 * Applies grounding forces to a boat when in shallow water.
 */
export class GroundingSystem extends BaseEntity {
  tickLayer = "environment" as const;

  constructor(private boat: Boat) {
    super();
  }

  @on("tick")
  onTick() {
    const terrain = TerrainInfo.maybeFromGame(this.game!);
    if (!terrain) return;

    const water = WaterInfo.fromGame(this.game!);
    const hull = this.boat.hull.body;

    // Sample depth at multiple hull points
    const samplePoints = this.getHullSamplePoints();

    let totalForceX = 0;
    let totalForceY = 0;
    let groundingCount = 0;
    let maxSeverity = 0;

    for (const localPoint of samplePoints) {
      const worldPoint = hull.toWorldFrame(localPoint);
      const waterState = water.getStateAtPoint(worldPoint);
      const depth = terrain.getWaterDepth(worldPoint, waterState.surfaceHeight);

      // Use keel draft for center points, hull draft for outer points
      const isKeelPoint = Math.abs(localPoint.y) < 1;
      const draft = isKeelPoint ? KEEL_DRAFT : HULL_DRAFT;

      // Check if this point is grounding
      const clearance = depth - draft;

      if (clearance < SOFT_GROUNDING_RANGE) {
        // Calculate grounding severity (0 = just touching, 1+ = heavily grounded)
        const severity = clamp(
          (SOFT_GROUNDING_RANGE - clearance) / SOFT_GROUNDING_RANGE,
          0,
          2
        );

        maxSeverity = Math.max(maxSeverity, severity);

        // Get velocity at this point
        const r = worldPoint.sub(V(hull.position));
        const pointVelocity = V(hull.velocity).add(
          r.rotate90ccw().mul(hull.angularVelocity)
        );

        // Apply drag force opposing velocity at this point
        const speed = pointVelocity.magnitude;
        if (speed > 0.01) {
          const dragMagnitude = GROUNDING_DRAG_SCALE * severity * speed;
          const dragForce = pointVelocity.normalize().mul(-dragMagnitude);

          totalForceX += dragForce.x;
          totalForceY += dragForce.y;
          groundingCount++;
        }
      }
    }

    if (groundingCount > 0) {
      // Apply the averaged grounding force
      const avgForce = V(
        totalForceX / groundingCount,
        totalForceY / groundingCount
      );
      hull.applyForce(avgForce);

      // Apply angular damping proportional to severity
      const dampingFactor =
        ANGULAR_DAMPING + (1 - ANGULAR_DAMPING) * (1 - maxSeverity);
      hull.angularVelocity *= dampingFactor;
    }
  }

  /**
   * Get sample points on the hull for grounding checks.
   * Points are in local (hull) coordinates.
   */
  private getHullSamplePoints(): V2d[] {
    // Sample key points around the hull
    return [
      // Bow
      V(9, 0),
      // Stern corners
      V(-6, 1.5),
      V(-6, -1.5),
      // Midship port/starboard
      V(0, 3),
      V(0, -3),
      // Keel line (center)
      V(4, 0),
      V(0, 0),
      V(-3, 0),
    ];
  }

  /**
   * Check if the boat is currently grounded.
   */
  isGrounded(): boolean {
    const terrain = TerrainInfo.maybeFromGame(this.game!);
    if (!terrain) return false;

    const water = WaterInfo.fromGame(this.game!);
    const hull = this.boat.hull.body;

    // Check center point with keel draft
    const centerWorld = hull.toWorldFrame(V(0, 0));
    const waterState = water.getStateAtPoint(centerWorld);
    const depth = terrain.getWaterDepth(centerWorld, waterState.surfaceHeight);

    return depth < KEEL_DRAFT;
  }
}
