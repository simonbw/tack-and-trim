/**
 * Query system for sampling world data (terrain, water, wind)
 */
export { BaseQuery } from "./BaseQuery";
export { QueryManager, type ResultLayout } from "./QueryManager";

export { TerrainType, isValidTerrainType } from "./TerrainType";
export { TerrainQuery, type TerrainQueryResult, isTerrainQuery } from "./TerrainQuery";
export { TerrainQueryManager } from "./TerrainQueryManager";

export { WaterQuery, type WaterQueryResult, isWaterQuery } from "./WaterQuery";
export { WaterQueryManager } from "./WaterQueryManager";

export { WindQuery, type WindQueryResult, isWindQuery } from "./WindQuery";
export { WindQueryManager } from "./WindQueryManager";
