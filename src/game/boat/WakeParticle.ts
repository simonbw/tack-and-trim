import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/physics/collision/AABB";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "../world/water/WaterModifierBase";

const GRAVITY = 32.174; // ft/s²

// Dimensionless tuning: scales flux → ring-wave height.
// Amplitude formula is (flux * dt) / halfWidth² — volume per unit area.
const WAVE_HEIGHT_SCALE = 1.5;

// Destroy once peak amplitude falls below this.
const MIN_VISIBLE_AMPLITUDE = 0.001; // ft

// Viscous damping e-folding time for the coherent ring wave.
const DAMPING_TIME = 0.75; // s

export interface WakeParticleOptions {
  /** Source world position (ft). */
  worldX: number;
  worldY: number;
  /** Volume flux pushed into water (ft³/s) — drives coherent ring amplitude. */
  pushFlux: number;
  /** Source characteristic size (ft) — sets ring Gaussian width. */
  halfWidth: number;
  /** Group speed for ring expansion (ft/s). */
  groupSpeed: number;
  /** Tick duration (s) — volume emitted this tick = flux * dt. */
  dt: number;
}

/**
 * Coherent ring-wave wake particle emitted by a single waterline triangle.
 *
 * The ring represents one tick's slice of the continuous wave field created
 * by the hull pushing water out at this source. Initial amplitude = volume
 * emitted over the tick, spread over the source's characteristic footprint.
 *
 * Physics on the CPU: viscous damping × geometric spreading (1/√r for 2D
 * circular waves). GPU draws a Gaussian ring at the expanding radius.
 *
 * Companion to `FoamParticle`, which carries the turbulent / foam
 * contribution from flow separation.
 */
export class WakeParticle extends WaterModifier {
  tickLayer = "effects" as const;

  private readonly posX: number;
  private readonly posY: number;
  private readonly ringWidth: number;
  private readonly groupSpeed: number;
  private readonly omega: number;
  private readonly initialAmplitude: number;

  private age: number = 0;
  private readonly maxAge: number;

  private readonly aabb: AABB = new AABB();

  constructor(options: WakeParticleOptions) {
    super();
    this.posX = options.worldX;
    this.posY = options.worldY;
    this.ringWidth = options.halfWidth;
    this.groupSpeed = options.groupSpeed;

    // Deep-water dispersion: omega = g / (2 * c_g). Clamp to avoid blowup.
    this.omega = GRAVITY / (2 * Math.max(this.groupSpeed, 0.1));

    // Initial amplitude: volume pushed this tick spread over the source's
    // characteristic footprint (halfWidth²). Speed-invariant — growing
    // flux at higher speeds naturally grows the wake.
    const volume = options.pushFlux * options.dt; // ft³
    this.initialAmplitude =
      (WAVE_HEIGHT_SCALE * volume) / (this.ringWidth * this.ringWidth);

    // Lifespan: kill when damped peak amplitude drops below visible threshold.
    // Peak ~ initial * exp(-t/tau) (ignoring 1/√r spreading for upper bound).
    this.maxAge =
      this.initialAmplitude > MIN_VISIBLE_AMPLITUDE
        ? DAMPING_TIME * Math.log(this.initialAmplitude / MIN_VISIBLE_AMPLITUDE)
        : 0;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    this.age += dt;
    if (this.age >= this.maxAge) this.destroy();
  }

  private getRingRadius(): number {
    return this.groupSpeed * this.age;
  }

  getWaterModifierAABB(): AABB {
    const radius = this.getRingRadius() + this.ringWidth * 3;
    this.aabb.lowerBound.x = this.posX - radius;
    this.aabb.lowerBound.y = this.posY - radius;
    this.aabb.upperBound.x = this.posX + radius;
    this.aabb.upperBound.y = this.posY + radius;
    return this.aabb;
  }

  getGPUModifierData(): GPUWaterModifierData | null {
    if (this.isDestroyed) return null;

    const ringRadius = this.getRingRadius();
    const damping = Math.exp(-this.age / DAMPING_TIME);
    const spreading = ringRadius > 1 ? 1 / Math.sqrt(ringRadius) : 1;

    return {
      type: WaterModifierType.Wake,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Wake,
        posX: this.posX,
        posY: this.posY,
        ringRadius,
        ringWidth: this.ringWidth,
        amplitude: this.initialAmplitude * damping * spreading,
        omega: this.omega,
      },
    };
  }
}
