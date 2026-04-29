import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { BaseEntity } from "../../core/entity/BaseEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import { WeatherState, type WeatherStateConfig } from "./WeatherState";

/**
 * Maximum deviation from the baseline value for each modulated weather field.
 * Each field stays in [0, 1] after the deviation is clamped.
 */
export interface WeatherVariability {
  cloudCoverRange?: number;
  rainIntensityRange?: number;
  gustinessRange?: number;
}

/** Weather drifts on the order of 5 minutes (1 / SLOW seconds per noise cycle). */
const SLOW = 1 / 300;

export class WeatherDirector extends BaseEntity {
  id = "weatherDirector";
  tickLayer = "environment" as const;

  private readonly baselineCloudCover: number;
  private readonly baselineRainIntensity: number;
  private readonly baselineGustiness: number;
  private readonly variability: WeatherVariability;
  private readonly cloudNoise: NoiseFunction2D = createNoise2D();
  private readonly rainNoise: NoiseFunction2D = createNoise2D();
  private readonly gustNoise: NoiseFunction2D = createNoise2D();
  private elapsed = 0;

  constructor(baseline: WeatherStateConfig, variability: WeatherVariability) {
    super();
    this.baselineCloudCover = baseline.cloudCover ?? 0;
    this.baselineRainIntensity = baseline.rainIntensity ?? 0;
    this.baselineGustiness = baseline.gustiness ?? 0;
    this.variability = variability;
  }

  private isInert(): boolean {
    return (
      !this.variability.cloudCoverRange &&
      !this.variability.rainIntensityRange &&
      !this.variability.gustinessRange
    );
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    if (this.isInert()) return;
    const weather = this.game.entities.tryGetSingleton(WeatherState);
    if (!weather) return;

    this.elapsed += dt;
    const t = this.elapsed * SLOW;

    const cloudRange = this.variability.cloudCoverRange ?? 0;
    if (cloudRange > 0) {
      weather.cloudCover = clamp(
        this.baselineCloudCover + cloudRange * this.cloudNoise(t, 11.0),
      );
    }

    const rainRange = this.variability.rainIntensityRange ?? 0;
    if (rainRange > 0) {
      weather.rainIntensity = clamp(
        this.baselineRainIntensity + rainRange * this.rainNoise(t, 23.0),
      );
    }

    const gustRange = this.variability.gustinessRange ?? 0;
    if (gustRange > 0) {
      weather.gustiness = clamp(
        this.baselineGustiness + gustRange * this.gustNoise(t, 41.0),
      );
    }
  }
}
