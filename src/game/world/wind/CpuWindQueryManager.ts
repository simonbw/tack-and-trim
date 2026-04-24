import { CpuQueryManager } from "../query/CpuQueryManager";
import {
  QUERY_TYPE_WIND,
  type QueryTypeId,
} from "../query/query-worker-protocol";
import {
  WIND_PARAM_BASE_X,
  WIND_PARAM_BASE_Y,
  WIND_PARAM_INFLUENCE_DIRECTION_OFFSET,
  WIND_PARAM_INFLUENCE_SPEED_FACTOR,
  WIND_PARAM_INFLUENCE_TURBULENCE,
  WIND_PARAM_TIME,
  WIND_PARAM_WEIGHTS_BASE,
  WIND_PARAM_WEIGHTS_COUNT,
} from "../query/wind-params";
import type { BaseQuery } from "../query/BaseQuery";
import { WindQuery } from "./WindQuery";
import { WindResultLayout } from "./WindQueryResult";
import { WindResources } from "./WindResources";

const MAX_WIND_QUERIES = 2 ** 15;

/**
 * CPU (worker-based) peer of WindQueryManager. Runs wind noise math +
 * packed wind mesh lookup + source-weight blending on the query worker
 * pool instead of the GPU.
 */
export class CpuWindQueryManager extends CpuQueryManager {
  id = "windQueryManager";
  tickLayer = "query" as const;

  queryType: QueryTypeId = QUERY_TYPE_WIND;

  constructor() {
    super(WindResultLayout, MAX_WIND_QUERIES);
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(WindQuery)];
  }

  writeParamsToSab(params: Float32Array): void {
    const windResources = this.game.entities.getSingleton(WindResources);
    const baseWind = windResources.getBaseVelocity();
    const weights = windResources.getSourceWeights();

    params[WIND_PARAM_TIME] = performance.now() / 1000;
    params[WIND_PARAM_BASE_X] = baseWind.x;
    params[WIND_PARAM_BASE_Y] = baseWind.y;
    // Fallback values when the mesh lookup misses — match the current
    // GPU path's neutral defaults.
    params[WIND_PARAM_INFLUENCE_SPEED_FACTOR] = 1.0;
    params[WIND_PARAM_INFLUENCE_DIRECTION_OFFSET] = 0.0;
    params[WIND_PARAM_INFLUENCE_TURBULENCE] = 0.0;

    for (let i = 0; i < WIND_PARAM_WEIGHTS_COUNT; i++) {
      params[WIND_PARAM_WEIGHTS_BASE + i] = weights[i] ?? 0;
    }
  }
}
