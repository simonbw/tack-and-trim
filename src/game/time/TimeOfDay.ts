/**
 * TimeOfDay entity - tracks game-world time separately from real elapsed time.
 *
 * Singleton entity that provides the source of truth for game-world time.
 * Used for time-dependent effects like tides.
 *
 * Default: 1 real second = 1 game minute (60x time scale),
 * so a full 24-hour cycle = 24 real minutes.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";

/** Seconds in a day */
const SECONDS_PER_DAY = 86400;

/** Seconds per hour */
const SECONDS_PER_HOUR = 3600;

/** Default time scale: game-world seconds per real second (1 = real-time) */
const DEFAULT_TIME_SCALE = 1;

/** Default starting hour (noon) */
const DEFAULT_STARTING_HOUR = 12;

/**
 * Configuration for TimeOfDay entity.
 */
export interface TimeOfDayConfig {
  /** Starting hour (0-24), default: 12 (noon) */
  startingHour?: number;
  /** Game-world seconds per real second, default: 60 */
  timeScale?: number;
}

/**
 * TimeOfDay singleton entity.
 *
 * Tracks game-world time and provides query methods for time-dependent systems,
 * including scene-lighting derived values (sun direction, sun color, sky color)
 * that every lighting-aware shader consumes via its uniform buffer.
 */
export class TimeOfDay extends BaseEntity {
  id = "timeOfDay";
  tickLayer = "environment" as const;

  /** Current time in seconds since midnight (0-86400) */
  private timeInSeconds: number;

  /** Time scale: game-world seconds per real second */
  private timeScale: number;

  // Cached scene-lighting tuples. Getters mutate and return the same tuple
  // each call so the per-frame uniform push is allocation-free.
  private readonly _sunDirection: [number, number, number] = [0, 0, 1];
  private readonly _sunColor: [number, number, number] = [0, 0, 0];
  private readonly _skyColor: [number, number, number] = [0, 0, 0];
  private readonly _ambientLight: [number, number, number] = [0, 0, 0];

  constructor(config: TimeOfDayConfig = {}) {
    super();

    const startingHour = config.startingHour ?? DEFAULT_STARTING_HOUR;
    this.timeInSeconds = startingHour * SECONDS_PER_HOUR;
    this.timeScale = config.timeScale ?? DEFAULT_TIME_SCALE;
  }

  /**
   * Advance time each tick.
   */
  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    if (this.game.io.isKeyDown("Period")) {
      this.timeInSeconds += dt * this.timeScale * 5000;
    } else {
      this.timeInSeconds += dt * this.timeScale;
    }

    // Wrap at 24 hours
    while (this.timeInSeconds >= SECONDS_PER_DAY) {
      this.timeInSeconds -= SECONDS_PER_DAY;
    }
    while (this.timeInSeconds < 0) {
      this.timeInSeconds += SECONDS_PER_DAY;
    }
  }

  /**
   * Get the current hour (0-24, can be fractional).
   */
  getHour(): number {
    return this.timeInSeconds / SECONDS_PER_HOUR;
  }

  /**
   * Get the current time in seconds since midnight.
   */
  getTimeInSeconds(): number {
    return this.timeInSeconds;
  }

  /**
   * Set the time scale (game-world seconds per real second).
   */
  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  /**
   * Get the current time scale.
   */
  getTimeScale(): number {
    return this.timeScale;
  }

  /**
   * Jump to a specific hour (0-24).
   */
  setHour(hour: number): void {
    this.timeInSeconds = hour * SECONDS_PER_HOUR;

    // Normalize to valid range
    while (this.timeInSeconds >= SECONDS_PER_DAY) {
      this.timeInSeconds -= SECONDS_PER_DAY;
    }
    while (this.timeInSeconds < 0) {
      this.timeInSeconds += SECONDS_PER_DAY;
    }
  }

  // ============================================================================
  // Scene lighting
  //
  // CPU port of what was previously in scene-lighting.wgsl.ts. Computed once per
  // frame on the CPU; shaders receive the results as uniform vec3s instead of
  // recomputing per-pixel. Altitude math and color ramps are intentionally
  // identical to the original WGSL so visuals don't drift.
  // ============================================================================

  /**
   * Raw (unclamped) sun altitude in [-1, 1]: +1 at zenith, 0 at horizon,
   * -1 at nadir. Daytime is altitude > 0, night is altitude < 0.
   */
  getSunAltitude(): number {
    const hour = this.timeInSeconds / SECONDS_PER_HOUR;
    const sunPhase = ((hour - 6.0) * Math.PI) / 12.0; // 6am..6pm → 0..π
    return Math.sin(sunPhase);
  }

  /**
   * Normalized unit vector pointing toward the sun.
   * X: south/north, Y: east/west, Z: up/down. Sun rises east, sets west.
   *
   * Returns a cached tuple — do not store across frames.
   */
  getSunDirection(): readonly [number, number, number] {
    const hour = this.timeInSeconds / SECONDS_PER_HOUR;
    const sunElevation = Math.max(this.getSunAltitude(), 0);
    const azimuth = ((hour - 12.0) * Math.PI) / 6.0; // noon = 0, sweeps east to west

    const x = Math.cos(azimuth) * 0.3 + 0.3;
    const y = Math.sin(azimuth) * 0.2 + 0.2;
    const z = sunElevation * 0.9 + 0.1;
    const len = Math.sqrt(x * x + y * y + z * z);

    this._sunDirection[0] = x / len;
    this._sunDirection[1] = y / len;
    this._sunDirection[2] = z / len;
    return this._sunDirection;
  }

  /**
   * Direct sunlight color. (0,0,0) when the sun is below the horizon — no
   * direct sunlight at night. Warm orange near the horizon (atmospheric
   * scattering) transitioning to near-white at zenith.
   *
   * Returns a cached tuple — do not store across frames.
   */
  getSunColor(): readonly [number, number, number] {
    const altitude = this.getSunAltitude();

    // Sun visibility ramps in as the sun clears the horizon.
    const sunVisible = smoothstep(-0.02, 0.08, altitude);
    // Warmth: high near horizon (long atmospheric path), cool overhead.
    const warmth = 1.0 - smoothstep(0.0, 0.4, altitude);

    // mix(whiteColor, warmColor, warmth) * sunVisible
    const r = lerp(1.0, 1.0, warmth) * sunVisible;
    const g = lerp(0.95, 0.55, warmth) * sunVisible;
    const b = lerp(0.85, 0.25, warmth) * sunVisible;

    this._sunColor[0] = r;
    this._sunColor[1] = g;
    this._sunColor[2] = b;
    return this._sunColor;
  }

  /**
   * Sky color — deep blue-black at night (full-moon-lit), bright blue at day,
   * with a warm twilight bump near the horizon.
   *
   * Returns a cached tuple — do not store across frames.
   */
  getSkyColor(): readonly [number, number, number] {
    const altitude = this.getSunAltitude();

    const dayness = smoothstep(-0.1, 0.25, altitude);
    // Night base: muted cool blue tuned for a full-moon night after LDR tone
    // mapping. For a moonless night drop to (0.01, 0.02, 0.05).
    const baseR = lerp(0.06, 0.5, dayness);
    const baseG = lerp(0.09, 0.7, dayness);
    const baseB = lerp(0.16, 0.95, dayness);

    // Twilight glow: Gaussian bump centered at the horizon.
    const twilightBump = Math.exp(-altitude * altitude * 40.0);
    const twilightR = 0.55;
    const twilightG = 0.28;
    const twilightB = 0.25;

    this._skyColor[0] = baseR + twilightR * twilightBump * 0.35;
    this._skyColor[1] = baseG + twilightG * twilightBump * 0.35;
    this._skyColor[2] = baseB + twilightB * twilightBump * 0.35;
    return this._skyColor;
  }

  /**
   * Combined RGB illumination for objects without a meaningful surface
   * normal (particles, buoys, ropes, etc.). Mirrors the shader-side
   * `skyColor * ambient + sunColor * diffuse` model with diffuse=1, so
   * these objects pick up the same cool-blue floor at night and warm
   * directional brightness during the day as lit surfaces.
   *
   * Returns a cached tuple — do not store across frames.
   */
  getAmbientLight(): readonly [number, number, number] {
    const sun = this.getSunColor();
    const sky = this.getSkyColor();
    const AMBIENT = 0.5;
    this._ambientLight[0] = sky[0] * AMBIENT + sun[0];
    this._ambientLight[1] = sky[1] * AMBIENT + sun[1];
    this._ambientLight[2] = sky[2] * AMBIENT + sun[2];
    return this._ambientLight;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
