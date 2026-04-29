import { CpuQueryManager } from "../query/CpuQueryManager";
import {
  QUERY_TYPE_WATER,
  type QueryTypeId,
} from "../query/query-worker-protocol";
import {
  WATER_PARAM_CONTOUR_COUNT,
  WATER_PARAM_DEFAULT_DEPTH,
  WATER_PARAM_FLOATS_PER_WAVE,
  WATER_PARAM_MAX_WAVES,
  WATER_PARAM_MODIFIER_COUNT,
  WATER_PARAM_NUM_WAVES,
  WATER_PARAM_TIDAL_PHASE,
  WATER_PARAM_TIDAL_STRENGTH,
  WATER_PARAM_TIDE_HEIGHT,
  WATER_PARAM_TIME,
  WATER_PARAM_WAVE_AMPLITUDE_SCALE,
  WATER_PARAM_WAVE_SOURCES_BASE,
} from "../query/water-params";
import { WeatherState } from "../../weather/WeatherState";
import type { BaseQuery } from "../query/BaseQuery";
import { DEFAULT_DEPTH } from "../terrain/TerrainConstants";
import { TerrainResources } from "../terrain/TerrainResources";
import { TidalResources } from "./TidalResources";
import { WaterQuery } from "./WaterQuery";
import { WaterResources } from "./WaterResources";
import { WaterResultLayout } from "./WaterQueryResult";

const MAX_WATER_QUERIES = 2 ** 15;

/**
 * CPU (worker-based) peer of WaterQueryManager. Runs the ported Gerstner
 * wave sum, packed wave mesh lookup, modifier blending, and packed
 * terrain depth sampling on the query worker pool.
 *
 * Limitations this first cut:
 * - Tidal mesh lookup is not ported — tidalPhase / tidalStrength are
 *   passed for parity but the worker treats the flow as zero. `tideHeight`
 *   still modulates surface height identically to the GPU path.
 */
export class CpuWaterQueryManager extends CpuQueryManager {
  id = "waterQueryManager";
  tickLayer = "query" as const;

  queryType: QueryTypeId = QUERY_TYPE_WATER;

  constructor() {
    super(WaterResultLayout, MAX_WATER_QUERIES);
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(WaterQuery)];
  }

  writeParamsToSab(params: Float32Array): void {
    const waterResources = this.game.entities.getSingleton(WaterResources);
    const terrainResources = this.game.entities.getSingleton(TerrainResources);
    const tidalResources = this.game.entities.tryGetSingleton(TidalResources);

    params[WATER_PARAM_TIME] = performance.now() / 1000;
    params[WATER_PARAM_TIDE_HEIGHT] = waterResources.getTideHeight();
    params[WATER_PARAM_DEFAULT_DEPTH] = DEFAULT_DEPTH;
    params[WATER_PARAM_NUM_WAVES] = waterResources.getNumWaves();
    params[WATER_PARAM_TIDAL_PHASE] = tidalResources?.getTidalPhase() ?? 0;
    params[WATER_PARAM_TIDAL_STRENGTH] =
      tidalResources?.getTidalStrength() ?? 0;
    params[WATER_PARAM_CONTOUR_COUNT] = terrainResources.getContourCount();
    params[WATER_PARAM_MODIFIER_COUNT] = waterResources.getModifierCount();
    const weather = this.game.entities.tryGetSingleton(WeatherState);
    params[WATER_PARAM_WAVE_AMPLITUDE_SCALE] = weather?.waveAmplitudeScale ?? 1;

    // Wave sources inline in the params SAB (8 floats per source, up to
    // WATER_PARAM_MAX_WAVES). Copy only the populated slots; the rest
    // stay zero from earlier writes / initialization, which is harmless
    // because `numWaves` bounds the wave-sum loop.
    const waveSourceData = waterResources.getWaveSourceData();
    const maxInline = WATER_PARAM_MAX_WAVES * WATER_PARAM_FLOATS_PER_WAVE;
    const copyLen = Math.min(waveSourceData.length, maxInline);
    params.set(
      waveSourceData.subarray(0, copyLen),
      WATER_PARAM_WAVE_SOURCES_BASE,
    );
  }
}
