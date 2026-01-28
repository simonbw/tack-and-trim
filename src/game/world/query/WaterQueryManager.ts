import { QueryManager, type ResultLayout } from "./QueryManager";
import { WaterQuery, type WaterQueryResult, isWaterQuery } from "./WaterQuery";
import type { BaseQuery } from "./BaseQuery";
import { V } from "../../../core/Vector";

/**
 * Named constants for water result buffer layout
 */
const WaterResultLayout: ResultLayout = {
  stride: 6,
  fields: {
    surfaceHeight: 0,
    velocityX: 1,
    velocityY: 2,
    normalX: 3,
    normalY: 4,
    depth: 5,
  },
};

/**
 * Query manager for water queries.
 *
 * Handles GPU-accelerated water sampling for surface height, velocity, normals, and depth.
 */
export class WaterQueryManager extends QueryManager<WaterQueryResult> {
  id = "waterQueryManager";
  tickLayer = "environment";

  getResultLayout(): ResultLayout {
    return WaterResultLayout;
  }

  getQueries(): BaseQuery<WaterQueryResult>[] {
    return WaterQuery.allFromGame(this.game);
  }

  packResult(
    result: WaterQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = WaterResultLayout;
    buffer[offset + fields.surfaceHeight] = result.surfaceHeight;
    buffer[offset + fields.velocityX] = result.velocity.x;
    buffer[offset + fields.velocityY] = result.velocity.y;
    buffer[offset + fields.normalX] = result.normal.x;
    buffer[offset + fields.normalY] = result.normal.y;
    buffer[offset + fields.depth] = result.depth ?? 0;
  }

  unpackResult(buffer: Float32Array, offset: number): WaterQueryResult {
    const { fields } = WaterResultLayout;
    return {
      surfaceHeight: buffer[offset + fields.surfaceHeight],
      velocity: V(
        buffer[offset + fields.velocityX],
        buffer[offset + fields.velocityY],
      ),
      normal: V(buffer[offset + fields.normalX], buffer[offset + fields.normalY]),
      depth: buffer[offset + fields.depth],
    };
  }

  protected generateStubData(data: Float32Array, pointCount: number): void {
    const { fields, stride } = WaterResultLayout;
    for (let i = 0; i < pointCount; i++) {
      const offset = i * stride;
      data[offset + fields.surfaceHeight] = 0;
      data[offset + fields.velocityX] = 0;
      data[offset + fields.velocityY] = 0;
      data[offset + fields.normalX] = 0;
      data[offset + fields.normalY] = 1;
      data[offset + fields.depth] = 100; // Default water depth
    }
  }
}
