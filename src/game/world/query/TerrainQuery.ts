import { V, type V2d } from "../../../core/Vector";
import type Entity from "../../../core/entity/Entity";
import { TerrainSystem } from "../terrain/TerrainSystem";
import { TerrainType } from "../terrain/TerrainType";
import { BaseQuery } from "./BaseQuery";
import { QueryManager, type ResultLayout } from "./QueryManager";

/**
 * Result data from a terrain query at a specific point
 */
export interface TerrainQueryResult {
  /** Terrain height at this point (world Y coordinate) */
  height: number;
  /** Surface normal vector (points up from terrain) */
  normal: V2d;
  /** Terrain type identifier */
  terrainType: TerrainType;
}

/**
 * Type guard for TerrainQuery entities
 */
export function isTerrainQuery(entity: Entity): entity is TerrainQuery {
  return entity instanceof TerrainQuery;
}

/**
 * Entity that queries terrain data at multiple points each frame.
 */
export class TerrainQuery extends BaseQuery<TerrainQueryResult> {
  // Tag for discovery by TerrainQueryManager
  tags = ["terrainQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => ReadonlyArray<V2d>) {
    super(getPoints);
  }
}

/**
 * Named constants for terrain result buffer layout
 */
const TerrainResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    height: 0,
    normalX: 1,
    normalY: 2,
    terrainType: 3,
  },
};

const MAX_TERRAIN_QUERIES = 2 ** 16;
/**
 * Query manager for terrain queries.
 *
 * Handles GPU-accelerated terrain sampling for height, normals, and terrain type.
 */
export class TerrainQueryManager extends QueryManager<TerrainQueryResult> {
  id = "terrainQueryManager";
  tickLayer = "environment";

  constructor() {
    super(TerrainResultLayout, MAX_TERRAIN_QUERIES);
  }

  getQueries(): BaseQuery<TerrainQueryResult>[] {
    return [...this.game.entities.byConstructor(TerrainQuery)];
  }

  packResult(
    result: TerrainQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = TerrainResultLayout;
    buffer[offset + fields.height] = result.height;
    buffer[offset + fields.normalX] = result.normal.x;
    buffer[offset + fields.normalY] = result.normal.y;
    buffer[offset + fields.terrainType] = result.terrainType;
  }

  unpackResult(buffer: Float32Array, offset: number): TerrainQueryResult {
    const { fields } = TerrainResultLayout;
    return {
      height: buffer[offset + fields.height],
      normal: V(
        buffer[offset + fields.normalX],
        buffer[offset + fields.normalY],
      ),
      terrainType: buffer[offset + fields.terrainType] as TerrainType,
    };
  }

  dispatchCompute(pointCount: number): void {
    this.game.entities
      .getSingleton(TerrainSystem)
      .computeQueryResults(this.pointBuffer!, this.resultBuffer!, pointCount);
  }
}
