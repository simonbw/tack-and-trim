import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import {
  createRigid2D,
  createRigid3D,
} from "../../core/physics/body/bodyFactories";
import type {
  DynamicRigid2D,
  DynamicRigid3D,
} from "../../core/physics/body/bodyInterfaces";
import type { Body } from "../../core/physics/body/Body";
import { Convex } from "../../core/physics/shapes/Convex";
import { V, V2d } from "../../core/Vector";
import { computeSkinFrictionAtPoint } from "../fluid-dynamics";
import { LBF_TO_ENGINE, RHO_AIR, RHO_WATER } from "../physics-constants";
import { WaterQuery } from "../world/water/WaterQuery";
import { WindQuery } from "../world/wind/WindQuery";
import { DeckZone, HullConfig } from "./BoatConfig";
import { buildHullMeshFromProfiles } from "./hull-profiles";

/** Additional options for enabling 6DOF (z, roll, pitch) on a hull body. */
export interface SixDOFOptions {
  /** Moment of inertia for roll (rotation around forward/x axis). */
  rollInertia: number;
  /** Moment of inertia for pitch (rotation around lateral/y axis). */
  pitchInertia: number;
  /** Effective mass for z-axis motion (e.g. displaced water mass for buoyancy). */
  zMass?: number;
  /** Initial z position. Default 0. */
  zPosition?: number;
  /** Damping for z velocity (0-1). Default 0. */
  zDamping?: number;
  /** Damping for roll/pitch angular velocity (0-1). Default 0. */
  rollPitchDamping?: number;
}

const GRAVITY = 32.174; // ft/s²
// Hydrostatic pressure: F = ρ * g * depth * area (lbf), converted to engine units (* g)
const BUOYANCY_FORCE_PER_DEPTH_PER_AREA = RHO_WATER * GRAVITY * GRAVITY;
// Waterline transition band half-width (ft)
const WATERLINE_BAND = 0.1;

// Maximum foam particles spawned per hull per tick. Round-robin picks which
// triangles flush their accumulators; others wait their turn. Total live
// foam particles ≈ FOAM_EMISSIONS_PER_TICK × tick rate × foam lifetime.
const FOAM_EMISSIONS_PER_TICK = 4;
// Triangles whose accumulator hasn't reached this volume are skipped by the
// round-robin cursor (prevents wasted emissions from barely-active triangles).
const MIN_FOAM_ACCUM_VOLUME = 0.001; // ft³
// Cap on how much flux volume a single triangle can have pending emission.
// Without this, startup transients (hull settling into water, queries
// warming up) dump a pile into every accumulator, and when the round-robin
// cursor gets there it paints an over-bright "silhouette" of the hull at
// the boat's current position. The cap scales `_foamAccumTime` down
// proportionally so the resulting avgFlux is preserved — we lose the tail
// of old history, not the current rate.
const MAX_FOAM_ACCUM_VOLUME = 2.0; // ft³

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

/**
 * 3D hull mesh lofted from station cross-section profiles.
 * Triangle indices are precomputed once; only vertex projection changes per frame.
 */
export interface HullMesh {
  /** 3D vertices as [x, y, z] triples, one full cross-section per station. */
  positions: number[];
  /** Vertices per non-collapsed cross-section (2 * halfProfilePoints - 1). */
  ringSize: number;
  /** Body-local XY positions for GPU submission (static, built once). */
  xyPositions: [number, number][];
  /** Per-vertex z-heights for GPU depth + parallax (static, built once). */
  zValues: number[];
  /** Triangle indices for the deck cap polygon. */
  deckIndices: number[];
  /** Triangle indices for above-waterline hull panels. */
  upperSideIndices: number[];
  /** Triangle indices for below-waterline hull panels. */
  lowerSideIndices: number[];
  /** Triangle indices for bottom-facing panels (physics only). */
  bottomIndices: number[];
  /** Deck edge polygon for gunwale stroke rendering + deck plan clipping. */
  deckOutline?: [number, number][];
  /** Map from deck outline polygon index to mesh xyPositions/zValues index. */
  deckVertexMap?: number[];
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

/**
 * Compute the enclosed volume of the hull mesh using the divergence theorem.
 * For a closed surface: V = (1/3) * Σ (centroid · outward_normal) * area
 */
function computeHullVolume(data: HullForceData): number {
  let volume = 0;
  for (let i = 0; i < data.count; i++) {
    volume +=
      (data.cx[i] * data.nx[i] +
        data.cy[i] * data.ny[i] +
        data.cz[i] * data.nz[i]) *
      data.area[i];
  }
  return Math.abs(volume) / 3;
}

/**
 * Coherent wave-making source — emitted every tick from triangles straddling
 * the waterline where the hull is pushing water forward (stagnation flow).
 * Drives ring-pulse wake particles. Fully submerged and fully emerged
 * triangles produce no source; only the waterline band radiates surface waves.
 */
export interface WaveSource {
  /** World-frame source position (ft) */
  worldX: number;
  worldY: number;
  /** Volume-flux magnitude pushed into water (ft³/s). Coherent wave amplitude. */
  pushFlux: number;
  /** Characteristic horizontal size of the source (ft), sets ring width. */
  halfWidth: number;
  /** Group speed to use for this source's ring expansion (ft/s). */
  groupSpeed: number;
}

/**
 * Foam / turbulent-wake source — emitted via round-robin across all
 * submerged rear-facing triangles. Each triangle accumulates volume of
 * displaced (suction) water across ticks; when the cursor lands on it the
 * accumulator flushes into one foam particle whose intensity reflects the
 * average flux during accumulation. Keeps steady-state foam density
 * invariant of how many triangles are currently separating.
 */
export interface FoamSource {
  /** World-frame source position (ft), evaluated at emission time. */
  worldX: number;
  worldY: number;
  /** Time-averaged suction flux over the accumulation period (ft³/s). */
  avgFlux: number;
  /** Characteristic horizontal size of the source (ft), sets blob radius. */
  halfWidth: number;
  /** Current group speed for intensity calibration (ft/s). */
  groupSpeed: number;
}

export class Hull extends BaseEntity {
  layer = "boat" as const;
  body: Body & (DynamicRigid2D | DynamicRigid3D);
  private skinFrictionCoefficient: number;
  private stagnationCoefficient: number;
  private separationCoefficient: number;
  private vertices: V2d[];
  private fillColor: number;
  private strokeColor: number;
  private sideColor: number;
  private bottomColor: number;
  private getDamageMultiplier: () => number = () => 1;
  private mesh: HullMesh;
  private renderMesh: HullMesh;
  private deckZonesByHeight: readonly DeckZone[];

  // Wave sources collected from waterline-straddling triangles each tick.
  // Reused across ticks — length is reset, objects are mutated in place.
  private _waveSources: WaveSource[] = [];
  private _waveSourceCount: number = 0;

  // Foam sources emitted via round-robin from the per-triangle accumulator.
  // Capped at FOAM_EMISSIONS_PER_TICK per tick regardless of how many
  // triangles are separating — gives a fixed foam particle budget.
  private _foamSources: FoamSource[] = [];
  private _foamSourceCount: number = 0;

  // Per-triangle persistent accumulators of suction-flux volume and time
  // since this triangle's last foam emission. Allocated in constructor to
  // triCount; reset per-triangle on emission.
  private _foamAccumVolume!: Float64Array;
  private _foamAccumTime!: Float64Array;
  // Round-robin cursor over all physics triangles.
  private _foamCursor: number = 0;

  // Per-triangle force data (precomputed at construction)
  private forceData: HullForceData;

  /** Enclosed hull volume in cubic feet, computed from mesh geometry via divergence theorem. */
  readonly hullVolume: number;

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
    this.stagnationCoefficient = config.stagnationCoefficient ?? 1.0;
    this.separationCoefficient = config.separationCoefficient ?? 0.5;
    this.vertices = config.vertices;
    this.fillColor = config.colors.fill;
    this.strokeColor = config.colors.stroke;
    this.sideColor =
      config.colors.side ?? darkenColor(config.colors.fill, 0.85);
    this.bottomColor =
      config.colors.bottom ?? darkenColor(config.colors.fill, 0.6);
    this.boatMass = boatMass;
    this.centerOfGravityZ = centerOfGravityZ;

    // Pre-sort deck zones by floorZ descending for getDeckHeight lookups
    this.deckZonesByHeight = config.deckPlan
      ? [...config.deckPlan.zones].sort((a, b) => b.floorZ - a.floorZ)
      : [];

    this.body = sixDOF
      ? createRigid3D({
          motion: "dynamic",
          mass: config.mass,
          rollInertia: sixDOF.rollInertia,
          pitchInertia: sixDOF.pitchInertia,
          zMass: sixDOF.zMass,
          z: sixDOF.zPosition,
          zDamping: sixDOF.zDamping,
          rollPitchDamping: sixDOF.rollPitchDamping,
        })
      : createRigid2D({
          motion: "dynamic",
          mass: config.mass,
        });

    this.body.addShape(
      new Convex({
        vertices: [...config.vertices],
      }),
    );

    // Physics mesh uses lower subdivision for cache-friendly force computation.
    this.mesh = buildHullMeshFromProfiles({
      ...config.shape,
      profileSubdivisions: 2,
      stationSubdivisions: 2,
    });
    // Render mesh uses full subdivision for visual smoothness.
    this.renderMesh = buildHullMeshFromProfiles(config.shape);

    // Precompute per-triangle force data
    this.forceData = buildHullForceData(this.mesh);

    // Persistent per-triangle foam accumulators (volume + time since emit).
    this._foamAccumVolume = new Float64Array(this.forceData.count);
    this._foamAccumTime = new Float64Array(this.forceData.count);

    // Compute enclosed hull volume via divergence theorem: V = (1/3) Σ (c · n) * A
    this.hullVolume = computeHullVolume(this.forceData);

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

  /** Get the water query for reading per-vertex water data. */
  getWaterQuery(): WaterQuery {
    return this.waterQuery;
  }

  /** Get the physics mesh (vertex positions correspond to water query indices). */
  getPhysicsMesh(): HullMesh {
    return this.mesh;
  }

  /**
   * Number of active wave sources from this tick.
   * Iterate [0, count) and read via `getWaveSource(i)`.
   */
  get waveSourceCount(): number {
    return this._waveSourceCount;
  }

  /** Read wave source at index; only valid for i < waveSourceCount. */
  getWaveSource(i: number): Readonly<WaveSource> {
    return this._waveSources[i];
  }

  /** Number of foam sources emitted this tick (0..FOAM_EMISSIONS_PER_TICK). */
  get foamSourceCount(): number {
    return this._foamSourceCount;
  }

  /** Read foam source at index; only valid for i < foamSourceCount. */
  getFoamSource(i: number): Readonly<FoamSource> {
    return this._foamSources[i];
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
  onTick({ dt }: GameEventMap["tick"]) {
    const body = this.body;
    const R = body.orientation;
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
    const meshPos = this.mesh.xyPositions;
    const meshZ = this.mesh.zValues;
    const vi = fd.vertexIndices;
    const wq = this.waterQuery;
    const wiq = this.windQuery;

    // Reset per-tick wave and foam source lists (reuse the backing arrays).
    this._waveSourceCount = 0;
    this._foamSourceCount = 0;

    // Cache current boat speed — used as the group-velocity scale for all
    // wave sources this tick. Deep-water dispersion: c_g = 0.5 * v for the
    // hull-wavelength group.
    const boatSpeed = Math.sqrt(
      body.velocity[0] * body.velocity[0] + body.velocity[1] * body.velocity[1],
    );
    const sourceGroupSpeed = 0.5 * boatSpeed;

    // Pressure coefficients for form drag
    const cpStag = this.stagnationCoefficient;
    const cpSep = this.separationCoefficient;

    // Depth baseline for buoyancy: the minimum submersion across all mesh
    // vertices. When the hull is fully submerged every vertex has sub > 0, and
    // subtracting this baseline from each triangle's depth keeps individual
    // buoyancy force magnitudes bounded by hull height instead of sink depth.
    // For a closed mesh the constant offset integrates to zero, so the net
    // buoyancy force and torque are unchanged — only the numerical cancellation
    // between near-equal top/bottom forces is improved. When any part of the
    // hull is above water (minSub <= 0) the baseline is clamped to 0 and the
    // computation reduces exactly to the previous behavior.
    let minSub = Infinity;
    for (let v = 0; v < meshPos.length; v++) {
      const wz = body.worldZ(meshPos[v][0], meshPos[v][1], meshZ[v]);
      const wh = v < wq.length ? wq.get(v).surfaceHeight : 0;
      const sub = wh - wz;
      if (sub < minSub) minSub = sub;
    }
    const depthBaseline = Math.max(0, minSub);

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
      const wz0 = body.worldZ(meshPos[v0][0], meshPos[v0][1], meshZ[v0]);
      const wz1 = body.worldZ(meshPos[v1][0], meshPos[v1][1], meshZ[v1]);
      const wz2 = body.worldZ(meshPos[v2][0], meshPos[v2][1], meshZ[v2]);

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
        // Buoyancy: vertical force proportional to submersion depth × area.
        // Applied in Z (vertical), not in -normal direction, because our hull
        // mesh is not closed at the waterline — the "pressure on surface" approach
        // requires a closed surface for lateral forces to cancel. Without a
        // waterplane cap, normal-directed buoyancy creates unbalanced lateral
        // forces that push the boat around. Vertical buoyancy with distributed
        // application points naturally produces righting moment (deeper points
        // get more upward force, creating torque that opposes heel).
        //
        // The buoyancy contribution is weighted by -wnz — the negated world-frame
        // vertical component of the triangle's outward normal. The sign matters:
        //   - Bottom triangles (outward normal points down, wnz < 0): -wnz > 0,
        //     so force is upward — water pushes up on the hull bottom.
        //   - Submerged deck triangles (outward normal points up, wnz > 0):
        //     -wnz < 0, so force is downward — water presses down on the top
        //     surface. This is critical at extreme heel when deck edges submerge.
        //   - Side triangles (wnz ≈ 0): negligible contribution either way.
        const effectiveDepth = avgDepth - depthBaseline;
        if (effectiveDepth > 0) {
          const buoyancyMag =
            BUOYANCY_FORCE_PER_DEPTH_PER_AREA * effectiveDepth * area * -wnz;
          body.applyForce3D(0, 0, buoyancyMag, localX, localY, localZ);
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
        const centroidWorldWater = this.body.toWorldFrame(V(localX, localY));
        const pointZVelocity =
          localY * body.rollVelocity - localX * body.pitchVelocity;
        const friction = computeSkinFrictionAtPoint(
          body,
          centroidWorldWater,
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

        // Form drag: pressure-based drag from normal component of 3D relative velocity.
        // Uses separate stagnation (front-facing) and separation (rear-facing) models.
        // The vertical velocity from roll/pitch is critical for roll damping —
        // when the boat heels, hull triangles push through water vertically.
        //
        // Relative velocity at this point (hull velocity minus water velocity):
        //   rv = point_velocity - water_velocity
        // where point_velocity includes body translation, rotation, and z-axis rotation.
        const rrWaterX = centroidWorldWater.x - body.position[0];
        const rrWaterY = centroidWorldWater.y - body.position[1];
        const pvxW = body.velocity[0] - rrWaterY * body.angularVelocity;
        const pvyW = body.velocity[1] + rrWaterX * body.angularVelocity;
        const pvzW = pointZVelocity + body.zVelocity;
        const rvxW = pvxW - waterVx;
        const rvyW = pvyW - waterVy;
        const rvzW = pvzW; // water has no vertical velocity
        const speedW = Math.sqrt(rvxW * rvxW + rvyW * rvyW + rvzW * rvzW);

        if (speedW > 0.01) {
          // vDotN > 0: flow hitting front-facing surface (stagnation pressure)
          // vDotN < 0: surface is in the wake (separation/suction pressure)
          const vDotN = rvxW * wnx + rvyW * wny + rvzW * wnz;

          if (vDotN > 0) {
            // --- Stagnation pressure (front-facing triangles) ---
            // F = Cp_stag * 0.5 * rho * v^2 * A_projected
            // where A_projected = area * |vDotN / speed| (projected area normal to flow)
            // Force direction: along inward normal (-n), opposing the impinging flow.
            const aProjected = area * (vDotN / speedW); // ft² — projected area normal to flow
            const dynamicPressure = 0.5 * RHO_WATER * speedW * speedW; // lbf/ft²
            const forceMag =
              cpStag * dynamicPressure * aProjected * waterFrac * LBF_TO_ENGINE;
            body.applyForce3D(
              -wnx * forceMag,
              -wny * forceMag,
              -wnz * forceMag,
              localX,
              localY,
              localZ,
            );
          } else if (vDotN < 0) {
            // --- Separation/suction pressure (rear-facing triangles) ---
            // In the wake region behind the hull, flow separates and creates a
            // low-pressure zone. This suction pulls the surface backward.
            // F = Cp_sep * 0.5 * rho * v^2 * A_projected
            // where A_projected = area * |vDotN / speed|
            // Force direction: along outward normal (+n), pulling surface into the wake.
            const absVDotN = -vDotN; // positive magnitude
            const aProjected = area * (absVDotN / speedW); // ft²
            const dynamicPressure = 0.5 * RHO_WATER * speedW * speedW; // lbf/ft²
            const forceMag =
              cpSep * dynamicPressure * aProjected * waterFrac * LBF_TO_ENGINE;
            // Suction force: +n direction (pulling surface into wake = opposing motion)
            body.applyForce3D(
              wnx * forceMag,
              wny * forceMag,
              wnz * forceMag,
              localX,
              localY,
              localZ,
            );
          }

          // Wave-making vs foam emission have different physical gates:
          //
          // - Wave-making (front-facing, pushFlux): surface phenomenon, only
          //   emitted from waterline-straddling triangles. A submerged hull
          //   chunk doesn't make surface waves; the water just flows around.
          //   Emitted every tick from every eligible triangle.
          //
          // - Foam / turbulence (rear-facing, suckFlux): originates from
          //   submerged rear-facing triangles too (turbulent wake behind a
          //   squatting stern is mostly below the surface). Accumulated
          //   per-triangle and emitted round-robin by the pass below.
          if (sourceGroupSpeed > 0.05) {
            const atWaterline = waterFrac > 0.05 && waterFrac < 0.95;
            const submerged = waterFrac > 0.05;

            if (atWaterline && vDotN > 0) {
              const pushFlux = vDotN * area;
              const halfWidth = Math.max(Math.sqrt(area), 0.5);
              while (this._waveSources.length <= this._waveSourceCount) {
                this._waveSources.push({
                  worldX: 0,
                  worldY: 0,
                  pushFlux: 0,
                  halfWidth: 0,
                  groupSpeed: 0,
                });
              }
              const src = this._waveSources[this._waveSourceCount++];
              src.worldX = centroidWorldWater.x;
              src.worldY = centroidWorldWater.y;
              src.pushFlux = pushFlux;
              src.halfWidth = halfWidth;
              src.groupSpeed = sourceGroupSpeed;
            }

            if (submerged && vDotN < 0) {
              this._foamAccumVolume[i] += -vDotN * area * dt;
              this._foamAccumTime[i] += dt;
              // Cap accumulator; preserve avgFlux ratio by scaling time.
              const v = this._foamAccumVolume[i];
              if (v > MAX_FOAM_ACCUM_VOLUME) {
                const scale = MAX_FOAM_ACCUM_VOLUME / v;
                this._foamAccumVolume[i] = MAX_FOAM_ACCUM_VOLUME;
                this._foamAccumTime[i] *= scale;
              }
            }
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

    // Round-robin foam emission. Advance the cursor forward, skipping
    // triangles whose accumulator hasn't built up enough volume, and flush
    // up to FOAM_EMISSIONS_PER_TICK triangles this tick. Each emitted
    // particle represents the time-averaged suction flux at that triangle
    // over its accumulation period — intensity is calibrated via avgFlux.
    const triCount = fd.count;
    if (triCount > 0) {
      let emitted = 0;
      let scanned = 0;
      while (emitted < FOAM_EMISSIONS_PER_TICK && scanned < triCount) {
        const idx = this._foamCursor;
        const vol = this._foamAccumVolume[idx];
        if (vol >= MIN_FOAM_ACCUM_VOLUME) {
          const time = this._foamAccumTime[idx];
          const avgFlux = time > 0 ? vol / time : 0;

          // Transform this triangle's body-local centroid to world frame
          // at emission time. The water this represents was displaced a
          // little earlier along the boat's path — for typical tick rates
          // and boat speeds that offset is sub-foot and visually ignorable.
          const localX = fd.cx[idx];
          const localY = fd.cy[idx];
          const centroidWorld = body.toWorldFrame(V(localX, localY));
          const halfWidth = Math.max(Math.sqrt(fd.area[idx]), 0.5);

          while (this._foamSources.length <= this._foamSourceCount) {
            this._foamSources.push({
              worldX: 0,
              worldY: 0,
              avgFlux: 0,
              halfWidth: 0,
              groupSpeed: 0,
            });
          }
          const src = this._foamSources[this._foamSourceCount++];
          src.worldX = centroidWorld.x;
          src.worldY = centroidWorld.y;
          src.avgFlux = avgFlux;
          src.halfWidth = halfWidth;
          src.groupSpeed = sourceGroupSpeed;

          this._foamAccumVolume[idx] = 0;
          this._foamAccumTime[idx] = 0;
          emitted++;
        }
        this._foamCursor = (this._foamCursor + 1) % triCount;
        scanned++;
      }
    }
  }

  /** Deck/fill color. */
  getFillColor(): number {
    return this.fillColor;
  }

  /** Gunwale stroke color. */
  getStrokeColor(): number {
    return this.strokeColor;
  }

  /** Hull topsides color. */
  getSideColor(): number {
    return this.sideColor;
  }

  /** Hull bottom color. */
  getBottomColor(): number {
    return this.bottomColor;
  }

  /**
   * Get the z-height of the topmost deck surface at a hull-local (x, y) point.
   * Returns the floorZ of the highest deck zone containing the point,
   * or null if the point is not over any deck zone.
   */
  getDeckHeight(localX: number, localY: number): number | null {
    for (const zone of this.deckZonesByHeight) {
      if (pointInPolygonTuple(localX, localY, zone.outline)) {
        return zone.floorZ;
      }
    }
    return null;
  }

  /** Data needed by BoatCompositor for hull height rendering. */
  getHeightMeshData(): HullMesh {
    return this.renderMesh;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }

  setDamageMultiplier(fn: () => number): void {
    this.getDamageMultiplier = fn;
  }
}

/**
 * Ray-casting point-in-polygon test for [number, number][] outlines.
 * Casts a ray in the +x direction and counts edge crossings.
 */
function pointInPolygonTuple(
  px: number,
  py: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): boolean {
  const n = polygon.length;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0],
      yi = polygon[i][1];
    const xj = polygon[j][0],
      yj = polygon[j][1];

    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Darken a hex color by a factor (0-1). */
function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
