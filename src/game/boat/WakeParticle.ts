import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { AABB } from "../../core/physics/collision/AABB";
import { rNormal } from "../../core/util/Random";
import { V2d } from "../../core/Vector";
import {
  GPUWaterModifierData,
  WaterModifier,
  WaterModifierType,
} from "../world/water/WaterModifierBase";

// Physical constants
const GRAVITY = 32.174; // ft/s^2
// Hull speed Froude number: Fr where hull wavelength (2πv²/g) equals waterline length.
const HULL_SPEED_FROUDE = 1 / Math.sqrt(2 * Math.PI);

// How much of the boat's displacement energy goes into wake wave height.
const WAVE_HEIGHT_SCALE = 0.25; // dimensionless, tweak for visual strength

// Ring pulse width — how sharp the ring is in the radial direction.
const RING_WIDTH = 1.5; // ft

// Expansion speed: ring expands at half boat speed (hull wavelength group velocity).
// This gives the correct Kelvin wake V-angle.
const GROUP_SPEED_FRACTION = 0.5;

const MIN_VISIBLE_AMPLITUDE = 0.001; // ft — destroy when peak amplitude drops below this

// Viscous damping time constant.
const DAMPING_TIME = 0.75; // seconds — e-folding time for amplitude decay

/**
 * A wake particle that acts as a point-source expanding ring pulse.
 *
 * Each particle is spawned at the boat's stern and expands outward as a ring.
 * All physics (amplitude, spreading, damping) is computed on the CPU.
 * The GPU receives only: position, ring radius, ring width, amplitude, turbulence.
 */
export class WakeParticle extends WaterModifier {
  tickLayer = "effects" as const;

  private posX: number;
  private posY: number;

  private readonly aabb: AABB = new AABB();

  private age: number = 0;
  private maxAge: number;
  private readonly groupSpeed: number;
  private readonly initialAmplitude: number; // ft — wave height at 1 ft from source
  private readonly turbulence: number; // 0-1 foam/whitecap intensity

  constructor(
    position: V2d,
    speed: number,
    waterlineLength: number,
    beam: number,
    spawnSpacing: number,
    amplitudeScale: number = 1,
  ) {
    super();
    this.posX = position.x;
    this.posY = position.y;

    // Ring expansion speed: half boat speed (group velocity of hull wavelength).
    // Add some random variation so rings don't all expand at exactly the same rate.
    this.groupSpeed = speed * GROUP_SPEED_FRACTION * rNormal(1.0, 0.1);

    // Froude number: dimensionless speed relative to hull length.
    const froudeNumber = speed / Math.sqrt(GRAVITY * waterlineLength);

    // Wave-making energy: grows as Fr² below hull speed, then saturates smoothly.
    const froudeFactor = Math.tanh(froudeNumber / HULL_SPEED_FROUDE);
    const totalWakeAmplitude =
      WAVE_HEIGHT_SCALE * beam * froudeFactor * froudeFactor;

    // Per-particle amplitude: scaled by spawn spacing relative to ring width.
    // When many particles overlap within one ring width, they reconstruct
    // the total amplitude. sqrt(ds / ringWidth) normalizes for overlap count.
    this.initialAmplitude =
      totalWakeAmplitude *
      Math.sqrt(spawnSpacing / RING_WIDTH) *
      amplitudeScale;

    // Turbulence (foam) scales with wave-making energy
    this.turbulence = froudeFactor * froudeFactor;

    // Max age: when peak amplitude drops below visible threshold.
    // Peak amplitude at ring front: A₀/sqrt(r) * exp(-t/τ), where r = groupSpeed*t.
    // Use damping alone for conservative estimate.
    this.maxAge =
      this.initialAmplitude > MIN_VISIBLE_AMPLITUDE
        ? DAMPING_TIME * Math.log(this.initialAmplitude / MIN_VISIBLE_AMPLITUDE)
        : 0;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    this.age += dt;

    if (this.age >= this.maxAge) {
      this.destroy();
    }
  }

  // WaterModifier implementation

  private getRingRadius(): number {
    return this.groupSpeed * this.age;
  }

  private getOuterRadius(): number {
    return this.getRingRadius() + RING_WIDTH * 3;
  }

  getWaterModifierAABB(): AABB {
    const radius = this.getOuterRadius();
    this.aabb.lowerBound.x = this.posX - radius;
    this.aabb.lowerBound.y = this.posY - radius;
    this.aabb.upperBound.x = this.posX + radius;
    this.aabb.upperBound.y = this.posY + radius;
    return this.aabb;
  }

  getGPUModifierData(): GPUWaterModifierData | null {
    if (this.isDestroyed) return null;

    const ringRadius = this.getRingRadius();

    // Viscous damping
    const damping = Math.exp(-this.age / DAMPING_TIME);

    // Geometric spreading: 1/sqrt(r) for 2D circular waves
    const spreading = ringRadius > 1 ? 1 / Math.sqrt(ringRadius) : 1;

    // Final amplitude at the ring, fully computed on CPU
    const amplitude = this.initialAmplitude * damping * spreading;

    return {
      type: WaterModifierType.Wake,
      bounds: this.getWaterModifierAABB(),
      data: {
        type: WaterModifierType.Wake,
        posX: this.posX,
        posY: this.posY,
        ringRadius,
        ringWidth: RING_WIDTH,
        amplitude,
        turbulence: this.turbulence * damping * spreading,
      },
    };
  }
}
