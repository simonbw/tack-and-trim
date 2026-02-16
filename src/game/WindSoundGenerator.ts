import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { Game } from "../core/Game";
import { createNoiseBuffer } from "../core/sound/NoiseBuffer";
import { clamp, lerp } from "../core/util/MathUtil";
import { WindQuery } from "./world/wind/WindQuery";

// Audio parameter smoothing time constant (seconds)
const SMOOTHING = 0.05;

// Wind speed range for mapping to audio parameters (ft/s)
const MIN_WIND_SPEED = 2; // Below this, wind is inaudible
const MAX_WIND_SPEED = 25; // Above this, wind sound is maxed out

// Lowpass filter frequency range (Hz)
const MIN_FREQUENCY = 200; // Light breeze - low rumble
const MAX_FREQUENCY = 1200; // Strong wind - more hiss

// Volume
const MAX_GAIN = 0.15;

/**
 * Generates ambient wind sound driven by the local wind speed.
 *
 * Queries wind at the camera position and maps wind speed to
 * a filtered noise source. Simplex noise variation in the wind
 * field naturally produces realistic gust swelling.
 *
 * Node graph:
 *   noiseSource → lowpass → outputGain → masterGain
 */
export class WindSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  private noiseSource!: AudioBufferSourceNode;
  private lowpass!: BiquadFilterNode;
  private outputGain!: GainNode;
  private windQuery!: WindQuery;

  @on("add")
  onAdd({ game }: { game: Game }) {
    const ctx = game.audio;

    // Create wind query at camera position
    this.windQuery = this.addChild(
      new WindQuery(() => [game.camera.getPosition()]),
    );

    // Create and start looping noise source
    const noiseBuffer = createNoiseBuffer(ctx);
    this.noiseSource = ctx.createBufferSource();
    this.noiseSource.buffer = noiseBuffer;
    this.noiseSource.loop = true;
    this.noiseSource.start();

    // Lowpass filter shapes the wind character
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = "lowpass";
    this.lowpass.frequency.value = MIN_FREQUENCY;
    this.lowpass.Q.value = 0.7; // Butterworth - smooth rolloff

    // Output gain
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 0;

    // Wire the chain
    this.noiseSource.connect(this.lowpass);
    this.lowpass.connect(this.outputGain);
    this.outputGain.connect(game.masterGain);
  }

  @on("tick")
  onTick({ audioTime }: GameEventMap["tick"]) {
    // Wind query results have one-frame latency; skip until data is available.
    if (this.windQuery.length === 0) return;

    const wind = this.windQuery.get(0);

    const speed = wind.speed;
    if (!Number.isFinite(speed)) {
      this.lowpass.frequency.setTargetAtTime(
        MIN_FREQUENCY,
        audioTime,
        SMOOTHING,
      );
      this.outputGain.gain.setTargetAtTime(0, audioTime, SMOOTHING);
      return;
    }

    // Normalize wind speed to 0-1 range
    const t = clamp(
      (speed - MIN_WIND_SPEED) / (MAX_WIND_SPEED - MIN_WIND_SPEED),
    );

    // Map to audio parameters
    const frequency = lerp(MIN_FREQUENCY, MAX_FREQUENCY, t);
    const gain = t * t * MAX_GAIN; // Quadratic curve - quiet at low speeds

    // Schedule smooth parameter transitions
    this.lowpass.frequency.setTargetAtTime(frequency, audioTime, SMOOTHING);
    this.outputGain.gain.setTargetAtTime(gain, audioTime, SMOOTHING);
  }

  @on("destroy")
  onDestroy() {
    this.noiseSource.stop();
    this.noiseSource.disconnect();
    this.lowpass.disconnect();
    this.outputGain.disconnect();
  }
}
