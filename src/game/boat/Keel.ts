import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V, V2d } from "../../core/Vector";
import {
  computeHydrofoilForces,
  FluidForceResult,
  foilDrag,
  foilLift,
  HydrofoilForceResult,
  KEEL_CHORD,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import { KeelConfig } from "./BoatConfig";
import { Hull } from "./Hull";

export class Keel extends BaseEntity {
  layer = "boat" as const;

  private vertices: V2d[];
  private chord: number;
  private color: number;

  // Water query for keel vertices (transforms to world space for query)
  private waterQuery = this.addChild(
    new WaterQuery(() => this.getQueryPoints()),
  );

  // Cached water velocities indexed by world position key
  private velocityCache = new Map<string, V2d>();

  private keelZ: number;
  private aspectRatio: number; // AR = span / chord (dimensionless)

  // Pre-allocated force result buffers
  private fluidForceResults: FluidForceResult[] = [
    { fx: 0, fy: 0, localX: 0, localY: 0 },
    { fx: 0, fy: 0, localX: 0, localY: 0 },
  ];
  private hydrofoilResults: HydrofoilForceResult[] = Array.from(
    { length: 12 },
    () => ({ fx: 0, fy: 0, fz: 0, localX: 0, localY: 0 }),
  );

  constructor(
    private hull: Hull,
    config: KeelConfig,
    hullDraft: number,
  ) {
    super();

    this.vertices = config.vertices;
    this.chord = config.chord;
    this.color = config.color;
    // Apply keel forces at the midpoint of the keel blade span.
    // The keel extends from hull bottom (-hullDraft) to keel tip (-config.draft).
    // Center of pressure is roughly at the midpoint of the blade.
    this.keelZ = -(hullDraft + config.draft) / 2;

    // Aspect ratio = span / chord. Span is the keel blade depth (draft below hull bottom).
    const keelSpan = config.draft - hullDraft;
    this.aspectRatio = keelSpan / config.chord;
  }

  /**
   * Get query points in world space for all keel vertices.
   */
  private getQueryPoints(): V2d[] {
    const points: V2d[] = [];
    for (const v of this.vertices) {
      points.push(this.hull.body.toWorldFrame(v));
    }
    return points;
  }

  @on("tick")
  onTick() {
    // Build velocity cache from query results
    this.velocityCache.clear();
    const queryPoints = this.getQueryPoints();
    for (let i = 0; i < this.waterQuery.results.length; i++) {
      const point = queryPoints[i];
      if (point) {
        const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
        this.velocityCache.set(key, this.waterQuery.results[i].velocity);
      }
    }

    // Scale keel effectiveness by heel angle — keel loses lateral resistance at extreme heel
    const heelFactor = Math.cos(this.hull.body.roll);
    const effectiveChord = this.chord * Math.max(0.1, heelFactor);

    // Use proper foil physics with heel-adjusted chord dimension
    const lift = foilLift(effectiveChord);
    const drag = foilDrag(effectiveChord, this.aspectRatio);

    // Get water velocity from cache or default to zero
    const getWaterVelocity = (point: V2d): V2d => {
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      return this.velocityCache.get(key) ?? V(0, 0);
    };

    const roll = this.hull.body.roll;
    const angle = this.hull.body.angle;

    // Compute 3D hydrofoil forces with heel decomposition
    const count = computeHydrofoilForces(
      this.hull.body,
      this.vertices,
      roll,
      angle,
      lift,
      drag,
      getWaterVelocity,
      this.hydrofoilResults,
      this.fluidForceResults,
    );

    // Apply keel forces to hull at keelZ depth (produces anti-heeling torque)
    for (let i = 0; i < count; i++) {
      const r = this.hydrofoilResults[i];
      this.hull.body.applyForce3D(
        r.fx,
        r.fy,
        r.fz,
        r.localX,
        r.localY,
        this.keelZ,
      );
    }
  }

  /** Hull-local keel vertices for rendering. */
  getVertices(): V2d[] {
    return this.vertices;
  }

  /** Z-depth of the keel blade midpoint. */
  getKeelZ(): number {
    return this.keelZ;
  }

  /** Visual color for the keel. */
  getColor(): number {
    return this.color;
  }
}
