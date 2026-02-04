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
} from "../terrain/TerrainQuery";

export {
  isWaterQuery,
  WaterQuery,
  WaterQueryManager,
  type WaterQueryResult,
} from "../water/WaterQuery";

export {
  isWindQuery,
  WindQuery,
  WindQueryManager,
  type WindQueryResult,
} from "../wind/WindQuery";
