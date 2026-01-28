import { QueryManager, type ResultLayout } from "./QueryManager";
import { TerrainQuery, type TerrainQueryResult, isTerrainQuery } from "./TerrainQuery";
import { TerrainType } from "./TerrainType";
import type { BaseQuery } from "./BaseQuery";
import { V } from "../../../core/Vector";

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

/**
 * Query manager for terrain queries.
 *
 * Handles GPU-accelerated terrain sampling for height, normals, and terrain type.
 */
export class TerrainQueryManager extends QueryManager<TerrainQueryResult> {
  id = "terrainQueryManager";
  tickLayer = "environment";

  getResultLayout(): ResultLayout {
    return TerrainResultLayout;
  }

  getQueries(): BaseQuery<TerrainQueryResult>[] {
    return TerrainQuery.allFromGame(this.game);
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

  protected generateStubData(data: Float32Array, pointCount: number): void {
    const { fields, stride } = TerrainResultLayout;
    for (let i = 0; i < pointCount; i++) {
      const offset = i * stride;
      data[offset + fields.height] = 0;
      data[offset + fields.normalX] = 0;
      data[offset + fields.normalY] = 1;
      data[offset + fields.terrainType] = TerrainType.Grass;
    }
  }
}
