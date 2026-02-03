/**
 * Query system for sampling world data (terrain, water, wind)
 */
export { BaseQuery } from "./BaseQuery";
export { QueryManager, type ResultLayout } from "./QueryManager";

export {
  isTerrainQuery,
  TerrainQuery,
  TerrainQueryManager,
  type TerrainQueryResult,
  TerrainType,
} from "./TerrainQuery";

export {
  isWaterQuery,
  WaterQuery,
  WaterQueryManager,
  type WaterQueryResult,
} from "./WaterQuery";

export {
  isWindQuery,
  WindQuery,
  WindQueryManager,
  type WindQueryResult,
} from "./WindQuery";
