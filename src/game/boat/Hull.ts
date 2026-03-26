import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { Convex } from "../../core/physics/shapes/Convex";
import { polygonArea } from "../../core/physics/utils/ShapeUtils";
import { earClipTriangulate } from "../../core/util/Triangulate";
import { V, V2d } from "../../core/Vector";
import { computeSkinFrictionAtPoint } from "../fluid-dynamics";
import { WaterQuery } from "../world/water/WaterQuery";
import type { BuoyantBody } from "./BuoyantBody";
import { HullConfig } from "./BoatConfig";
import { TiltTransform } from "./TiltTransform";

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
  // Sort vertices by x (ascending) to find the aftmost points
  const sorted = [...vertices].sort((a, b) => a.x - b.x);

  // Take the two most aft vertices
  const v1 = sorted[0];
  const v2 = sorted[1];

  // Determine port (positive y) vs starboard (negative y)
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
  positions: number[]; // length = ringSize * 3 * 3
  ringSize: number;
  /** Pre-allocated 2D projection buffer for submitTriangles. */
  projected: [number, number][];
  /** Triangle indices for the deck cap polygon. */
  deckIndices: number[];
  /** Triangle indices for the upper side strip (deck → waterline). */
  upperSideIndices: number[];
  /** Triangle indices for the lower side strip (waterline → bottom). */
  lowerSideIndices: number[];
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

  // Pre-allocate projection buffer
  const totalVerts = ringSize * 3;
  const projected: [number, number][] = new Array(totalVerts);
  for (let i = 0; i < totalVerts; i++) {
    projected[i] = [0, 0];
  }

  // Triangulate the deck cap using the original (un-projected) vertices.
  // The ear-clip indices reference vertices 0..ringSize-1 (the deck ring).
  const deckIndices = earClipTriangulate(deckVertices) ?? [];

  // Build side strip indices
  const upperSideIndices: number[] = [];
  const lowerSideIndices: number[] = [];

  for (let i = 0; i < ringSize; i++) {
    const next = (i + 1) % ringSize;

    // Upper strip: deck (ring 0) → waterline (ring 1)
    const d0 = i;
    const d1 = next;
    const w0 = ringSize + i;
    const w1 = ringSize + next;
    upperSideIndices.push(d0, d1, w1, d0, w1, w0);

    // Lower strip: waterline (ring 1) → bottom (ring 2)
    const b0 = 2 * ringSize + i;
    const b1 = 2 * ringSize + next;
    lowerSideIndices.push(w0, w1, b1, w0, b1, b0);
  }

  return {
    positions,
    ringSize,
    projected,
    deckIndices,
    upperSideIndices,
    lowerSideIndices,
  };
}

/**
 * Project all 3D hull vertices to 2D using the current tilt state.
 * Hull-local projection: top two rows of R_pitch * R_roll:
 *   px = x*cosP + y*sinP*sinR - z*sinP*cosR
 *   py = y*cosR + z*sinR
 */
function projectMesh(
  mesh: HullMesh,
  cosR: number,
  sinR: number,
  sinP: number,
  cosP: number,
): void {
  const { positions, projected } = mesh;
  const totalVerts = projected.length;
  for (let i = 0; i < totalVerts; i++) {
    const base = i * 3;
    const x = positions[base];
    const y = positions[base + 1];
    const z = positions[base + 2];
    projected[i][0] = x * cosP + y * sinP * sinR - z * sinP * cosR;
    projected[i][1] = y * cosR + z * sinR;
  }
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

  // Distributed skin friction: waterline sample points and per-point area
  private waterlineSamplePoints: V2d[];
  private areaPerPoint: number;
  private buoyantBody: BuoyantBody | null = null;

  /** Tilt state updated by Boat each tick. Used by child entities for physics effects. */
  tiltRoll: number = 0;
  tiltPitch: number = 0;

  /** 3D→2D transform updated by Boat each tick. Used by child entities for rendering. */
  readonly tiltTransform = new TiltTransform();

  // Water query for distributed skin friction (multi-point at waterline vertices)
  private waterQuery: WaterQuery;

  // Pre-allocated query points
  private queryPoints: V2d[];

  constructor(config: HullConfig) {
    super();

    // Use waterline vertices for wetted area (skin friction), fall back to hull vertices
    const waterlineVerts = config.waterlineVertices ?? config.vertices;
    this.waterlineSamplePoints = waterlineVerts.map((v) => V(v.x, v.y));
    const totalArea = polygonArea(waterlineVerts);
    this.areaPerPoint = totalArea / waterlineVerts.length;

    // Pre-allocate query point array
    this.queryPoints = this.waterlineSamplePoints.map(() => V(0, 0));
    this.waterQuery = this.addChild(
      new WaterQuery(() => this.getWorldSamplePoints()),
    );

    this.skinFrictionCoefficient = config.skinFrictionCoefficient;
    this.vertices = config.vertices;
    this.fillColor = config.colors.fill;
    this.strokeColor = config.colors.stroke;
    this.sideColor =
      config.colors.side ?? darkenColor(config.colors.fill, 0.85);
    this.bottomColor =
      config.colors.bottom ?? darkenColor(config.colors.fill, 0.6);

    this.body = new DynamicBody({
      mass: config.mass,
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
  }

  /**
   * Set the BuoyantBody for 3D force application. Called by Boat after construction.
   */
  setBuoyantBody(bb: BuoyantBody): void {
    this.buoyantBody = bb;
  }

  @on("tick")
  onTick() {
    const bb = this.buoyantBody;
    const cf = this.skinFrictionCoefficient * this.getDamageMultiplier();

    // Apply distributed 3D skin friction at each waterline sample point
    for (let i = 0; i < this.waterlineSamplePoints.length; i++) {
      if (i >= this.waterQuery.length) break;

      const local = this.waterlineSamplePoints[i];
      const result = this.waterQuery.get(i);
      const worldPoint = this.queryPoints[i]; // already in world space from getWorldSamplePoints

      // Compute vertical velocity of this hull point from roll/pitch rotation.
      // From d/dt of worldZ = x*sinP - y*sinR*cosP (at small angles):
      //   dz/dt = x * pitchVelocity - y * rollVelocity
      // Positive roll (port down) → port points (y>0) move down (negative dz/dt).
      // Positive pitch (bow up) → bow points (x>0) move up (positive dz/dt).
      const pointZVelocity = bb
        ? local.x * bb.pitchVelocity - local.y * bb.rollVelocity
        : 0;

      const force = computeSkinFrictionAtPoint(
        this.body,
        worldPoint,
        this.areaPerPoint,
        cf,
        result.velocity,
        pointZVelocity,
      );

      if (force && bb) {
        bb.applyForce3D(force.fx, force.fy, force.fz, local.x, local.y, 0);
      } else if (force) {
        // Fallback: apply 2D only (shouldn't happen if properly wired)
        this.body.applyForce(V(force.fx, force.fy));
      }
    }
  }

  /**
   * Get world-space positions of waterline sample points for water queries.
   */
  private getWorldSamplePoints(): V2d[] {
    for (let i = 0; i < this.waterlineSamplePoints.length; i++) {
      const local = this.waterlineSamplePoints[i];
      const world = this.body.toWorldFrame(local);
      this.queryPoints[i].set(world.x, world.y);
    }
    return this.queryPoints;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;
    const t = this.tiltTransform;
    const cosR = t.cosRoll;
    const sinR = t.sinRoll;
    const sinP = t.sinPitch;
    const cosP = t.cosPitch;

    // Project all 3D mesh vertices to 2D
    projectMesh(this.mesh, cosR, sinR, sinP, cosP);

    draw.at({ pos: V(x, y), angle: this.body.angle }, () => {
      const { projected, deckIndices, upperSideIndices, lowerSideIndices } =
        this.mesh;

      // Draw back-to-front: lower sides → upper sides → deck
      // Side/bottom faces that peek beyond the deck edge remain visible;
      // those under the deck get covered.
      // Set z-height per group for depth testing against water surface.
      const deckZ = this.mesh.positions[2]; // z of first vertex (deck ring)
      const bottomZ = this.mesh.positions[this.mesh.ringSize * 2 * 3 + 2]; // z of bottom ring

      // Lower sides (waterline → bottom) — hull bottom paint color
      draw.renderer.setZ(bottomZ);
      draw.renderer.submitTriangles(
        projected,
        lowerSideIndices,
        this.bottomColor,
        1.0,
      );

      // Upper sides (deck → waterline) — hull topsides color
      draw.renderer.setZ(0); // waterline z
      draw.renderer.submitTriangles(
        projected,
        upperSideIndices,
        this.sideColor,
        1.0,
      );

      // Deck cap — main hull color
      draw.renderer.setZ(deckZ);
      draw.renderer.submitTriangles(
        projected,
        deckIndices,
        this.fillColor,
        1.0,
      );
      draw.renderer.setZ(0);

      // Outline: stroke the projected deck polygon (gunwale line)
      const ringSize = this.mesh.ringSize;
      draw.strokePolygon(
        projected.slice(0, ringSize).map((p) => V(p[0], p[1])),
        {
          color: this.strokeColor,
          width: 0.25,
          z: deckZ,
        },
      );

      // Deck details — offset to deck z-height for correct parallax
      const deckOffX = -sinP * cosR * deckZ;
      const deckOffY = sinR * deckZ;

      // Tiller (rotates opposite to rudder)
      if (this.tillerConfig) {
        const tillerAngle = this.tillerConfig.getTillerAngle();
        const tillerPos = this.tillerConfig.position;
        const tillerLength = 3;
        const tillerWidth = 0.25;
        const tillerColor = 0x886633;

        draw.at(
          {
            pos: V(
              tillerPos.x * cosP + tillerPos.y * sinP * sinR + deckOffX,
              tillerPos.y * cosR + deckOffY,
            ),
            angle: tillerAngle,
          },
          () => {
            draw.fillRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
              color: tillerColor,
              z: deckZ,
            });
            draw.strokeRect(0, -tillerWidth / 2, tillerLength, tillerWidth, {
              color: 0x664422,
              width: 0.1,
              z: deckZ,
            });
          },
        );
      }
    });
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
