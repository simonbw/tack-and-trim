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
import { HULL_WATER_VERTEX_SIZE } from "./HullWaterShader";

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

// Water rendering
const WATER_COLOR = 0x2266aa;
const WATER_ALPHA = 0.65;

// How much the slosh offset tilts the rendered water surface (radians-ish).
const SLOSH_TILT_SCALE = 0.3;

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
 * sloshes toward the low side amplifying heel, and can be removed by an automatic
 * bilge pump or manual bailing. At 100% capacity the boat sinks.
 */
export class Bilge extends BaseEntity {
  layer = "boat" as const;

  /** Current water volume in cubic ft */
  waterVolume: number = 0;

  /** Lateral slosh offset: -1 (starboard) to +1 (port) */
  private sloshOffset: number = 0;
  private sloshVelocity: number = 0;

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
  private portY: Float64Array;
  private starboardValid: Uint8Array;
  private portValid: Uint8Array;

  /**
   * Precomputed cumulative-volume table for mapping water volume to visual z.
   * `volumeTableZ[i]` is a z-level from hull bottom to deck; `volumeTableV[i]`
   * is the hull interior volume below that z (trapezoidal integral of the
   * hull cross-section area). Used at render time to find the water surface
   * z for a given accumulated water volume — correct for non-linear hull
   * shapes where most of the volume sits in the upper, wider sections.
   */
  private volumeTableZ: Float64Array;
  private volumeTableV: Float64Array;
  private totalHullVolume: number;

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
    this.portY = new Float64Array(numStations);
    this.starboardValid = new Uint8Array(numStations);
    this.portValid = new Uint8Array(numStations);

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
    // Linear scan — table is small (~48 entries) and rising monotonically.
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
      }
      return;
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
    if (this.waterVolume >= this.maxWaterVolume) {
      this.sinking = true;
      this.sinkTimer = 0;
      this.game.dispatch("boatSinking", {});
      return;
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

    // --- Slosh physics ---
    if (this.waterVolume > 0.01) {
      // Water accelerates toward the low side (gravity pulls it down the heel)
      const sloshAccel =
        -Math.sin(this.boat.roll) * this.config.sloshGravity -
        this.sloshVelocity * this.config.sloshDamping;

      this.sloshVelocity += sloshAccel * dt;
      this.sloshOffset += this.sloshVelocity * dt;
      this.sloshOffset = clamp(this.sloshOffset, -1, 1);
    } else {
      this.sloshOffset = 0;
      this.sloshVelocity = 0;
    }

    // Water weight as downward force at its center of mass.
    // The lateral position shifts based on slosh (water moves to the low side).
    // The vertical position rises with fill fraction, naturally reducing righting moment.
    if (waterMass > 0) {
      const draft = this.boat.config.hull.draft;
      const deckHeight = this.boat.config.hull.deckHeight;
      const waterCgZ = -draft + (draft + deckHeight) * waterFraction * 0.5;
      const waterCgY = this.sloshOffset * this.halfBeam;
      body.applyForce3D(0, 0, -waterMass * GRAVITY, 0, waterCgY, waterCgZ);
    }
  }

  /**
   * Bake the interior water quad's vertex and index data into `outVerts`
   * and `outIndices` for rendering by `BoatRenderer`. Returns `{ vertexCount,
   * indexCount }` — both zero when there's nothing to draw.
   *
   * For each station of the hull mesh, find where the tilted water plane
   * z(y) = waterZ + sloshTilt * y intersects the station's half-profile on
   * the starboard (+y) and port (-y) sides. Those two points per station
   * form the outline of the pool at that station. Walking the stations
   * stern→bow on starboard and bow→stern on port gives a closed polygon
   * that exactly traces the water-hull intersection, including the slosh
   * tilt — unlike `extractHullOutlineAtZ` which assumes a horizontal plane.
   *
   * Vertex layout matches `HULL_WATER_VERTEX_SIZE`: position.xy (world),
   * localUV.xy (hull-local), z (world).
   */
  buildHullWaterVertices(
    outVerts: Float32Array,
    outIndices: Uint16Array,
  ): { vertexCount: number; indexCount: number } {
    if (this.waterVolume < 0.01 && !this.sinking) {
      return { vertexCount: 0, indexCount: 0 };
    }

    // Map accumulated volume → visual z via the precomputed hull cumulative-
    // volume table. This gives the physically-correct water surface height:
    // the pool rises quickly in the narrow keel region and slowly across the
    // wide upper sections. Note the volume table is built from horizontal
    // cross-sections, so this is the AVERAGE surface height of the pool;
    // slosh tilts about y = 0 which preserves total volume for symmetric hulls.
    const targetVolume =
      (this.waterVolume / this.maxWaterVolume) * this.totalHullVolume;
    const waterZ = this.volumeToZ(targetVolume);
    const sloshTilt = this.sloshOffset * SLOSH_TILT_SCALE;

    const mesh = this.hullMesh;
    const xyPositions = mesh.xyPositions;
    const zValues = mesh.zValues;
    const ringSize = mesh.ringSize;
    const halfM = (ringSize + 1) / 2;
    const numStations = xyPositions.length / ringSize;
    const maxOutVerts = outVerts.length / HULL_WATER_VERTEX_SIZE;

    const body = this.boat.hull.body;
    const R = body.orientation;
    const bx = body.position[0];
    const by = body.position[1];
    const bz = body.z;

    // Scratch: per-station intersection results. Use the same scratch storage
    // each frame via the Float64Array fields on `this`.
    const sX = this.stationX;
    const sYStar = this.starboardY;
    const sYPort = this.portY;
    const sValidStar = this.starboardValid;
    const sValidPort = this.portValid;

    for (let si = 0; si < numStations; si++) {
      const base = si * ringSize;
      sX[si] = xyPositions[base][0];
      sValidStar[si] = 0;
      sValidPort[si] = 0;

      // --- Starboard side (+y half-profile, j = 0 at gunwale .. halfM-1 at keel) ---
      // Find the first segment where (profile_z - water_z(profile_y)) crosses
      // from non-negative to negative — i.e., profile goes from above water
      // to below. Linear interpolate to find the crossing point.
      {
        let d0 = zValues[base] - (waterZ + sloshTilt * xyPositions[base][1]);
        if (d0 < 0) {
          // Gunwale already submerged on the starboard side → the entire
          // starboard beam is underwater at this station. Use the gunwale.
          sYStar[si] = xyPositions[base][1];
          sValidStar[si] = 1;
        } else {
          for (let j = 0; j < halfM - 1; j++) {
            const y1 = xyPositions[base + j + 1][1];
            const z1 = zValues[base + j + 1];
            const d1 = z1 - (waterZ + sloshTilt * y1);
            if (d1 < 0) {
              // Crossing between profile point j and j+1
              const y0 = xyPositions[base + j][1];
              const denom = d0 - d1;
              const t = denom > 1e-9 ? d0 / denom : 0;
              sYStar[si] = y0 + t * (y1 - y0);
              sValidStar[si] = 1;
              break;
            }
            d0 = d1;
          }
          // If no crossing found (the whole profile is above water), the
          // station has no water intersection on starboard — leave invalid.
        }
      }

      // --- Port side (mirrored: y_port = -y_profile) ---
      // Tilted plane at port: z(y_port) = waterZ + sloshTilt * (-y_profile)
      {
        const y0Profile = xyPositions[base][1];
        let d0 = zValues[base] - (waterZ - sloshTilt * y0Profile);
        if (d0 < 0) {
          sYPort[si] = -y0Profile;
          sValidPort[si] = 1;
        } else {
          for (let j = 0; j < halfM - 1; j++) {
            const y1Profile = xyPositions[base + j + 1][1];
            const z1 = zValues[base + j + 1];
            const d1 = z1 - (waterZ - sloshTilt * y1Profile);
            if (d1 < 0) {
              const yjProfile = xyPositions[base + j][1];
              const denom = d0 - d1;
              const t = denom > 1e-9 ? d0 / denom : 0;
              sYPort[si] = -(yjProfile + t * (y1Profile - yjProfile));
              sValidPort[si] = 1;
              break;
            }
            d0 = d1;
          }
        }
      }
    }

    // --- Bake outline: starboard stern→bow, then port bow→stern ---
    // We emit into outVerts directly. Skip collapsed points (y ≈ 0) on the
    // port pass to avoid duplicates where stations pinch together at bow/stern.
    let n = 0;
    const writeVertex = (vx: number, vy: number, vz: number): void => {
      if (n >= maxOutVerts) return;
      const worldX = R[0] * vx + R[1] * vy + R[2] * vz + bx;
      const worldY = R[3] * vx + R[4] * vy + R[5] * vz + by;
      const worldZ = R[6] * vx + R[7] * vy + R[8] * vz + bz;
      const off = n * HULL_WATER_VERTEX_SIZE;
      outVerts[off] = worldX;
      outVerts[off + 1] = worldY;
      outVerts[off + 2] = vx; // localUV.x
      outVerts[off + 3] = vy; // localUV.y
      outVerts[off + 4] = worldZ;
      n++;
    };

    for (let si = 0; si < numStations; si++) {
      if (sValidStar[si]) {
        const vy = sYStar[si];
        writeVertex(sX[si], vy, waterZ + sloshTilt * vy);
      }
    }
    for (let si = numStations - 1; si >= 0; si--) {
      if (sValidPort[si]) {
        const vy = sYPort[si];
        if (Math.abs(vy) < 0.01) continue; // collapsed bow/stern point
        writeVertex(sX[si], vy, waterZ + sloshTilt * vy);
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

  /** Current color to tint the hull water quad with. */
  getWaterColor(): number {
    return WATER_COLOR;
  }

  /**
   * Base alpha multiplier for the hull water quad. Ramps up during sinking
   * so the interior fills in as the boat goes under.
   */
  getWaterAlpha(): number {
    let alpha = WATER_ALPHA;
    if (this.sinking) {
      const sinkFraction = this.sinkTimer / this.config.sinkingDuration;
      alpha = WATER_ALPHA + (1 - WATER_ALPHA) * sinkFraction;
    }
    return alpha;
  }

  /** Current slosh offset (-1 starboard .. +1 port) for shader animation. */
  getSloshOffset(): number {
    return this.sloshOffset;
  }

  /** Current slosh velocity for shader animation. */
  getSloshVelocity(): number {
    return this.sloshVelocity;
  }
}
