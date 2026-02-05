/**
 * Query system for sampling world data (terrain, water, wind)
 */
export { BaseQuery } from "./BaseQuery";
export { QueryManager, type ResultLayout } from "./QueryManager";

export {
  TerrainQuery,
  TerrainQueryManager,
  TerrainType,
  type TerrainQueryResult,
} from "../terrain/TerrainQuery";

export {
  WaterQuery,
  WaterQueryManager,
  type WaterQueryResult,
} from "../water/WaterQuery";

export {
  WindQuery,
  WindQueryManager,
  type WindQueryResult,
} from "../wind/WindQuery";
