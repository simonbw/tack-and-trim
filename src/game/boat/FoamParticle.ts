import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/physics/collision/AABB";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "../world/water/WaterModifierBase";

// Scales time-averaged suction flux → foam intensity.
// Formula: avgFlux / halfWidth² (flux density, units 1/s). Scale calibrates
// typical cruising stern flux (~1.5 ft³/s over ~0.5 ft² triangles) to ~0.4,
// with strong stern sources approaching 1.0. Intentionally does NOT divide
// by group speed — the previous formulation inverted the physics, making
// foam dim at high speed and bright at rest, the opposite of reality.
const TURBULENCE_SCALE = 0.2;

// Foam fades out exponentially with this e-folding time. Long tail lets the
// trail linger well after the boat has passed.
const FOAM_DAMPING_TIME = 8; // s

// Kill once intensity falls below this.
const MIN_VISIBLE_INTENSITY = 0.02;

// Fraction of lifetime over which intensity is linearly ramped from the
// exponential curve down to exactly 0. Guarantees clean disappearance
// instead of a visible snap-off when the particle destroys itself — the
// exponential alone leaves intensity at MIN_VISIBLE_INTENSITY at death,
// which the downstream foam shader visibly amplifies.
const TAIL_FRACTION = 0.3;

export interface FoamParticleOptions {
  /** Source world position (ft). */
  worldX: number;
  worldY: number;
  /**
   * Time-averaged suction flux over the emitting triangle's accumulation
   * period (ft³/s). Represents this triangle's average contribution since
   * its last round-robin turn.
   */
  avgFlux: number;
  /** Characteristic source size (ft) — sets blob Gaussian width. */
  halfWidth: number;
  /** Local group speed (ft/s) — used for dimensionless intensity scaling. */
  groupSpeed: number;
}

/**
 * Turbulent-wake / foam particle emitted by a waterline triangle whose flow
 * has separated (rear-facing relative to local velocity).
 *
 * Unlike the coherent `WakeParticle`, this is a *static* Gaussian blob that
 * fades slowly in place — matching how flow-separation foam lingers behind
 * a passing hull for many seconds rather than propagating outward as a wave.
 *
 * Advection by local wind / current is a later enhancement; for now the blob
 * stays fixed in world space.
 */
export class FoamParticle extends WaterModifier {
  tickLayer = "effects" as const;

  private readonly posX: number;
  private readonly posY: number;
  private readonly radius: number;
  private readonly initialIntensity: number;

  private age: number = 0;
  private readonly maxAge: number;

  private readonly aabb: AABB = new AABB();

  constructor(options: FoamParticleOptions) {
    super();
    this.posX = options.worldX;
    this.posY = options.worldY;
    this.radius = options.halfWidth;

    // Intensity from time-averaged suction flux per unit source footprint.
    // Scales with speed (because flux does), not inversely — a fast boat's
    // stern generates more visible foam than a stationary one.
    const rSq = Math.max(this.radius * this.radius, 0.01);
    const raw = (TURBULENCE_SCALE * options.avgFlux) / rSq;
    this.initialIntensity = Math.min(1, raw);

    // Lifespan: fade until intensity drops below visible threshold.
    this.maxAge =
      this.initialIntensity > MIN_VISIBLE_INTENSITY
        ? FOAM_DAMPING_TIME *
          Math.log(this.initialIntensity / MIN_VISIBLE_INTENSITY)
        : 0;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    this.age += dt;
    if (this.age >= this.maxAge) this.destroy();
  }

  getWaterModifierAABB(): AABB {
    const r = this.radius * 3;
    this.aabb.lowerBound.x = this.posX - r;
    this.aabb.lowerBound.y = this.posY - r;
    this.aabb.upperBound.x = this.posX + r;
    this.aabb.upperBound.y = this.posY + r;
    return this.aabb;
  }

  getGPUModifierData(): GPUWaterModifierData | null {
    if (this.isDestroyed) return null;

    const decay = Math.exp(-this.age / FOAM_DAMPING_TIME);
    const lifeFrac = this.maxAge > 0 ? this.age / this.maxAge : 1;
    const tailStart = 1 - TAIL_FRACTION;
    const tail =
      lifeFrac < tailStart
        ? 1
        : Math.max(0, 1 - (lifeFrac - tailStart) / TAIL_FRACTION);
    const intensity = this.initialIntensity * decay * tail;

    return {
      type: WaterModifierType.Foam,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Foam,
        posX: this.posX,
        posY: this.posY,
        radius: this.radius,
        intensity,
      },
    };
  }
}
