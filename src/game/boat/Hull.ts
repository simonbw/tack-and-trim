import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import {
  DynamicBody,
  type SixDOFOptions,
} from "../../core/physics/body/DynamicBody";
import { Convex } from "../../core/physics/shapes/Convex";
import { earClipTriangulate } from "../../core/util/Triangulate";
import { V, V2d } from "../../core/Vector";
import {
  computeSkinFrictionAtPoint,
  RHO_AIR,
  RHO_WATER,
} from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";
import { HullConfig } from "./BoatConfig";
import { TiltTransform } from "./TiltTransform";

const GRAVITY = 32.174; // ft/s²
// Hydrostatic pressure: F = ρ * g * depth * area (lbf), converted to engine units (* g)
const BUOYANCY_FORCE_PER_DEPTH_PER_AREA = RHO_WATER * GRAVITY * GRAVITY;
// Force conversion: lbf to engine units (lbm·ft/s²)
const LBF_TO_ENGINE = 32.174;
// Waterline transition band half-width (ft)
const WATERLINE_BAND = 0.1;

/**
 * Find the bow (foremost) point from hull geometry.
 * Returns the vertex with the maximum x value.
 */
export function findBowPoint(vertices: V2d[]): V2d {
  let best = vertices[0];
  for (const v of vertices) {
    if (v.x > best.x) best = v;
  }
  return best;
}

/**
 * Find the stern (aftmost) port and starboard vertices from hull geometry.
 * Finds the two vertices with the minimum x values (furthest aft).
 */
export function findSternPoints(vertices: V2d[]): {
  port: V2d;
  starboard: V2d;
} {
  const sorted = [...vertices].sort((a, b) => a.x - b.x);
  const v1 = sorted[0];
  const v2 = sorted[1];
  if (v1.y > v2.y) {
    return { port: v1, starboard: v2 };
  } else {
    return { port: v2, starboard: v1 };
  }
}

export interface TillerConfig {
  position: V2d;
  getTillerAngle: () => number;
}

/**
 * 3D hull mesh built from three vertex rings (deck, waterline, bottom).
 * Triangle indices are precomputed once; only vertex projection changes per frame.
 */
export interface HullMesh {
  /** 3D vertices as [x, y, z] triples. Layout: deck ring, waterline ring, bottom ring. */
  positions: number[];
  ringSize: number;
  /** Body-local XY positions for GPU submission (static, built once). */
  xyPositions: [number, number][];
  /** Per-vertex z-heights for GPU depth + parallax (static, built once). */
  zValues: number[];
  /** Triangle indices for the deck cap polygon. */
  deckIndices: number[];
  /** Triangle indices for the upper side strip (deck → waterline). */
  upperSideIndices: number[];
  /** Triangle indices for the lower side strip (waterline → bottom). */
  lowerSideIndices: number[];
  /** Triangle indices for the bottom cap polygon (physics only). */
  bottomIndices: number[];
}

/**
 * Precomputed per-triangle data for hull force computation.
 * Stored as flat arrays for cache-friendly access.
 */
interface HullForceData {
  count: number;
  /** Body-local centroid X */
  cx: Float64Array;
  /** Body-local centroid Y */
  cy: Float64Array;
  /** Body-local centroid Z */
  cz: Float64Array;
  /** Body-local outward normal X */
  nx: Float64Array;
  /** Body-local outward normal Y */
  ny: Float64Array;
  /** Body-local outward normal Z */
  nz: Float64Array;
  /** Triangle surface area (ft²) */
  area: Float64Array;
  /** Vertex indices for each triangle (3 per triangle) */
  vertexIndices: Uint16Array;
  /** Number of unique vertices in the mesh */
  vertexCount: number;
}

function buildHullMesh(
  deckVertices: V2d[],
  waterlineVertices: V2d[],
  bottomVertices: V2d[],
  deckZ: number,
  bottomZ: number,
): HullMesh {
  const ringSize = deckVertices.length;

  // Build 3D positions: three rings
  const positions: number[] = [];
  for (const v of deckVertices) {
    positions.push(v.x, v.y, deckZ);
  }
  for (const v of waterlineVertices) {
    positions.push(v.x, v.y, 0);
  }
  for (const v of bottomVertices) {
    positions.push(v.x, v.y, bottomZ);
  }

  // Build static XY and Z arrays from 3D positions
  const totalVerts = ringSize * 3;
  const xyPositions: [number, number][] = new Array(totalVerts);
  const zValues: number[] = new Array(totalVerts);
  for (let i = 0; i < totalVerts; i++) {
    const base = i * 3;
    xyPositions[i] = [positions[base], positions[base + 1]];
    zValues[i] = positions[base + 2];
  }

  // Triangulate caps
  const deckIndices = earClipTriangulate(deckVertices) ?? [];
  const bottomRawIndices = earClipTriangulate(bottomVertices) ?? [];
  // Offset bottom indices to the third ring and reverse winding for downward-facing normals
  const bottomIndices: number[] = [];
  for (let i = 0; i < bottomRawIndices.length; i += 3) {
    bottomIndices.push(
      bottomRawIndices[i + 2] + 2 * ringSize,
      bottomRawIndices[i + 1] + 2 * ringSize,
      bottomRawIndices[i] + 2 * ringSize,
    );
  }

  // Build side strip indices
  const upperSideIndices: number[] = [];
  const lowerSideIndices: number[] = [];

  for (let i = 0; i < ringSize; i++) {
    const next = (i + 1) % ringSize;
    const d0 = i;
    const d1 = next;
    const w0 = ringSize + i;
    const w1 = ringSize + next;
    upperSideIndices.push(d0, d1, w1, d0, w1, w0);

    const b0 = 2 * ringSize + i;
    const b1 = 2 * ringSize + next;
    lowerSideIndices.push(w0, w1, b1, w0, b1, b0);
  }

  return {
    positions,
    ringSize,
    xyPositions,
    zValues,
    deckIndices,
    upperSideIndices,
    lowerSideIndices,
    bottomIndices,
  };
}

/**
 * Precompute per-triangle force data (centroid, outward normal, area)
 * from the hull mesh geometry.
 */
function buildHullForceData(mesh: HullMesh): HullForceData {
  const allIndices = [
    ...mesh.deckIndices,
    ...mesh.upperSideIndices,
    ...mesh.lowerSideIndices,
    ...mesh.bottomIndices,
  ];
  const triCount = allIndices.length / 3;
  const data: HullForceData = {
    count: triCount,
    cx: new Float64Array(triCount),
    cy: new Float64Array(triCount),
    cz: new Float64Array(triCount),
    nx: new Float64Array(triCount),
    ny: new Float64Array(triCount),
    nz: new Float64Array(triCount),
    area: new Float64Array(triCount),
    vertexIndices: new Uint16Array(allIndices),
    vertexCount: mesh.xyPositions.length,
  };

  const pos = mesh.xyPositions;
  const zVals = mesh.zValues;

  for (let t = 0; t < triCount; t++) {
    const i0 = allIndices[t * 3];
    const i1 = allIndices[t * 3 + 1];
    const i2 = allIndices[t * 3 + 2];

    // Vertex positions
    const x0 = pos[i0][0],
      y0 = pos[i0][1],
      z0 = zVals[i0];
    const x1 = pos[i1][0],
      y1 = pos[i1][1],
      z1 = zVals[i1];
    const x2 = pos[i2][0],
      y2 = pos[i2][1],
      z2 = zVals[i2];

    // Centroid
    data.cx[t] = (x0 + x1 + x2) / 3;
    data.cy[t] = (y0 + y1 + y2) / 3;
    data.cz[t] = (z0 + z1 + z2) / 3;

    // Edge vectors
    const e1x = x1 - x0,
      e1y = y1 - y0,
      e1z = z1 - z0;
    const e2x = x2 - x0,
      e2y = y2 - y0,
      e2z = z2 - z0;

    // Cross product (outward normal, unnormalized)
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    data.area[t] = len * 0.5;

    if (len > 1e-8) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    // Ensure outward-facing: normal should point away from hull interior.
    // For side triangles, the centroid's XY direction from the centerline
    // should align with the normal's XY direction.
    // For caps, check Z direction.
    const centroidDot = data.cx[t] * nx + data.cy[t] * ny + data.cz[t] * nz;
    if (centroidDot < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    data.nx[t] = nx;
    data.ny[t] = ny;
    data.nz[t] = nz;
  }

  return data;
}

export class Hull extends BaseEntity {
  layer = "boat" as const;
  body: DynamicBody;
  private skinFrictionCoefficient: number;
  private vertices: V2d[];
  private fillColor: number;
  private strokeColor: number;
  private sideColor: number;
  private bottomColor: number;
  private tillerConfig?: TillerConfig;
  private getDamageMultiplier: () => number = () => 1;
  private mesh: HullMesh;

  /** 3D→2D transform updated by Boat each tick. Used by child entities for rendering. */
  readonly tiltTransform = new TiltTransform();

  // Per-triangle force data (precomputed at construction)
  private forceData: HullForceData;

  // Gravity params (from buoyancy config, applied per-tick)
  private boatMass: number;
  private centerOfGravityZ: number;

  // Water and wind queries at mesh vertices (shared by all triangles)
  private waterQuery: WaterQuery;
  private windQuery: WindQuery;

  // Pre-allocated vertex query points (one per unique vertex)
  private vertexQueryPoints: V2d[];

  constructor(
    config: HullConfig,
    sixDOF?: SixDOFOptions,
    boatMass: number = 0,
    centerOfGravityZ: number = 0,
  ) {
    super();

    this.skinFrictionCoefficient = config.skinFrictionCoefficient;
    this.vertices = config.vertices;
    this.fillColor = config.colors.fill;
    this.strokeColor = config.colors.stroke;
    this.sideColor =
      config.colors.side ?? darkenColor(config.colors.fill, 0.85);
    this.bottomColor =
      config.colors.bottom ?? darkenColor(config.colors.fill, 0.6);
    this.boatMass = boatMass;
    this.centerOfGravityZ = centerOfGravityZ;

    this.body = new DynamicBody({
      mass: config.mass,
      sixDOF,
    });

    this.body.addShape(
      new Convex({
        vertices: [...config.vertices],
      }),
    );

    // Build 3D hull mesh from the three vertex rings
    const meshWaterlineVerts = config.waterlineVertices ?? config.vertices;
    const bottomVerts =
      config.bottomVertices ??
      meshWaterlineVerts.map((v) => V(v.x, v.y * 0.45));
    const deckZ = config.deckHeight;
    const bottomZ = -config.draft;

    this.mesh = buildHullMesh(
      config.vertices,
      meshWaterlineVerts,
      bottomVerts,
      deckZ,
      bottomZ,
    );

    // Precompute per-triangle force data
    this.forceData = buildHullForceData(this.mesh);

    // Pre-allocate vertex query points (one per unique mesh vertex)
    const vertCount = this.forceData.vertexCount;
    this.vertexQueryPoints = Array.from({ length: vertCount }, () => V(0, 0));

    // Water and wind queries at mesh vertices (shared across triangles)
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getVertexWorldPoints()),
    );
    this.windQuery = this.addChild(
      new WindQuery(() => this.getVertexWorldPoints()),
    );
  }

  /**
   * Transform body-local mesh vertices to world XY for queries.
   */
  private getVertexWorldPoints(): V2d[] {
    const pos = this.mesh.xyPositions;
    for (let i = 0; i < pos.length; i++) {
      const world = this.body.toWorldFrame(V(pos[i][0], pos[i][1]));
      this.vertexQueryPoints[i].set(world.x, world.y);
    }
    return this.vertexQueryPoints;
  }

  @on("tick")
  onTick() {
    const body = this.body;
    const R = body.orientation;
    const bodyZ = body.z;
    const fd = this.forceData;
    const cf = this.skinFrictionCoefficient * this.getDamageMultiplier();

    // Apply gravity at center of gravity
    if (this.boatMass > 0) {
      body.applyForce3D(
        0,
        0,
        -this.boatMass * GRAVITY,
        0,
        0,
        this.centerOfGravityZ,
      );
    }

    // Per-triangle force loop.
    // Water/wind are queried at mesh vertices; per-triangle values are
    // averaged from the three vertex results for better partial-submersion handling.
    const tilt = this.tiltTransform;
    const meshPos = this.mesh.xyPositions;
    const meshZ = this.mesh.zValues;
    const vi = fd.vertexIndices;
    const wq = this.waterQuery;
    const wiq = this.windQuery;

    for (let i = 0; i < fd.count; i++) {
      const area = fd.area[i];
      if (area < 0.001) continue;

      // Triangle centroid (body-local, for force application point)
      const localX = fd.cx[i];
      const localY = fd.cy[i];
      const localZ = fd.cz[i];

      // Transform normal to world frame via rotation matrix
      const lnx = fd.nx[i],
        lny = fd.ny[i],
        lnz = fd.nz[i];
      const wnx = R[0] * lnx + R[1] * lny + R[2] * lnz;
      const wny = R[3] * lnx + R[4] * lny + R[5] * lnz;
      const wnz = R[6] * lnx + R[7] * lny + R[8] * lnz;

      // Look up per-vertex water data and average submersion across the triangle.
      // This handles partial submersion much better than centroid-only sampling:
      // a triangle with one vertex underwater gets ~1/3 submersion contribution.
      const v0 = vi[i * 3],
        v1 = vi[i * 3 + 1],
        v2 = vi[i * 3 + 2];

      // Per-vertex world Z (from body orientation + z offset)
      const wz0 = tilt.worldZ(meshPos[v0][0], meshPos[v0][1], meshZ[v0], bodyZ);
      const wz1 = tilt.worldZ(meshPos[v1][0], meshPos[v1][1], meshZ[v1], bodyZ);
      const wz2 = tilt.worldZ(meshPos[v2][0], meshPos[v2][1], meshZ[v2], bodyZ);

      // Per-vertex water surface height
      const wh0 = v0 < wq.length ? wq.get(v0).surfaceHeight : 0;
      const wh1 = v1 < wq.length ? wq.get(v1).surfaceHeight : 0;
      const wh2 = v2 < wq.length ? wq.get(v2).surfaceHeight : 0;

      // Per-vertex submersion (positive = underwater, negative = above)
      const sub0 = wh0 - wz0;
      const sub1 = wh1 - wz1;
      const sub2 = wh2 - wz2;

      // Average submersion across the triangle (can be negative = above water)
      const avgSubmersion = (sub0 + sub1 + sub2) / 3;

      // Average of clamped submersion depths (for buoyancy magnitude)
      const avgDepth =
        (Math.max(0, sub0) + Math.max(0, sub1) + Math.max(0, sub2)) / 3;

      // Smooth water fraction based on average submersion with transition band.
      // This avoids discrete force jumps as individual vertices cross the waterline.
      let waterFrac: number;
      if (avgSubmersion > WATERLINE_BAND) {
        waterFrac = 1;
      } else if (avgSubmersion < -WATERLINE_BAND) {
        waterFrac = 0;
      } else {
        waterFrac = (avgSubmersion + WATERLINE_BAND) / (2 * WATERLINE_BAND);
      }

      // === UNDERWATER FORCES ===
      if (waterFrac > 0) {
        // Buoyancy: hydrostatic pressure normal to surface.
        // avgDepth is the average of per-vertex clamped submersion depths,
        // giving correct results for partially submerged triangles.
        if (avgDepth > 0) {
          const buoyancyMag =
            BUOYANCY_FORCE_PER_DEPTH_PER_AREA * avgDepth * area;
          body.applyForce3D(
            -wnx * buoyancyMag,
            -wny * buoyancyMag,
            -wnz * buoyancyMag,
            localX,
            localY,
            localZ,
          );
        }

        // Average water velocity from vertices (weighted by submersion)
        let waterVx = 0,
          waterVy = 0;
        {
          // Simple average of all three vertex water velocities
          let count = 0;
          if (v0 < wq.length) {
            const vel = wq.get(v0).velocity;
            waterVx += vel.x;
            waterVy += vel.y;
            count++;
          }
          if (v1 < wq.length) {
            const vel = wq.get(v1).velocity;
            waterVx += vel.x;
            waterVy += vel.y;
            count++;
          }
          if (v2 < wq.length) {
            const vel = wq.get(v2).velocity;
            waterVx += vel.x;
            waterVy += vel.y;
            count++;
          }
          if (count > 0) {
            waterVx /= count;
            waterVy /= count;
          }
        }

        // Skin friction on submerged area
        const centroidWorld = this.body.toWorldFrame(V(localX, localY));
        const pointZVelocity =
          localX * body.pitchVelocity - localY * body.rollVelocity;
        const friction = computeSkinFrictionAtPoint(
          body,
          centroidWorld,
          area * waterFrac,
          cf,
          V(waterVx, waterVy),
          pointZVelocity,
        );
        if (friction) {
          body.applyForce3D(
            friction.fx,
            friction.fy,
            friction.fz,
            localX,
            localY,
            localZ,
          );
        }

        // Form drag: pressure drag from normal component of relative velocity
        const rr = V(
          centroidWorld.x - body.position[0],
          centroidWorld.y - body.position[1],
        );
        const pvx = body.velocity[0] - rr.y * body.angularVelocity;
        const pvy = body.velocity[1] + rr.x * body.angularVelocity;
        const rvx = pvx - waterVx;
        const rvy = pvy - waterVy;
        const speed = Math.sqrt(rvx * rvx + rvy * rvy);

        if (speed > 0.01) {
          const vDotN = rvx * wnx + rvy * wny;
          if (vDotN > 0) {
            const Cd = vDotN / speed;
            const dynamicPressure = 0.5 * RHO_WATER * speed * speed;
            const forceMag =
              Cd * dynamicPressure * area * waterFrac * LBF_TO_ENGINE;
            body.applyForce3D(
              -wnx * forceMag,
              -wny * forceMag,
              -wnz * forceMag,
              localX,
              localY,
              localZ,
            );
          }
        }
      }

      // === ABOVE-WATER FORCES ===
      if (waterFrac < 1) {
        const airFrac = 1 - waterFrac;

        // Average wind velocity from vertices
        let windVx = 0,
          windVy = 0;
        {
          let count = 0;
          if (v0 < wiq.length) {
            const vel = wiq.get(v0).velocity;
            windVx += vel.x;
            windVy += vel.y;
            count++;
          }
          if (v1 < wiq.length) {
            const vel = wiq.get(v1).velocity;
            windVx += vel.x;
            windVy += vel.y;
            count++;
          }
          if (v2 < wiq.length) {
            const vel = wiq.get(v2).velocity;
            windVx += vel.x;
            windVy += vel.y;
            count++;
          }
          if (count > 0) {
            windVx /= count;
            windVy /= count;
          }
        }

        // Wind drag on above-water surface
        const centroidWorld = this.body.toWorldFrame(V(localX, localY));
        const rr = V(
          centroidWorld.x - body.position[0],
          centroidWorld.y - body.position[1],
        );
        const pvx = body.velocity[0] - rr.y * body.angularVelocity;
        const pvy = body.velocity[1] + rr.x * body.angularVelocity;
        const rvx = pvx - windVx;
        const rvy = pvy - windVy;
        const speed = Math.sqrt(rvx * rvx + rvy * rvy);

        if (speed > 0.01) {
          const vDotN = rvx * wnx + rvy * wny;
          if (vDotN > 0) {
            const Cd = vDotN / speed;
            const dynamicPressure = 0.5 * RHO_AIR * speed * speed;
            const forceMag =
              Cd * dynamicPressure * area * airFrac * LBF_TO_ENGINE;
            body.applyForce3D(
              -wnx * forceMag,
              -wny * forceMag,
              -wnz * forceMag,
              localX,
              localY,
              localZ,
            );
          }
        }
      }
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;
    const t = this.tiltTransform;
    const zOffset = this.body.z;

    draw.at(
      {
        pos: V(x, y),
        angle: this.body.angle,
        tilt: { roll: this.body.roll, pitch: this.body.pitch, zOffset },
      },
      () => {
        const {
          xyPositions,
          zValues,
          deckIndices,
          upperSideIndices,
          lowerSideIndices,
        } = this.mesh;

        // Draw back-to-front: lower sides → upper sides → deck
        draw.renderer.submitTrianglesWithZ(
          xyPositions,
          lowerSideIndices,
          this.bottomColor,
          1.0,
          zValues,
        );

        draw.renderer.submitTrianglesWithZ(
          xyPositions,
          upperSideIndices,
          this.sideColor,
          1.0,
          zValues,
        );

        draw.renderer.submitTrianglesWithZ(
          xyPositions,
          deckIndices,
          this.fillColor,
          1.0,
          zValues,
        );

        // Outline: stroke the deck polygon (gunwale line)
        const ringSize = this.mesh.ringSize;
        const deckZ = this.mesh.positions[2];
        draw.strokePolygon(
          xyPositions.slice(0, ringSize).map((p) => V(p[0], p[1])),
          {
            color: this.strokeColor,
            width: 0.25,
            z: deckZ,
          },
        );

        // Tiller
        if (this.tillerConfig) {
          const tillerAngle = this.tillerConfig.getTillerAngle();
          const tillerPos = this.tillerConfig.position;
          const tillerLength = 3;
          const tillerWidth = 0.25;
          const tillerColor = 0x886633;

          draw.at({ pos: tillerPos, angle: tillerAngle }, () => {
            draw.fillRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
              color: tillerColor,
              z: deckZ,
            });
            draw.strokeRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
              color: 0x664422,
              width: 0.1,
              z: deckZ,
            });
          });
        }
      },
    );
  }

  /** Data needed by BoatCompositor for hull height rendering. */
  getHeightMeshData(): HullMesh {
    return this.mesh;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }

  setTillerConfig(config: TillerConfig): void {
    this.tillerConfig = config;
  }

  setDamageMultiplier(fn: () => number): void {
    this.getDamageMultiplier = fn;
  }
}

/** Darken a hex color by a factor (0-1). */
function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
