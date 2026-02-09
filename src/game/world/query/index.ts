/**
 * Query system for sampling world data (terrain, water, wind)
 */
export { BaseQuery } from "./BaseQuery";
export { QueryManager, type ResultLayout } from "./QueryManager";

export { TerrainQuery } from "../terrain/TerrainQuery";
export { TerrainQueryManager } from "../terrain/TerrainQueryManager";
export { TerrainResultView, TerrainType } from "../terrain/TerrainQueryResult";

export { WaterQuery } from "../water/WaterQuery";
export { WaterQueryManager } from "../water/WaterQueryManager";
export { WaterResultView } from "../water/WaterQueryResult";

export { WindQuery } from "../wind/WindQuery";
export { WindQueryManager } from "../wind/WindQueryManager";
export { WindResultView } from "../wind/WindQueryResult";
