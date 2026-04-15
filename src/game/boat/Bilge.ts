import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { SoundInstance } from "../../core/sound/SoundInstance";
import { clamp } from "../../core/util/MathUtil";
import { rUniform } from "../../core/util/Random";
import { BilgeConfig } from "./BoatConfig";
import type { Boat } from "./Boat";
import type { HullMesh } from "./Hull";
import { extractHullOutlineAtZ } from "./hull-profiles";
import { BOAT_AIR_VERTEX_SIZE } from "../surface-rendering/BoatAirShader";

const GRAVITY = 32.174; // ft/s²

// Weir flow ingress coefficient: Cd × (2/3) × sqrt(2g).
// The (2/3)×sqrt(2g) comes from integrating Torricelli velocity sqrt(2gh) over
// the submersion depth (standard sharp-crested weir derivation).
// A textbook sharp-crested weir has Cd ≈ 0.6; we use 0.4 as a starting point
// to account for hull geometry deflecting some flow. In the future this could be
// computed dynamically from boat velocity, angular velocity, and sea state.
const INGRESS_COEFF = 0.4 * (2 / 3) * Math.sqrt(2 * GRAVITY); // ~2.14

// Water drag coefficient applied per lb of water mass per ft/s of boat speed
const WATER_DRAG_COEFF = 0.08;

// Number of bisection iterations for the volume-conserving offset solve.
// 8 gives ~draft/256 precision on a ±(draft+deckHeight) initial bracket.
const BISECTION_ITERATIONS = 8;

// Hull-local z bias applied to the rendered bilge water surface. Lifts the
// polygon a hair above the hull geometry so it doesn't z-fight at full fill
// (surface at gunwale) or empty (surface at hull bottom). ~3/16" in feet.
const HULL_WATER_Z_BIAS = 0.015;

/** Shoelace formula — signed area of a 2D polygon, absolute value returned. */
function polygonArea(verts: [number, number][]): number {
  const n = verts.length;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += verts[i][0] * verts[j][1] - verts[j][0] * verts[i][1];
  }
  return Math.abs(area) * 0.5;
}

/**
 * Manages water accumulation inside the boat.
 *
 * Water enters when the deck edge submerges (excessive heel), adds mass and drag,
 * sloshes around driven by effective-gravity changes (heel + pitch + hull
 * acceleration), and can be removed by an automatic bilge pump or manual
 * bailing. At 100% capacity the boat sinks.
 *
 * The free surface is modeled as a tilted plane in hull-local space:
 *     z(x, y) = offset + slopeX * x + slopeY * y
 * where (slopeX, slopeY) are dynamic state driven by a 2-axis damped oscillator
 * whose target is the hull-frame projection of effective gravity, and `offset`
 * is recovered each tick by bisection so that the wetted hull volume equals the
 * current `waterVolume`. The water weight is applied at the real centroid of
 * the wetted region, which reproduces the free-surface effect automatically.
 */
export class Bilge extends BaseEntity {
  layer = "boat" as const;

  /** Current water volume in cubic ft */
  waterVolume: number = 0;

  // Tilted water-plane state in hull-local coordinates.
  // Slopes are dimensionless (rise/run); velocities in 1/s.
  private slopeX: number = 0;
  private slopeY: number = 0;
  private slopeXVelocity: number = 0;
  private slopeYVelocity: number = 0;
  /** Hull-local z of the plane at (x=0, y=0). Recovered each tick by bisection. */
  private offset: number = 0;

  // Previous-tick world velocity for finite-difference acceleration (inertial forcing).
  private prevVelocityX: number = 0;
  private prevVelocityY: number = 0;
  private prevVelocityZ: number = 0;
  private hasPrevVelocity: boolean = false;

  // Cached centroid (hull-local) of the wetted pool from the last bisection,
  // used when applying the water-weight force to the hull body.
  private poolCentroidX: number = 0;
  private poolCentroidY: number = 0;
  private poolCentroidZ: number = 0;

  /** Whether the player is currently bailing */
  private bailing: boolean = false;

  /** Timer tracking progress toward next bail scoop */
  private bailTimer: number = 0;

  /** Sinking state */
  private sinking: boolean = false;
  private sinkTimer: number = 0;
  private sunk: boolean = false;

  private getHullLeakRate: () => number = () => 0;

  private maxWaterVolume: number;

  // Gunwale geometry for per-segment ingress (precomputed at construction)
  private gunwaleVertexIndices: number[];
  private gunwaleSegmentLengths: Float64Array;
  private gunwaleSubmersionDepths: Float64Array;
  private halfBeam: number;

  // Bilge rendering geometry (precomputed at construction)
  private hullMesh: HullMesh;
  /** Upper bound on outline vertex count (2 × numStations). */
  public readonly maxHullWaterVertices: number;

  // Per-station scratch for the tilted water-plane outline intersection.
  // Sized to numStations; reused every frame.
  private stationX: Float64Array;
  private starboardY: Float64Array;
  private starboardZ: Float64Array;
  private portY: Float64Array;
  private portZ: Float64Array;
  private starboardValid: Uint8Array;
  private portValid: Uint8Array;

  /**
   * Precomputed cumulative-volume table for mapping water volume to visual z.
   * `volumeTableZ[i]` is a z-level from hull bottom to deck; `volumeTableV[i]`
   * is the hull interior volume below that z (trapezoidal integral of the
   * hull cross-section area). Used as the warm-start for the bisection solver
   * when recovering `offset` from `waterVolume`.
   */
  private volumeTableZ: Float64Array;
  private volumeTableV: Float64Array;
  private totalHullVolume: number;

  // Centroid of the full hull interior, used as the static force application
  // point when the bilge is fully flooded (no air left to swap places with →
  // no free-surface effect, so water weight acts at a fixed point rather than
  // the sloshing pool centroid).
  private staticCentroidX = 0;
  private staticCentroidY = 0;
  private staticCentroidZ = 0;

  // Per-station scratch for the wetted-area clipper (preallocated polygon buffers).
  private clipInY: Float64Array;
  private clipInZ: Float64Array;
  private clipOutY: Float64Array;
  private clipOutZ: Float64Array;

  constructor(
    private boat: Boat,
    private config: BilgeConfig,
    hullVolume: number,
  ) {
    super();
    this.maxWaterVolume = config.maxWaterVolume ?? hullVolume;

    // Precompute gunwale geometry from hull mesh
    const mesh = boat.hull.getPhysicsMesh();
    this.gunwaleVertexIndices =
      mesh.deckVertexMap ?? Array.from({ length: mesh.ringSize }, (_, i) => i);
    const n = this.gunwaleVertexIndices.length;
    this.gunwaleSegmentLengths = new Float64Array(n);
    this.gunwaleSubmersionDepths = new Float64Array(n);

    // Compute segment lengths and half-beam from gunwale vertices
    let maxAbsY = 0;
    for (let i = 0; i < n; i++) {
      const vi = this.gunwaleVertexIndices[i];
      const vj = this.gunwaleVertexIndices[(i + 1) % n];
      const dx = mesh.xyPositions[vi][0] - mesh.xyPositions[vj][0];
      const dy = mesh.xyPositions[vi][1] - mesh.xyPositions[vj][1];
      this.gunwaleSegmentLengths[i] = Math.sqrt(dx * dx + dy * dy);
      const absY = Math.abs(mesh.xyPositions[vi][1]);
      if (absY > maxAbsY) maxAbsY = absY;
    }
    this.halfBeam = maxAbsY;

    // Bilge render geometry
    this.hullMesh = mesh;
    const numStations = mesh.xyPositions.length / mesh.ringSize;
    this.maxHullWaterVertices = 2 * numStations;
    this.stationX = new Float64Array(numStations);
    this.starboardY = new Float64Array(numStations);
    this.starboardZ = new Float64Array(numStations);
    this.portY = new Float64Array(numStations);
    this.portZ = new Float64Array(numStations);
    this.starboardValid = new Uint8Array(numStations);
    this.portValid = new Uint8Array(numStations);

    // Clip scratch: Sutherland-Hodgman can at most double the input vertex
    // count per clip edge; we only clip against one half-plane so the output
    // is at most ringSize + 1 vertices. Allocate generously.
    const clipCap = mesh.ringSize * 2 + 4;
    this.clipInY = new Float64Array(clipCap);
    this.clipInZ = new Float64Array(clipCap);
    this.clipOutY = new Float64Array(clipCap);
    this.clipOutZ = new Float64Array(clipCap);

    // Build cumulative-volume table. For each sample z between hull bottom
    // and deck, extract the hull cross-section, compute its area, and
    // integrate (trapezoidal rule) to get cumulative volume below z.
    const draft = boat.config.hull.draft;
    const deckHeight = boat.config.hull.deckHeight;
    const VOLUME_SAMPLES = 48;
    this.volumeTableZ = new Float64Array(VOLUME_SAMPLES);
    this.volumeTableV = new Float64Array(VOLUME_SAMPLES);
    let cumV = 0;
    let prevArea = 0;
    let prevZ = -draft;
    for (let i = 0; i < VOLUME_SAMPLES; i++) {
      const t = i / (VOLUME_SAMPLES - 1);
      const z = -draft + (deckHeight + draft) * t;
      const outline = extractHullOutlineAtZ(mesh, z);
      const area = polygonArea(outline);
      if (i > 0) {
        cumV += (prevArea + area) * 0.5 * (z - prevZ);
      }
      this.volumeTableZ[i] = z;
      this.volumeTableV[i] = cumV;
      prevArea = area;
      prevZ = z;
    }
    this.totalHullVolume = cumV > 0 ? cumV : hullVolume;

    // Precompute the static interior centroid by integrating with a level
    // plane well above the deck, so every hull cross-section is fully below it.
    const fullStats = this.integratePoolUnderPlane(
      0,
      0,
      deckHeight + draft + 1,
    );
    this.staticCentroidX = fullStats.cx;
    this.staticCentroidY = fullStats.cy;
    this.staticCentroidZ = fullStats.cz;
  }

  /**
   * Invert the cumulative-volume table: given a water volume (cubic ft),
   * return the hull-local z where that volume sits in the upright boat.
   * Linear interpolation between the nearest table entries. Water below the
   * hull bottom clamps to -draft; above the deck clamps to deckHeight.
   */
  private volumeToZ(targetVolume: number): number {
    const tv = this.volumeTableV;
    const tz = this.volumeTableZ;
    const n = tv.length;
    if (targetVolume <= 0) return tz[0];
    if (targetVolume >= tv[n - 1]) return tz[n - 1];
    for (let i = 1; i < n; i++) {
      if (tv[i] >= targetVolume) {
        const v0 = tv[i - 1];
        const v1 = tv[i];
        const denom = v1 - v0;
        const f = denom > 1e-9 ? (targetVolume - v0) / denom : 0;
        return tz[i - 1] + f * (tz[i] - tz[i - 1]);
      }
    }
    return tz[n - 1];
  }

  /** Get the max water volume in cubic ft */
  getMaxWaterVolume(): number {
    return this.maxWaterVolume;
  }

  /** Get the water level as a fraction 0-1 */
  getWaterFraction(): number {
    return this.waterVolume / this.maxWaterVolume;
  }

  /** Check if the boat is sinking or has sunk */
  isSinking(): boolean {
    return this.sinking;
  }

  isSunk(): boolean {
    return this.sunk;
  }

  setHullLeakRate(fn: () => number): void {
    this.getHullLeakRate = fn;
  }

  /** Set bailing state (called by PlayerBoatController) */
  setBailing(value: boolean): void {
    this.bailing = value;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (this.sunk) return;

    if (this.sinking) {
      this.sinkTimer += dt;
      if (this.sinkTimer >= this.config.sinkingDuration) {
        this.sunk = true;
        this.game.dispatch("boatSunk", {});
        return;
      }
    }

    // --- Water ingress from deck edge submersion ---
    const waterFraction = this.getWaterFraction();

    // Effective deck height decreases as water accumulates (boat sits lower)
    const effectiveDeckHeight =
      this.boat.config.hull.deckHeight * (1 - waterFraction * 0.8);

    // Compute per-vertex submersion depth along the gunwale
    const hull = this.boat.hull;
    const body = hull.body;
    const wq = hull.getWaterQuery();
    const mesh = hull.getPhysicsMesh();
    const n = this.gunwaleVertexIndices.length;

    for (let i = 0; i < n; i++) {
      const vi = this.gunwaleVertexIndices[i];
      // World Z of this gunwale vertex, accounting for roll, pitch, heave
      const worldZ = body.worldZ(
        mesh.xyPositions[vi][0],
        mesh.xyPositions[vi][1],
        effectiveDeckHeight,
      );
      // Water surface height at this vertex (from GPU query)
      const waterSurface = vi < wq.length ? wq.get(vi).surfaceHeight : 0;
      this.gunwaleSubmersionDepths[i] = Math.max(0, waterSurface - worldZ);
    }

    // Sum ingress across all gunwale segments using weir flow: length × depth^(3/2).
    // The h^(3/2) comes from integrating Torricelli velocity sqrt(2gh) over the
    // submersion depth — correct scaling from gentle heel to full capsize.
    let totalFlow = 0;
    for (let i = 0; i < n; i++) {
      const avgDepth =
        (this.gunwaleSubmersionDepths[i] +
          this.gunwaleSubmersionDepths[(i + 1) % n]) *
        0.5;
      if (avgDepth > 0) {
        totalFlow +=
          this.gunwaleSegmentLengths[i] * avgDepth * Math.sqrt(avgDepth);
      }
    }

    if (totalFlow > 0) {
      this.waterVolume += INGRESS_COEFF * totalFlow * dt;
    }

    // Hull damage leak ingress
    const hullLeakRate = this.getHullLeakRate();
    if (hullLeakRate > 0) {
      this.waterVolume += hullLeakRate * dt;
    }

    // --- Water egress ---

    // Automatic bilge pump (if equipped)
    if (this.config.pumpDrainRate) {
      this.waterVolume -= this.config.pumpDrainRate * dt;
    }

    // Manual bailing — discrete bucket scoops
    if (this.bailing && this.waterVolume > 0) {
      this.bailTimer += dt;
      if (this.bailTimer >= this.config.bailInterval) {
        this.bailTimer -= this.config.bailInterval;
        this.waterVolume -= this.config.bailBucketSize;
        this.game.addEntity(
          new SoundInstance("bail1", {
            gain: 0.5,
            speed: rUniform(0.9, 1.1),
          }),
        );
      }
    } else {
      this.bailTimer = 0;
    }

    // Clamp
    this.waterVolume = clamp(this.waterVolume, 0, this.maxWaterVolume);

    // --- Check for sinking ---
    if (!this.sinking && this.waterVolume >= this.maxWaterVolume) {
      this.sinking = true;
      this.sinkTimer = 0;
      this.game.dispatch("boatSinking", {});
    }

    // --- Water mass effects ---
    const waterMass = this.waterVolume * this.config.waterDensity;

    if (waterMass > 0) {
      // Added drag: water weight makes the boat sluggish
      const velocity = body.velocity;
      const speed = velocity.magnitude;
      if (speed > 0.01) {
        const dragMagnitude = WATER_DRAG_COEFF * waterMass * speed;
        const norm = velocity.normalize();
        body.applyForce3D(
          -norm.x * dragMagnitude,
          -norm.y * dragMagnitude,
          0,
          0,
          0,
          0,
        );
      }
    }

    // --- Slosh physics: 2-axis damped oscillator driven by effective gravity ---
    //
    // In the hull-local frame, gravity is R^T * (0, 0, -G). If the hull is
    // accelerating, water in the hull's non-inertial frame feels an extra
    // pseudo-force -a, so effective gravity is (g_world - a_world). Projecting
    // this into the hull frame and normalizing gives the target plane normal,
    // from which we read off the target (slopeX, slopeY).
    //
    // We finite-difference body velocity to get world-frame acceleration.
    const vx = body.velocity.x;
    const vy = body.velocity.y;
    const vz = body.zVelocity;
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (this.hasPrevVelocity && dt > 1e-9) {
      ax = (vx - this.prevVelocityX) / dt;
      ay = (vy - this.prevVelocityY) / dt;
      az = (vz - this.prevVelocityZ) / dt;
    }
    this.prevVelocityX = vx;
    this.prevVelocityY = vy;
    this.prevVelocityZ = vz;
    this.hasPrevVelocity = true;

    // Effective gravity in world frame: gravity - hull_accel.
    const gEffWorldX = -ax;
    const gEffWorldY = -ay;
    const gEffWorldZ = -GRAVITY - az;

    // Rotate into hull-local: g_local = R^T * g_world. With R row-major,
    // column i of R is (R[i], R[i+3], R[i+6]), and (R^T v)_i = dot(col_i, v).
    const R = body.orientation;
    const gLocalX = R[0] * gEffWorldX + R[3] * gEffWorldY + R[6] * gEffWorldZ;
    const gLocalY = R[1] * gEffWorldX + R[4] * gEffWorldY + R[7] * gEffWorldZ;
    const gLocalZ = R[2] * gEffWorldX + R[5] * gEffWorldY + R[8] * gEffWorldZ;

    // Plane normal in hull frame is opposite to effective gravity. Writing the
    // plane as z = offset + sX*x + sY*y, the normal is (-sX, -sY, 1), parallel
    // to (-g_local). So sX = -g_local.x / g_local.z, sY = -g_local.y / g_local.z.
    // gLocalZ is normally strongly negative; guard for the inverted-boat edge.
    const safeGz =
      Math.abs(gLocalZ) > 1e-3 ? gLocalZ : gLocalZ >= 0 ? 1e-3 : -1e-3;
    // Cap slope targets at extreme attitudes. Past ~72° tilt of the water
    // plane the bilge integration and centroid are meaningless anyway, and
    // unclamped targets drive violent oscillator transients when the hull
    // is inverted or on its side.
    const MAX_SLOPE = 3;
    const rawSlopeX = -gLocalX / safeGz;
    const rawSlopeY = -gLocalY / safeGz;
    const slopeXTarget = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, rawSlopeX));
    const slopeYTarget = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, rawSlopeY));

    if (this.waterVolume > 0.01) {
      const wxLat = this.config.sloshFreqLateral;
      const wxLon = this.config.sloshFreqLongitudinal;
      const zeta = this.config.sloshDampingRatio;
      const kLon = wxLon * wxLon;
      const kLat = wxLat * wxLat;
      const cLon = 2 * zeta * wxLon;
      const cLat = 2 * zeta * wxLat;

      const accelSlopeX =
        (slopeXTarget - this.slopeX) * kLon - this.slopeXVelocity * cLon;
      const accelSlopeY =
        (slopeYTarget - this.slopeY) * kLat - this.slopeYVelocity * cLat;
      this.slopeXVelocity += accelSlopeX * dt;
      this.slopeYVelocity += accelSlopeY * dt;
      this.slopeX += this.slopeXVelocity * dt;
      this.slopeY += this.slopeYVelocity * dt;
    } else {
      // No water: relax everything toward the target (so the plane is already
      // warmed up if water arrives mid-heel) but skip bisection and forces.
      this.slopeX = slopeXTarget;
      this.slopeY = slopeYTarget;
      this.slopeXVelocity = 0;
      this.slopeYVelocity = 0;
      this.offset = this.volumeToZ(0);
      this.poolCentroidX = 0;
      this.poolCentroidY = 0;
      this.poolCentroidZ = this.offset;
      return;
    }

    // --- Volume-conserving offset via bisection ---
    //
    // Target the same mapped volume the renderer expects: scale the physical
    // waterVolume by totalHullVolume/maxWaterVolume so a full bilge corresponds
    // to a full hull interior at the rendering geometry.
    const targetVolume =
      (this.waterVolume / this.maxWaterVolume) * this.totalHullVolume;
    const seedZ = this.volumeToZ(targetVolume);
    const draft = this.boat.config.hull.draft;
    const deckHeight = this.boat.config.hull.deckHeight;
    const bracket = draft + deckHeight;
    let lo = seedZ - bracket;
    let hi = seedZ + bracket;
    let lastStats = this.integratePoolUnderPlane(
      this.slopeX,
      this.slopeY,
      seedZ,
    );
    for (let iter = 0; iter < BISECTION_ITERATIONS; iter++) {
      const mid = (lo + hi) * 0.5;
      lastStats = this.integratePoolUnderPlane(this.slopeX, this.slopeY, mid);
      if (lastStats.volume > targetVolume) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    this.offset = (lo + hi) * 0.5;
    // One more integration at the final midpoint so the centroid matches the
    // offset we actually use for rendering and force application.
    lastStats = this.integratePoolUnderPlane(
      this.slopeX,
      this.slopeY,
      this.offset,
    );
    this.poolCentroidX = lastStats.cx;
    this.poolCentroidY = lastStats.cy;
    this.poolCentroidZ = lastStats.cz;

    // --- Water weight application ---
    //
    // The free-surface effect exists because water redistributes into space
    // formerly occupied by air. When the bilge is fully flooded there is no
    // air to swap with, so the slosh torque must vanish and the water weight
    // should act at a fixed interior centroid. We blend between the sloshing
    // pool centroid and the precomputed static centroid by `airFraction`.
    // At airFraction = 1 this reduces exactly to the previous behavior; at
    // airFraction = 0 the water acts as a rigid ballast at the hull interior
    // centroid, eliminating the self-reinforcing slosh loop that destabilizes
    // the hull when it sinks completely.
    if (waterMass > 0) {
      const fillFraction = Math.max(
        0,
        Math.min(1, this.waterVolume / this.maxWaterVolume),
      );
      const airFraction = 1 - fillFraction;
      const appCx =
        this.staticCentroidX +
        (this.poolCentroidX - this.staticCentroidX) * airFraction;
      const appCy =
        this.staticCentroidY +
        (this.poolCentroidY - this.staticCentroidY) * airFraction;
      const appCz =
        this.staticCentroidZ +
        (this.poolCentroidZ - this.staticCentroidZ) * airFraction;
      body.applyForce3D(0, 0, -waterMass * GRAVITY, appCx, appCy, appCz);
    }
  }

  /**
   * Walk all hull stations, computing per-station wetted area and first moments
   * under the tilted plane z(x, y) = offset + slopeX*x + slopeY*y. Trapezoidal-
   * integrates along x to get total volume and centroid (cx, cy, cz) in
   * hull-local coordinates. Returns zero-volume stats if the plane is entirely
   * above or below the hull.
   */
  private integratePoolUnderPlane(
    slopeX: number,
    slopeY: number,
    offset: number,
  ): { volume: number; cx: number; cy: number; cz: number } {
    const mesh = this.hullMesh;
    const xyPositions = mesh.xyPositions;
    const ringSize = mesh.ringSize;
    const numStations = xyPositions.length / ringSize;

    let volume = 0;
    let mx = 0;
    let my = 0;
    let mz = 0;

    // Trapezoidal integration along x: accumulate ∫ A(x) dx with
    // A(x) the station's wetted area, and ∫ A(x)*cy(x) dx for the lateral
    // moment, etc. Station x is fixed per ring so we just need area and the
    // area-weighted (y, z) centroid at each station.
    let prevStationX = 0;
    let prevA = 0;
    let prevAy = 0;
    let prevAz = 0;
    let haveHPrev = false;
    for (let si = 0; si < numStations; si++) {
      const base = si * ringSize;
      const xStation = xyPositions[base][0];
      // Plane intersection line for this station: z(y) = planeZ0 + slopeY*y
      const planeZ0 = offset + slopeX * xStation;
      const { area, areaY, areaZ } = this.wettedStationStats(
        base,
        ringSize,
        planeZ0,
        slopeY,
      );

      if (haveHPrev) {
        const dx = xStation - prevStationX;
        // Midpoint x across the segment for the x moment (linear A assumed).
        // ∫ x * A(x) dx over trapezoid ≈ 0.5*dx*(xPrev*Aprev + xCur*Acur).
        volume += 0.5 * dx * (prevA + area);
        mx += 0.5 * dx * (prevStationX * prevA + xStation * area);
        my += 0.5 * dx * (prevAy + areaY);
        mz += 0.5 * dx * (prevAz + areaZ);
      }
      prevStationX = xStation;
      prevA = area;
      prevAy = areaY;
      prevAz = areaZ;
      haveHPrev = true;
    }

    if (volume <= 1e-9) {
      return { volume: 0, cx: 0, cy: 0, cz: offset };
    }
    return {
      volume,
      cx: mx / volume,
      cy: my / volume,
      cz: mz / volume,
    };
  }

  /**
   * For one hull station, given the plane z(y) = planeZ0 + slopeY*y in the
   * station's (y, z) frame, clip the full cross-section polygon against the
   * half-plane z < z_plane(y) and return the wetted area plus first moments
   * (∫ y dA, ∫ z dA). Uses Sutherland-Hodgman clipping with a shoelace pass.
   */
  private wettedStationStats(
    base: number,
    ringSize: number,
    planeZ0: number,
    slopeY: number,
  ): { area: number; areaY: number; areaZ: number } {
    const xyPositions = this.hullMesh.xyPositions;
    const zValues = this.hullMesh.zValues;

    // Build the clip input: full cross-section in (y, z). The vertices are
    // already ordered starboard-gunwale → keel → port-gunwale, which is a
    // simple closed polygon in the (y, z) plane (non-self-intersecting).
    const inY = this.clipInY;
    const inZ = this.clipInZ;
    for (let j = 0; j < ringSize; j++) {
      inY[j] = xyPositions[base + j][1];
      inZ[j] = zValues[base + j];
    }
    let inCount = ringSize;

    // Collapsed station (bow/stern pinch): no area.
    let anyY = false;
    for (let j = 0; j < ringSize; j++) {
      if (Math.abs(inY[j]) > 1e-6) {
        anyY = true;
        break;
      }
    }
    if (!anyY) return { area: 0, areaY: 0, areaZ: 0 };

    // Clip against the half-plane f(y, z) = (planeZ0 + slopeY*y) - z >= 0,
    // i.e. keep points where z <= planeZ0 + slopeY*y (water is *below* the
    // tilted free surface in hull frame).
    const outY = this.clipOutY;
    const outZ = this.clipOutZ;
    let outCount = 0;
    const cap = outY.length;

    // We rely on the "polygon" input being closed — treat (last, first) as
    // the final edge. For each edge, keep points inside the half-plane and
    // emit crossing points where it straddles.
    let prevY = inY[inCount - 1];
    let prevZ = inZ[inCount - 1];
    let prevF = planeZ0 + slopeY * prevY - prevZ;
    for (let j = 0; j < inCount; j++) {
      const curY = inY[j];
      const curZ = inZ[j];
      const curF = planeZ0 + slopeY * curY - curZ;
      if (curF >= 0) {
        if (prevF < 0 && outCount < cap) {
          // Entering: emit crossing, then current vertex.
          const t = prevF / (prevF - curF);
          outY[outCount] = prevY + t * (curY - prevY);
          outZ[outCount] = prevZ + t * (curZ - prevZ);
          outCount++;
        }
        if (outCount < cap) {
          outY[outCount] = curY;
          outZ[outCount] = curZ;
          outCount++;
        }
      } else if (prevF >= 0 && outCount < cap) {
        // Leaving: emit crossing only.
        const t = prevF / (prevF - curF);
        outY[outCount] = prevY + t * (curY - prevY);
        outZ[outCount] = prevZ + t * (curZ - prevZ);
        outCount++;
      }
      prevY = curY;
      prevZ = curZ;
      prevF = curF;
    }

    if (outCount < 3) return { area: 0, areaY: 0, areaZ: 0 };

    // Shoelace area and first moments. Standard formulas:
    //   A    = 0.5 * Σ (y_i * z_{i+1} - y_{i+1} * z_i)
    //   Cy*A = (1/6) * Σ (y_i + y_{i+1}) * (y_i*z_{i+1} - y_{i+1}*z_i)
    //   Cz*A = (1/6) * Σ (z_i + z_{i+1}) * (y_i*z_{i+1} - y_{i+1}*z_i)
    // Sign of A tracks winding; take absolute value and flip moment signs to match.
    let signedArea = 0;
    let signedMy = 0;
    let signedMz = 0;
    for (let i = 0; i < outCount; i++) {
      const i1 = (i + 1) % outCount;
      const yi = outY[i];
      const zi = outZ[i];
      const yj = outY[i1];
      const zj = outZ[i1];
      const cross = yi * zj - yj * zi;
      signedArea += cross;
      signedMy += (yi + yj) * cross;
      signedMz += (zi + zj) * cross;
    }
    const area = 0.5 * Math.abs(signedArea);
    if (area < 1e-9) return { area: 0, areaY: 0, areaZ: 0 };
    const sign = signedArea >= 0 ? 1 : -1;
    const areaY = (sign * signedMy) / 6;
    const areaZ = (sign * signedMz) / 6;
    return { area, areaY, areaZ };
  }

  /**
   * Bake the interior water quad's vertex and index data into `outVerts`
   * and `outIndices` for rendering by `BoatRenderer`. Returns `{ vertexCount,
   * indexCount }` — both zero when there's nothing to draw.
   *
   * For each station, find where the tilted water plane
   *     z(x, y) = offset + slopeX*x + slopeY*y
   * intersects the station's half-profile on the starboard (+y) and port (-y)
   * sides. Those two points per station form the outline of the pool at that
   * station. Walking stations stern→bow on starboard and bow→stern on port
   * gives a closed polygon tracing the water-hull intersection.
   *
   * Vertex layout matches `BOAT_AIR_VERTEX_SIZE`: position.xy (world),
   * z (world). The z component carries the bilge surface height that the
   * stamp shader writes into `waterHeightTexture`.
   */
  buildHullWaterVertices(
    outVerts: Float32Array,
    outIndices: Uint16Array,
  ): { vertexCount: number; indexCount: number } {
    if (this.waterVolume < 0.01) {
      return { vertexCount: 0, indexCount: 0 };
    }

    const offset = this.offset;
    const slopeX = this.slopeX;
    const slopeY = this.slopeY;

    const mesh = this.hullMesh;
    const xyPositions = mesh.xyPositions;
    const zValues = mesh.zValues;
    const ringSize = mesh.ringSize;
    const halfM = (ringSize + 1) / 2;
    const numStations = xyPositions.length / ringSize;
    const maxOutVerts = outVerts.length / BOAT_AIR_VERTEX_SIZE;

    const body = this.boat.hull.body;
    const R = body.orientation;
    const bx = body.position[0];
    const by = body.position[1];
    const bz = body.z;

    const sX = this.stationX;
    const sYStar = this.starboardY;
    const sZStar = this.starboardZ;
    const sYPort = this.portY;
    const sZPort = this.portZ;
    const sValidStar = this.starboardValid;
    const sValidPort = this.portValid;

    // The outline of the pool at each station is the intersection of the tilted
    // water plane with the station cross-section, clipped to the hull interior.
    // Key invariant: outline vertices must lie ON the hull surface — never
    // above the gunwale z — otherwise the rendered polygon spills out of the
    // boat. When the plane is above the gunwale we clamp to the gunwale z; at
    // a profile crossing we use the interpolated profile z (which is on the
    // hull by construction).
    for (let si = 0; si < numStations; si++) {
      const base = si * ringSize;
      const xStation = xyPositions[base][0];
      sX[si] = xStation;
      sValidStar[si] = 0;
      sValidPort[si] = 0;

      // Per-station plane in (y, z): z(y) = planeZ0 + slopeY*y
      const planeZ0 = offset + slopeX * xStation;

      // --- Starboard side (+y half-profile, j=0 at gunwale .. halfM-1 at keel) ---
      {
        const gunwaleY = xyPositions[base][1];
        const gunwaleZ = zValues[base];
        let d0 = gunwaleZ - (planeZ0 + slopeY * gunwaleY);
        if (d0 < 0) {
          sYStar[si] = gunwaleY;
          sZStar[si] = gunwaleZ;
          sValidStar[si] = 1;
        } else {
          for (let j = 0; j < halfM - 1; j++) {
            const y1 = xyPositions[base + j + 1][1];
            const z1 = zValues[base + j + 1];
            const d1 = z1 - (planeZ0 + slopeY * y1);
            if (d1 < 0) {
              const y0 = xyPositions[base + j][1];
              const z0 = zValues[base + j];
              const denom = d0 - d1;
              const t = denom > 1e-9 ? d0 / denom : 0;
              sYStar[si] = y0 + t * (y1 - y0);
              sZStar[si] = z0 + t * (z1 - z0);
              sValidStar[si] = 1;
              break;
            }
            d0 = d1;
          }
        }
      }

      // --- Port side (mirrored half-profile, y_port = -y_profile) ---
      {
        const y0Profile = xyPositions[base][1];
        const gunwaleZ = zValues[base];
        let d0 = gunwaleZ - (planeZ0 + slopeY * -y0Profile);
        if (d0 < 0) {
          sYPort[si] = -y0Profile;
          sZPort[si] = gunwaleZ;
          sValidPort[si] = 1;
        } else {
          for (let j = 0; j < halfM - 1; j++) {
            const y1Profile = xyPositions[base + j + 1][1];
            const z1 = zValues[base + j + 1];
            const d1 = z1 - (planeZ0 + slopeY * -y1Profile);
            if (d1 < 0) {
              const yjProfile = xyPositions[base + j][1];
              const zjProfile = zValues[base + j];
              const denom = d0 - d1;
              const t = denom > 1e-9 ? d0 / denom : 0;
              sYPort[si] = -(yjProfile + t * (y1Profile - yjProfile));
              sZPort[si] = zjProfile + t * (z1 - zjProfile);
              sValidPort[si] = 1;
              break;
            }
            d0 = d1;
          }
        }
      }
    }

    // --- Bake outline: starboard stern→bow, then port bow→stern ---
    // Small hull-local z nudge to avoid z-fighting with the hull mesh when
    // the water plane coincides with the gunwale (full bilge) or bottom.
    let n = 0;
    const writeVertex = (vx: number, vy: number, vzRaw: number): void => {
      if (n >= maxOutVerts) return;
      const vz = vzRaw + HULL_WATER_Z_BIAS;
      const worldX = R[0] * vx + R[1] * vy + R[2] * vz + bx;
      const worldY = R[3] * vx + R[4] * vy + R[5] * vz + by;
      const worldZ = R[6] * vx + R[7] * vy + R[8] * vz + bz;
      const off = n * BOAT_AIR_VERTEX_SIZE;
      outVerts[off] = worldX;
      outVerts[off + 1] = worldY;
      outVerts[off + 2] = worldZ;
      n++;
    };

    for (let si = 0; si < numStations; si++) {
      if (sValidStar[si]) {
        writeVertex(sX[si], sYStar[si], sZStar[si]);
      }
    }
    for (let si = numStations - 1; si >= 0; si--) {
      if (sValidPort[si]) {
        const vy = sYPort[si];
        if (Math.abs(vy) < 0.01) continue; // collapsed bow/stern point
        writeVertex(sX[si], vy, sZPort[si]);
      }
    }

    if (n < 3) return { vertexCount: 0, indexCount: 0 };

    // Fan triangulation from vertex 0. The outline is convex (hull cross-
    // sections are ~elliptical and the tilted plane preserves convexity).
    const triCount = n - 2;
    const indexCount = triCount * 3;
    for (let i = 0; i < triCount; i++) {
      outIndices[i * 3] = 0;
      outIndices[i * 3 + 1] = i + 1;
      outIndices[i * 3 + 2] = i + 2;
    }

    return { vertexCount: n, indexCount };
  }

  /** Longitudinal slope of the bilge water plane (dz/dx in hull-local). */
  getSlopeX(): number {
    return this.slopeX;
  }

  /** Lateral slope of the bilge water plane (dz/dy in hull-local). */
  getSlopeY(): number {
    return this.slopeY;
  }

  /** Rate of change of the longitudinal slope (1/s). */
  getSlopeXVelocity(): number {
    return this.slopeXVelocity;
  }

  /** Rate of change of the lateral slope (1/s). */
  getSlopeYVelocity(): number {
    return this.slopeYVelocity;
  }
}
