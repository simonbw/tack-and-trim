import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import type { Body } from "../../../core/physics/body/Body";
import { createNoiseBuffer } from "../../../core/sound/NoiseBuffer";
import { clamp, lerp } from "../../../core/util/MathUtil";
import type { Sail } from "./Sail";

// Audio parameter smoothing time constant (seconds)
const SMOOTHING = 0.02;

// Bandpass filter frequency range (Hz)
const MIN_FREQUENCY = 200; // Full sail flogging - deep
const MAX_FREQUENCY = 800; // Small luff at leading edge - higher

// Bandpass Q range
const MIN_Q = 1; // Wide/noisy (chaotic flogging)
const MAX_Q = 8; // Narrower (clean flutter)

// Spike/decay envelope parameters
const ENERGY_DECAY = 0.88; // Per-tick multiplier (~7ms half-life at 120Hz)
const ENERGY_INJECTION = 0.15; // How much energy each snap event adds
const ENERGY_GAIN_SCALE = 0.5; // Scale factor from energy to gain

/**
 * Generates synthesized sail luffing/flapping sound driven by the sail's
 * flow simulation state and particle physics.
 *
 * Uses a spike/decay energy model: tracks lateral acceleration of sail
 * particles to detect direction reversals (flap events), which inject
 * energy into a decaying envelope. This produces discrete flap sounds
 * rather than a continuous drone.
 *
 * Node graph:
 *   noiseSource → bandpass → flutterGain → outputGain → masterGain
 */
export class SailSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  private noiseSource!: AudioBufferSourceNode;
  private bandpass!: BiquadFilterNode;
  private flutterGain!: GainNode;
  private outputGain!: GainNode;

  // Previous tick's lateral velocities for acceleration detection
  private prevLateralVelocities: number[] = [];
  // Decaying energy envelope driven by flap events
  private energy: number = 0;

  constructor(private sail: Sail) {
    super();
  }

  @on("add")
  onAdd({ game }: { game: Game }) {
    const ctx = game.audio;

    // Create and start looping noise source
    const noiseBuffer = createNoiseBuffer(ctx);
    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;
    this.noiseSource.start();

    // Bandpass filter shapes the noise character
    this.bandpass = ctx.createBiquadFilter();
    this.bandpass.type = "bandpass";
    this.bandpass.frequency.value = MAX_FREQUENCY;
    this.bandpass.Q.value = MAX_Q;

    // Flutter gain is the per-tick amplitude envelope
    this.flutterGain = ctx.createGain();
    this.flutterGain.gain.value = 0;

    // Output gain scales with hoist amount
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 0;

    // Wire the chain
    this.noiseSource.connect(this.bandpass);
    this.bandpass.connect(this.flutterGain);
    this.flutterGain.connect(this.outputGain);
    this.outputGain.connect(game.masterGain);

    // Initialize previous velocities array
    this.prevLateralVelocities = new Array(this.sail.getBodies().length).fill(0);
  }

  @on("tick")
  onTick({ audioTime }: GameEventMap["tick"]) {
    const segments = this.sail.getFlowStates();
    if (segments.length === 0) return;

    // Aggregate flow state across all segments
    let turbulenceSum = 0;
    let detachedCount = 0;
    let windSpeedSum = 0;

    for (const segment of segments) {
      turbulenceSum += segment.flow.turbulence;
      if (!segment.flow.attached) detachedCount++;
      windSpeedSum += segment.flow.speed;
    }

    const segmentCount = segments.length;
    const avgTurbulence = turbulenceSum / segmentCount;
    const stallFraction = detachedCount / segmentCount;
    const avgWindSpeed = windSpeedSum / segmentCount;

    // Compute lateral accelerations to detect flap events.
    // A flap is a direction reversal: the cloth swings one way, hits tension,
    // and snaps back. This shows up as a spike in lateral acceleration.
    const bodies = this.sail.getBodies();
    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const chord = clew.sub(head);
    const chordLen = chord.magnitude;

    let snapEnergy = 0;
    if (chordLen > 0.001 && bodies.length > 0) {
      const chordNormal = chord.normalize().rotate90cw();

      for (let i = 0; i < bodies.length; i++) {
        const body: Body = bodies[i];
        const lateralVelocity = body.velocity.dot(chordNormal);
        const prevVelocity = this.prevLateralVelocities[i] ?? 0;

        // Lateral acceleration magnitude (velocity change since last tick)
        const acceleration = Math.abs(lateralVelocity - prevVelocity);
        snapEnergy += acceleration;

        this.prevLateralVelocities[i] = lateralVelocity;
      }
    }

    // Scale snap energy by wind speed -- more wind = louder snaps
    snapEnergy *= avgWindSpeed;

    // Update decaying energy envelope
    this.energy = this.energy * ENERGY_DECAY + snapEnergy * ENERGY_INJECTION;

    // Map simulation state to audio parameters

    // Bandpass frequency: less sail stalled = higher frequency
    const frequency = lerp(MAX_FREQUENCY, MIN_FREQUENCY, stallFraction);

    // Bandpass Q: more turbulence = wider (lower Q)
    const q = lerp(MAX_Q, MIN_Q, clamp(avgTurbulence));

    // Flutter gain: driven by the spike/decay energy envelope
    const flutterLevel = clamp(this.energy * ENERGY_GAIN_SCALE, 0, 1);

    // Output gain: silent when sail is lowered
    const outputLevel = this.sail.hoistAmount;

    // Schedule smooth parameter transitions
    this.bandpass.frequency.setTargetAtTime(frequency, audioTime, SMOOTHING);
    this.bandpass.Q.setTargetAtTime(q, audioTime, SMOOTHING);
    this.flutterGain.gain.setTargetAtTime(flutterLevel, audioTime, SMOOTHING);
    this.outputGain.gain.setTargetAtTime(outputLevel, audioTime, SMOOTHING);
  }

  @on("destroy")
  onDestroy() {
    this.noiseSource.stop();
    this.noiseSource.disconnect();
    this.bandpass.disconnect();
    this.flutterGain.disconnect();
    this.outputGain.disconnect();
  }
}
