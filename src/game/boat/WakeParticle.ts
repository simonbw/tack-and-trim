import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/physics/collision/AABB";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "../world/water/WaterModifierBase";

const GRAVITY = 32.174; // ft/s^2

// Dimensionless tuning: scales flux → ring-wave height.
// Amplitude formula is (flux * dt) / halfWidth² — volume per unit area.
const WAVE_HEIGHT_SCALE = 1.5;

// Dimensionless tuning: scales suction flux → turbulence/foam intensity.
// Turbulence formula is suckFlux / (halfWidth * groupSpeed) — dimensionless.
const TURBULENCE_SCALE = 0.6;

// Destroy once peak amplitude falls below this.
const MIN_VISIBLE_AMPLITUDE = 0.001; // ft

// Viscous damping e-folding time.
const DAMPING_TIME = 0.75; // s

export interface WakeParticleOptions {
  /** Source world position (ft). */
  worldX: number;
  worldY: number;
  /** Volume flux pushed into water (ft³/s) — drives coherent ring amplitude. */
  pushFlux: number;
  /** Volume flux sucked from wake (ft³/s) — drives turbulence/foam. */
  suckFlux: number;
  /** Source characteristic size (ft) — sets ring Gaussian width. */
  halfWidth: number;
  /** Group speed for ring expansion (ft/s). */
  groupSpeed: number;
  /** Tick duration (s) — volume emitted this tick = flux * dt. */
  dt: number;
}

/**
 * A wake particle spawned by a single waterline triangle.
 *
 * Represents an expanding ring pulse whose initial amplitude is set by the
 * volume flux of water displaced at the source over one tick. Coherent wave
 * height comes from `pushFlux` (hull pushing into water), turbulence / foam
 * from `suckFlux` (flow separation in the wake).
 *
 * Physics on the CPU: viscous damping × geometric spreading (1/√r for 2D
 * circular waves). GPU just draws a Gaussian ring at the expanding radius.
 */
export class WakeParticle extends WaterModifier {
  tickLayer = "effects" as const;

  private readonly posX: number;
  private readonly posY: number;
  private readonly ringWidth: number;
  private readonly groupSpeed: number;
  private readonly omega: number; // rad/s, angular frequency of the wake wave
  private readonly initialAmplitude: number; // ft
  private readonly initialTurbulence: number; // 0..1

  private age: number = 0;
  private readonly maxAge: number;

  private readonly aabb: AABB = new AABB();

  constructor(options: WakeParticleOptions) {
    super();
    this.posX = options.worldX;
    this.posY = options.worldY;
    this.ringWidth = options.halfWidth;
    this.groupSpeed = options.groupSpeed;

    // Deep-water dispersion: omega = g / (2 * c_g). Clamp c_g to avoid blowup.
    this.omega = GRAVITY / (2 * Math.max(this.groupSpeed, 0.1));

    // Initial amplitude from volume flux. Physical model: the ring represents
    // one tick's worth of water pushed out (pushFlux * dt, ft³) spread over
    // the source's characteristic footprint (halfWidth², ft²). Result is a
    // ring height in ft. Speed-invariant — growing flux at higher speeds
    // naturally grows the wake.
    const volume = options.pushFlux * options.dt; // ft³
    this.initialAmplitude =
      (WAVE_HEIGHT_SCALE * volume) / (this.ringWidth * this.ringWidth);

    // Turbulence from suction flux. Dimensionless: flux / (L * v) where L is
    // source width and v is group speed. Scales with how much water is being
    // yanked into the separation wake relative to the characteristic size.
    this.initialTurbulence = Math.min(
      1,
      (TURBULENCE_SCALE * options.suckFlux) /
        (this.ringWidth * Math.max(this.groupSpeed, 0.1)),
    );

    // Lifespan: kill when damped peak amplitude drops below visible threshold.
    // Peak ~ initial * exp(-t/tau) (ignoring 1/√r spreading for upper bound).
    const startingPeak = Math.max(
      this.initialAmplitude,
      this.initialTurbulence * 0.01,
    );
    this.maxAge =
      startingPeak > MIN_VISIBLE_AMPLITUDE
        ? DAMPING_TIME * Math.log(startingPeak / MIN_VISIBLE_AMPLITUDE)
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
    const decay = damping * spreading;

    return {
      type: WaterModifierType.Wake,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Wake,
        posX: this.posX,
        posY: this.posY,
        ringRadius,
        ringWidth: this.ringWidth,
        amplitude: this.initialAmplitude * decay,
        turbulence: this.initialTurbulence * decay,
        omega: this.omega,
      },
    };
  }
}
