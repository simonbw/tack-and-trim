import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { SoundInstance } from "../../core/sound/SoundInstance";
import { clamp } from "../../core/util/MathUtil";
import { rUniform } from "../../core/util/Random";
import { V, V2d } from "../../core/Vector";
import { BilgeConfig } from "./BoatConfig";
import type { Boat } from "./Boat";

const GRAVITY = 32.174; // ft/s²

// Water drag coefficient applied per lb of water mass per ft/s of boat speed
const WATER_DRAG_COEFF = 0.08;

// Water rendering
const WATER_COLOR = 0x2266aa;
const WATER_ALPHA = 0.45;

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

  /** Cached hull vertices for water polygon clipping */
  private hullVertices: V2d[];

  constructor(
    private boat: Boat,
    private config: BilgeConfig,
  ) {
    super();
    this.hullVertices = boat.config.hull.vertices;
  }

  /** Get the water level as a fraction 0-1 */
  getWaterFraction(): number {
    return this.waterVolume / this.config.maxWaterVolume;
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

    // --- Water ingress ---
    const waterFraction = this.getWaterFraction();

    // Effective freeboard decreases as water accumulates (boat sits lower)
    const freeboard =
      this.boat.config.hull.deckHeight * (1 - waterFraction * 0.8);

    // Deck edge submersion: leeward rail dips below water when heeled
    const rollAbs = Math.abs(this.boat.roll);
    const deckDip = this.config.halfBeam * Math.sin(rollAbs);
    const submersionDepth = Math.max(0, deckDip - freeboard);

    if (submersionDepth > 0) {
      const ingress = this.config.ingressCoefficient * submersionDepth * dt;
      this.waterVolume += ingress;
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
    this.waterVolume = clamp(this.waterVolume, 0, this.config.maxWaterVolume);

    // --- Check for sinking ---
    if (this.waterVolume >= this.config.maxWaterVolume) {
      this.sinking = true;
      this.sinkTimer = 0;
      this.game.dispatch("boatSinking", {});
      return;
    }

    // --- Water mass effects ---
    const waterMass = this.waterVolume * this.config.waterDensity;
    const bb = this.boat.buoyantBody;

    if (waterMass > 0) {
      // Added drag: water weight makes the boat sluggish
      const velocity = this.boat.hull.body.velocity;
      const speed = velocity.magnitude;
      if (speed > 0.01) {
        const dragMagnitude = WATER_DRAG_COEFF * waterMass * speed;
        const norm = velocity.normalize();
        bb.applyForce3D(
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
      const waterCgY = this.sloshOffset * this.config.halfBeam;
      bb.applyForce3D(0, 0, -waterMass * GRAVITY, 0, waterCgY, waterCgZ);
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    if (this.waterVolume < 0.01 && !this.sinking) return;

    const [x, y] = this.boat.hull.body.position;
    const roll = this.boat.hull.tiltRoll;
    const pitch = this.boat.hull.tiltPitch;
    const zOffset = this.boat.hull.getZOffset();

    // Water fill level in hull-local z-space
    // At 0 water: water surface is at hull bottom (-draft)
    // At max water: water surface is at deck height
    const waterFraction = this.getWaterFraction();
    const draft = this.boat.config.hull.draft;
    const deckHeight = this.boat.config.hull.deckHeight;
    const waterZ = -draft + (draft + deckHeight) * waterFraction;

    // Slosh tilts the water surface laterally
    // The water surface is a line in hull-local y-z space:
    // z_water(y) = waterZ + sloshOffset * sloshTiltScale * y
    const sloshTiltScale = this.sloshOffset * 0.3; // radians-ish tilt

    // Sinking effect: hull fades out during sinking
    let alpha = WATER_ALPHA;
    if (this.sinking) {
      const sinkFraction = this.sinkTimer / this.config.sinkingDuration;
      alpha = WATER_ALPHA + (1 - WATER_ALPHA) * sinkFraction;
    }

    draw.at(
      {
        pos: V(x, y),
        angle: this.boat.hull.body.angle,
        tilt: { roll, pitch, zOffset },
      },
      () => {
        // Compute water polygon by clipping hull vertices to those below water level
        const waterPoly = this.computeWaterPolygon(waterZ, sloshTiltScale);

        if (waterPoly.length >= 3) {
          draw.fillPolygon(waterPoly, { color: WATER_COLOR, alpha, z: waterZ });
        }
      },
    );
  }

  /**
   * Compute the visible water polygon in body-local coordinates.
   *
   * For each hull vertex, compute the water z-height at that y-position
   * (accounting for slosh tilt). Vertices below the water line are included
   * directly; edges crossing the water line are clipped. Returns body-local
   * (x, y) positions — the GPU tilt context handles the 3D projection.
   */
  private computeWaterPolygon(waterZ: number, sloshTilt: number): V2d[] {
    const verts = this.hullVertices;
    const n = verts.length;
    const result: V2d[] = [];
    const deckZ = this.boat.config.hull.deckHeight;

    for (let i = 0; i < n; i++) {
      const curr = verts[i];
      const next = verts[(i + 1) % n];

      // Water z at each vertex's y position (slosh tilts the water surface)
      const wZCurr = waterZ + sloshTilt * curr.y;
      const wZNext = waterZ + sloshTilt * next.y;

      // Hull deck vertices are at z = deckHeight
      // A vertex is "below water" if deckZ < waterZ at that point
      const currBelow = deckZ <= wZCurr;
      const nextBelow = deckZ <= wZNext;

      if (currBelow) {
        // Current vertex is below water — use body-local position
        result.push(V(curr.x, curr.y));
      }

      // If the edge crosses the water line, compute intersection
      if (currBelow !== nextBelow) {
        // Interpolate: find t where deckZ = waterZ + sloshTilt * lerp(curr.y, next.y, t)
        const diffCurr = wZCurr - deckZ;
        const diffNext = wZNext - deckZ;
        const denom = diffCurr - diffNext;
        if (Math.abs(denom) > 1e-6) {
          const t = diffCurr / denom;
          const ix = curr.x + t * (next.x - curr.x);
          const iy = curr.y + t * (next.y - curr.y);
          result.push(V(ix, iy));
        }
      }
    }

    return result;
  }
}
