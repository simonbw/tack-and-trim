import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { V, V2d } from "../../core/Vector";
import { RHO_WATER } from "../physics-constants";
import { WaterQuery } from "../world/water/WaterQuery";
import type { BuoyantBody } from "./BuoyantBody";
import type { Hull } from "./Hull";

// Engine uses mass in lbm and F=m*a, so force is lbm·ft/s².
// Gravity acceleration in ft/s².
const GRAVITY = 32.174;

// Hydrostatic pressure force in lbf = ρ(slug/ft³) * g(ft/s²) * depth(ft) * area(ft²).
// Convert lbf to engine units by multiplying by g again (1 lbf = 32.174 lbm·ft/s²).
// Combined constant: ρ * g * g
const BUOYANCY_FORCE_PER_DEPTH_PER_AREA = RHO_WATER * GRAVITY * GRAVITY;

/**
 * Computes multi-point buoyancy forces and gravity for the boat.
 *
 * Samples water surface height at each waterline vertex. For each submerged
 * point, applies an upward buoyancy force proportional to submersion depth.
 * Righting moment, wave response, and z-equilibrium all emerge naturally
 * from the geometric distribution of these forces.
 */
export class Buoyancy extends BaseEntity {
  // Sample points in body-local coordinates (from waterline vertices)
  private readonly samplePoints: ReadonlyArray<V2d>;
  // Area represented by each sample point (total waterplane area / N)
  private readonly areaPerPoint: number;
  // Boat mass for gravity (lbm)
  private readonly boatMass: number;
  // Center of gravity z-offset (body-local, negative = below waterline)
  private readonly centerOfGravityZ: number;

  private readonly buoyantBody: BuoyantBody;
  private readonly hull: Hull;

  // Water query for all sample points
  private readonly waterQuery: WaterQuery;

  // Reusable array for transformed query points
  private readonly queryPoints: V2d[];

  constructor(
    buoyantBody: BuoyantBody,
    hull: Hull,
    waterlineVertices: ReadonlyArray<V2d>,
    boatMass: number,
    centerOfGravityZ: number,
  ) {
    super();

    this.buoyantBody = buoyantBody;
    this.hull = hull;
    this.boatMass = boatMass;
    this.centerOfGravityZ = centerOfGravityZ;

    // Copy waterline vertices as our sample points
    this.samplePoints = waterlineVertices.map((v) => V(v.x, v.y));

    // Compute area per point from the waterline polygon
    const totalArea = polygonArea(waterlineVertices as V2d[]);
    this.areaPerPoint = totalArea / waterlineVertices.length;

    // Pre-allocate query point array
    this.queryPoints = this.samplePoints.map(() => V(0, 0));

    // Create water query that returns sample points transformed to world space
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getWorldSamplePoints()),
    );
  }

  /**
   * Transform body-local sample points to world XY positions for water queries.
   */
  private getWorldSamplePoints(): V2d[] {
    for (let i = 0; i < this.samplePoints.length; i++) {
      const local = this.samplePoints[i];
      const world = this.hull.body.toWorldFrame(local);
      this.queryPoints[i].set(world.x, world.y);
    }
    return this.queryPoints;
  }

  @on("tick")
  onTick() {
    const bb = this.buoyantBody;
    const tilt = this.hull.tiltTransform;

    // Apply gravity at center of gravity
    bb.applyForce3D(0, 0, -this.boatMass * GRAVITY, 0, 0, this.centerOfGravityZ);

    // Apply buoyancy at each sample point
    for (let i = 0; i < this.samplePoints.length; i++) {
      if (i >= this.waterQuery.length) break;

      const local = this.samplePoints[i];
      const result = this.waterQuery.get(i);

      // Compute world-Z of this hull point given current roll/pitch
      // toWorld3D returns [worldX, worldY, worldZ]
      const worldZ = tilt.toWorld3D(local.x, local.y, 0)[2];

      // How far below the water surface is this point?
      const submersion = result.surfaceHeight - worldZ - bb.z;
      if (submersion <= 0) continue; // Above water — no buoyancy

      // Upward buoyancy force proportional to submersion depth
      const force = BUOYANCY_FORCE_PER_DEPTH_PER_AREA * submersion * this.areaPerPoint;

      // Apply at the body-local position of this sample point (z=0, waterline)
      bb.applyForce3D(0, 0, force, local.x, local.y, 0);
    }
  }
}
