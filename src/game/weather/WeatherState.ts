/**
 * WeatherState entity — single source of truth for environmental conditions.
 *
 * Owns the inputs that vary across weather (base wind, wave amplitude scale,
 * cloud cover, rain intensity) and the cached lighting outputs derived from
 * `TimeOfDay`. Other systems read from here:
 *   - `pushSceneLighting` reads sun/sky tuples for shader uniforms.
 *   - Wind dispatch reads `getEffectiveWindBase()` for the global wind vector.
 *   - Water shaders read `waveAmplitudeScale` as a per-frame uniform.
 *
 * Lighting math was previously inlined in `TimeOfDay`; it lives here so weather
 * (e.g. cloud cover, future storm tinting) can modulate it without touching the
 * clock. `TimeOfDay` is now a pure clock and is consulted via
 * `tryGetSingleton` each tick.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { V, type V2d } from "../../core/Vector";
import { TimeOfDay } from "../time/TimeOfDay";

/** Default base wind: ~15 ft/s NW breeze, matches prior `WindResources` default. */
const DEFAULT_WIND_BASE_X = 11;
const DEFAULT_WIND_BASE_Y = 11;

/**
 * Configuration for WeatherState.
 */
export interface WeatherStateConfig {
  windBase?: V2d;
  waveAmplitudeScale?: number;
  cloudCover?: number;
  rainIntensity?: number;
}

/**
 * WeatherState singleton entity.
 */
export class WeatherState extends BaseEntity {
  id = "weatherState";
  tickLayer = "environment" as const;

  /** Global wind vector. Magnitude = wind speed (ft/s); direction = wind heading. */
  windBase: V2d;

  /** Multiplier on Gerstner wave amplitude. 1.0 = no change. */
  waveAmplitudeScale: number;

  /** Cloud cover, 0..1. Inert in v1; reserved for sun/sky modulation. */
  cloudCover: number;

  /** Rain intensity, 0..1. Inert in v1; reserved for rain particles. */
  rainIntensity: number;

  /** Reusable scratch vector returned by `getEffectiveWindBase`. */
  private readonly _effectiveWindBase: V2d = V(0, 0);

  // Cached scene-lighting tuples. Getters mutate and return the same tuple
  // each call so the per-frame uniform push is allocation-free.
  private readonly _sunDirection: [number, number, number] = [0, 0, 1];
  private readonly _sunColor: [number, number, number] = [0, 0, 0];
  private readonly _skyColor: [number, number, number] = [0, 0, 0];
  private readonly _horizonSkyColor: [number, number, number] = [0, 0, 0];
  private readonly _ambientLight: [number, number, number] = [0, 0, 0];

  constructor(config: WeatherStateConfig = {}) {
    super();
    this.windBase =
      config.windBase?.clone() ?? V(DEFAULT_WIND_BASE_X, DEFAULT_WIND_BASE_Y);
    this.waveAmplitudeScale = config.waveAmplitudeScale ?? 1.0;
    this.cloudCover = config.cloudCover ?? 0;
    this.rainIntensity = config.rainIntensity ?? 0;
  }

  /**
   * Effective base wind for the dispatch this frame. Today this is just
   * `windBase`; gust modulation can layer on here later without touching
   * consumers.
   *
   * Returns a cached vector — do not store across frames.
   */
  getEffectiveWindBase(): V2d {
    this._effectiveWindBase.set(this.windBase);
    return this._effectiveWindBase;
  }

  /** Convenience: speed of the effective base wind. */
  getWindSpeed(): number {
    return this.windBase.magnitude;
  }

  /** Convenience: angle of the effective base wind in radians. */
  getWindAngle(): number {
    return this.windBase.angle;
  }

  // ============================================================================
  // Scene lighting
  //
  // Migrated from TimeOfDay. Reads `TimeOfDay` via singleton lookup to get the
  // current hour. Falls back to noon if absent (editor / preview contexts).
  // Math is intentionally identical to the original so v1 visuals don't drift.
  // ============================================================================

  /** Hour of day, falling back to noon if no clock is present. */
  private getHourOrNoon(): number {
    const clock = this.game.entities.tryGetSingleton(TimeOfDay);
    return clock ? clock.getHour() : 12;
  }

  /**
   * Raw (unclamped) sun altitude in [-1, 1]: +1 at zenith, 0 at horizon,
   * -1 at nadir. Daytime is altitude > 0, night is altitude < 0.
   */
  getSunAltitude(): number {
    const hour = this.getHourOrNoon();
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
    const hour = this.getHourOrNoon();
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

    const sunVisible = smoothstep(-0.02, 0.08, altitude);
    const warmth = 1.0 - smoothstep(0.0, 0.4, altitude);

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
    const baseR = lerp(0.18, 0.5, dayness);
    const baseG = lerp(0.25, 0.7, dayness);
    const baseB = lerp(0.45, 0.95, dayness);

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
   * Sky color along the horizon — warmer and brighter than the zenith
   * `skyColor` (long atmospheric path concentrates Rayleigh + aerosol
   * scattering toward white-orange).
   *
   * Returns a cached tuple — do not store across frames.
   */
  getHorizonSkyColor(): readonly [number, number, number] {
    const altitude = this.getSunAltitude();

    const dayness = smoothstep(-0.1, 0.25, altitude);
    const baseR = lerp(0.25, 0.78, dayness);
    const baseG = lerp(0.32, 0.82, dayness);
    const baseB = lerp(0.5, 0.92, dayness);

    const twilightBump = Math.exp(-altitude * altitude * 40.0);
    const twilightR = 0.85;
    const twilightG = 0.45;
    const twilightB = 0.25;

    this._horizonSkyColor[0] = baseR + twilightR * twilightBump;
    this._horizonSkyColor[1] = baseG + twilightG * twilightBump;
    this._horizonSkyColor[2] = baseB + twilightB * twilightBump;
    return this._horizonSkyColor;
  }

  /**
   * Combined RGB illumination for objects without a meaningful surface
   * normal (particles, buoys, ropes, etc.).
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
