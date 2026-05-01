import { QueryWorkerManager } from "../query/QueryWorkerManager";
import {
  QUERY_TYPE_TERRAIN,
  type QueryTypeId,
} from "../query/query-worker-protocol";
import {
  TERRAIN_PARAM_CONTOUR_COUNT,
  TERRAIN_PARAM_DEFAULT_DEPTH,
} from "../query/terrain-params";
import type { BaseQuery } from "../query/BaseQuery";
import { DEFAULT_DEPTH } from "./TerrainConstants";
import { TerrainQuery } from "./TerrainQuery";
import { TerrainResultLayout } from "./TerrainQueryResult";
import { TerrainResources } from "./TerrainResources";

const MAX_TERRAIN_QUERIES = 2 ** 15;

/**
 * Worker-pool terrain query manager. Runs the contour DFS + IDW
 * terrain algorithm inside the query worker pool.
 */
export class TerrainQueryManager extends QueryWorkerManager {
  id = "terrainQueryManager";
  tickLayer = "query" as const;

  queryType: QueryTypeId = QUERY_TYPE_TERRAIN;

  constructor() {
    super(TerrainResultLayout, MAX_TERRAIN_QUERIES);
  }

  getQueries(): BaseQuery<unknown>[] {
    return [...this.game.entities.byConstructor(TerrainQuery)];
  }

  writeParamsToSab(params: Float32Array): void {
    const terrainResources = this.game.entities.getSingleton(TerrainResources);
    params[TERRAIN_PARAM_CONTOUR_COUNT] = terrainResources.getContourCount();
    params[TERRAIN_PARAM_DEFAULT_DEPTH] = DEFAULT_DEPTH;
  }
}
