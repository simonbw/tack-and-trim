import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
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

/**
 * Generates synthesized sail luffing/flapping sound driven by the sail's
 * flow simulation state and particle physics.
 *
 * Node graph:
 *   noiseSource → bandpass → flutterGain → outputGain → masterGain
 *
 * - bandpass frequency: inversely proportional to stall fraction (more sail = deeper)
 * - bandpass Q: inversely proportional to turbulence (more turbulent = wider)
 * - flutterGain: driven by lateral particle velocity variance * wind energy
 * - outputGain: scales with hoist amount
 */
export class SailSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  private noiseSource!: AudioBufferSourceNode;
  private bandpass!: BiquadFilterNode;
  private flutterGain!: GainNode;
  private outputGain!: GainNode;

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

    // Compute lateral velocity variance from sail particles.
    // This measures how much the cloth is actually oscillating side-to-side.
    const bodies = this.sail.getBodies();
    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const chord = clew.sub(head);
    const chordLen = chord.magnitude;

    let lateralVariance = 0;
    if (chordLen > 0.001 && bodies.length > 0) {
      const chordNormal = chord.normalize().rotate90cw();
      for (const body of bodies) {
        const lateralSpeed = Math.abs(body.velocity.dot(chordNormal));
        lateralVariance += lateralSpeed * lateralSpeed;
      }
      lateralVariance /= bodies.length;
    }

    // Map simulation state to audio parameters

    // Bandpass frequency: less sail stalled = higher frequency
    const frequency = lerp(MAX_FREQUENCY, MIN_FREQUENCY, stallFraction);

    // Bandpass Q: more turbulence = wider (lower Q)
    const q = lerp(MAX_Q, MIN_Q, clamp(avgTurbulence));

    // Flutter gain: particle motion * wind energy
    // sqrt(variance) gives RMS lateral velocity; scale by wind speed for energy
    const flutterLevel = clamp(
      Math.sqrt(lateralVariance) * avgWindSpeed * 0.02,
      0,
      1,
    );

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
