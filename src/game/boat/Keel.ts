import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { pairs } from "../../core/util/FunctionalUtils";
import { V, V2d } from "../../core/Vector";
import {
  computeFluidForces,
  FluidForceResult,
  foilDrag,
  foilLift,
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

  // Pre-allocated force result buffer
  private forceResults: FluidForceResult[] = [
    { fx: 0, fy: 0, localX: 0, localY: 0 },
    { fx: 0, fy: 0, localX: 0, localY: 0 },
  ];

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

    // Cache trig values for 3D force decomposition (same for all vertices)
    const roll = this.hull.body.roll;
    const cosRoll = Math.cos(roll);
    const sinRoll = Math.sin(roll);
    const angle = this.hull.body.angle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Apply keel forces to hull (both directions for symmetry)
    // Forces applied at keelZ depth so they naturally produce anti-heeling torque
    for (const [start, end] of pairs(this.vertices)) {
      for (const reversed of [false, true]) {
        const a = reversed ? end : start;
        const b = reversed ? start : end;
        const count = computeFluidForces(
          this.hull.body,
          a,
          b,
          lift,
          drag,
          getWaterVelocity,
          this.forceResults,
        );
        for (let i = 0; i < count; i++) {
          const r = this.forceResults[i];

          // 3D force decomposition: rotate lateral force component by heel angle.
          // The keel tilts with the boat's heel, so its lift vector tilts too.
          // Decompose world-frame force into longitudinal (along heading) and
          // lateral (perpendicular to heading) components relative to boat heading.
          const longitudinal = r.fx * cosA + r.fy * sinA;
          const lateral = -r.fx * sinA + r.fy * cosA;

          // The longitudinal component (drag) stays horizontal regardless of heel.
          // The lateral component (lift) tilts with the keel:
          //   horizontal part = lateral * cos(roll)
          //   vertical part   = lateral * sin(roll) — this provides righting force
          const lateralH = lateral * cosRoll;
          const fz = lateral * sinRoll;

          // Reconstruct world-frame horizontal force
          const fxNew = longitudinal * cosA - lateralH * sinA;
          const fyNew = longitudinal * sinA + lateralH * cosA;

          this.hull.body.applyForce3D(
            fxNew,
            fyNew,
            fz,
            r.localX,
            r.localY,
            this.keelZ,
          );
        }
      }
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.hull.body.position;
    const zOffset = this.hull.body.z;

    draw.at(
      {
        pos: V(x, y),
        angle: this.hull.body.angle,
        tilt: {
          roll: this.hull.body.roll,
          pitch: this.hull.body.pitch,
          zOffset,
        },
      },
      () => {
        // Draw keel as a polyline (open path) in body-local coords
        for (let i = 0; i < this.vertices.length - 1; i++) {
          const a = this.vertices[i];
          const b = this.vertices[i + 1];
          draw.line(a.x, a.y, b.x, b.y, {
            color: this.color,
            width: 1,
            z: this.keelZ,
          });
        }
      },
    );
  }
}
