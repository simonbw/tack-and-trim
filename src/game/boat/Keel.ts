import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
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
import type { BuoyantBody } from "./BuoyantBody";
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

  // Pre-allocated force result buffer
  private forceResults: FluidForceResult[] = [
    { fx: 0, fy: 0, localX: 0, localY: 0 },
    { fx: 0, fy: 0, localX: 0, localY: 0 },
  ];

  constructor(
    private hull: Hull,
    private buoyantBody: BuoyantBody,
    config: KeelConfig,
    hullDraft: number,
  ) {
    super();

    this.vertices = config.vertices;
    this.chord = config.chord;
    this.color = config.color;
    this.keelZ = -hullDraft; // keel attaches at hull bottom
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
    const heelFactor = Math.cos(this.hull.tiltRoll);
    const effectiveChord = this.chord * Math.max(0.1, heelFactor);

    // Use proper foil physics with heel-adjusted chord dimension
    const lift = foilLift(effectiveChord);
    const drag = foilDrag(effectiveChord);

    // Get water velocity from cache or default to zero
    const getWaterVelocity = (point: V2d): V2d => {
      const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
      return this.velocityCache.get(key) ?? V(0, 0);
    };

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
          this.buoyantBody.applyForce3D(
            r.fx,
            r.fy,
            0,
            r.localX,
            r.localY,
            this.keelZ,
          );
        }
      }
    }
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }) {
    const [x, y] = this.hull.body.position;
    const offset = this.hull.tiltTransform.worldOffset(this.keelZ);

    draw.at(
      { pos: V(x + offset.x, y + offset.y), angle: this.hull.body.angle },
      () => {
        // Draw keel as a polyline (open path)
        const path = draw.path();
        const first = this.vertices[0];
        path.moveTo(first.x, first.y);
        for (let i = 1; i < this.vertices.length; i++) {
          const v = this.vertices[i];
          path.lineTo(v.x, v.y);
        }
        draw.renderer.setZ(this.keelZ);
        path.stroke(this.color, 1, 1.0);
        draw.renderer.setZ(0);
      },
    );
  }
}
