import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { Game } from "../../../core/Game";
import type { Body } from "../../../core/physics/body/Body";
import { clamp } from "../../../core/util/MathUtil";
import type { Sail } from "./Sail";

// Flap buffer synthesis
const FLAP_DURATIONS = [0.04, 0.06, 0.08];
const FLAP_DECAY_RATE = 50; // Exponential decay speed (higher = snappier)

// Detection: only count a particle if it reversed direction AND
// its per-tick lateral acceleration exceeds this threshold.
const ACCEL_THRESHOLD = 3;
// Sum of qualifying accelerations must exceed this to fire a flap sound.
const TRIGGER_THRESHOLD = 15;
// Minimum time (seconds) between flap sounds.
const MIN_FLAP_INTERVAL = 0.025;

// Playback variation
const BASE_GAIN = 0.4;
const MIN_PLAYBACK_RATE = 0.7;
const MAX_PLAYBACK_RATE = 1.4;

/**
 * Generates sail luffing/flapping sounds by detecting direction reversals
 * in the sail's soft-body particles and triggering one-shot noise bursts.
 *
 * Each flap is a discrete AudioBufferSourceNode — a short burst of noise
 * with a baked-in exponential decay envelope. Playback rate and gain are
 * randomized per event for natural variation.
 */
export class SailSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  private flapBuffers: AudioBuffer[] = [];
  private outputGain!: GainNode;
  private prevLateralVelocities: number[] = [];
  private lastFlapTime: number = 0;
  private audioContext!: AudioContext;

  constructor(private sail: Sail) {
    super();
  }

  @on("add")
  onAdd({ game }: { game: Game }) {
    this.audioContext = game.audio;

    // Synthesize a few flap buffer variations
    for (const duration of FLAP_DURATIONS) {
      this.flapBuffers.push(this.createFlapBuffer(duration));
    }

    // Output gain scales with hoist amount
    this.outputGain = this.audioContext.createGain();
    this.outputGain.gain.value = 0;
    this.outputGain.connect(game.masterGain);

    // Initialize previous velocities
    this.prevLateralVelocities = new Array(
      this.sail.getBodies().length,
    ).fill(0);
  }

  private createFlapBuffer(duration: number): AudioBuffer {
    const sampleRate = this.audioContext.sampleRate;
    const length = Math.ceil(sampleRate * duration);
    const buffer = this.audioContext.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const envelope = Math.exp(-t * FLAP_DECAY_RATE);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }

    return buffer;
  }

  @on("tick")
  onTick({ audioTime }: GameEventMap["tick"]) {
    // Silent when sail is lowered
    this.outputGain.gain.setTargetAtTime(
      this.sail.hoistAmount,
      audioTime,
      0.02,
    );

    const bodies = this.sail.getBodies();
    if (bodies.length === 0) return;

    const head = this.sail.getHeadPosition();
    const clew = this.sail.getClewPosition();
    const chord = clew.sub(head);
    const chordLen = chord.magnitude;
    if (chordLen < 0.001) return;

    const chordNormal = chord.normalize().rotate90cw();

    // Detect flap events: direction reversals with significant acceleration.
    // A flap is when the cloth swings one way, hits tension, and snaps back.
    let snapMagnitude = 0;
    for (let i = 0; i < bodies.length; i++) {
      const body: Body = bodies[i];
      const lateralVelocity = body.velocity.dot(chordNormal);
      const prevVelocity = this.prevLateralVelocities[i] ?? 0;

      const acceleration = Math.abs(lateralVelocity - prevVelocity);
      const signChanged = prevVelocity * lateralVelocity < 0;

      if (signChanged && acceleration > ACCEL_THRESHOLD) {
        snapMagnitude += acceleration;
      }

      this.prevLateralVelocities[i] = lateralVelocity;
    }

    // Fire a flap sound if snap is strong enough and cooldown elapsed
    if (
      snapMagnitude > TRIGGER_THRESHOLD &&
      audioTime - this.lastFlapTime > MIN_FLAP_INTERVAL
    ) {
      const intensity = clamp(
        snapMagnitude / (TRIGGER_THRESHOLD * 4),
        0.2,
        1,
      );
      this.playFlap(audioTime, intensity);
      this.lastFlapTime = audioTime;
    }
  }

  private playFlap(time: number, intensity: number) {
    const buffer =
      this.flapBuffers[Math.floor(Math.random() * this.flapBuffers.length)];

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value =
      MIN_PLAYBACK_RATE +
      Math.random() * (MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE);

    const gain = this.audioContext.createGain();
    gain.gain.value = intensity * BASE_GAIN;

    source.connect(gain);
    gain.connect(this.outputGain);
    source.start(time);

    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
  }

  @on("destroy")
  onDestroy() {
    this.outputGain.disconnect();
  }
}
