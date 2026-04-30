import { CpuQueryManager } from "../query/CpuQueryManager";
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
 * Worker-pool terrain query manager.
 *
 * Runs the contour DFS + IDW terrain algorithm inside the CPU worker
 * pool. Skips the grid acceleration structures (containment grid, IDW
 * grid, lookup grid) that the older GPU path used — correctness over
 * peak performance for this first cut.
 */
export class CpuTerrainQueryManager extends CpuQueryManager {
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
