import { V, type V2d } from "../../../core/Vector";
import type Entity from "../../../core/entity/Entity";
import { WaterSystem } from "../water/WaterSystem";
import { BaseQuery } from "./BaseQuery";
import { QueryManager, type ResultLayout } from "./QueryManager";

/**
 * Result data from a water query at a specific point
 */
export interface WaterQueryResult {
  /** Surface height at this point (world Y coordinate) */
  surfaceHeight: number;
  /** Water velocity (m/s) */
  velocity: V2d;
  /** Surface normal vector (points up from water) */
  normal: V2d;
  /** Water depth at this point (meters, undefined if unknown) */
  depth: number | undefined;
}

/**
 * Type guard for WaterQuery entities
 */
export function isWaterQuery(entity: Entity): entity is WaterQuery {
  return entity instanceof WaterQuery;
}

/**
 * Entity that queries water data at multiple points each frame.
 */
export class WaterQuery extends BaseQuery<WaterQueryResult> {
  // Tag for discovery by WaterQueryManager
  tags = ["waterQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }
}

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

const MAX_WATER_QUERIES = 2 ** 15;

/**
 * Query manager for water queries.
 *
 * Handles GPU-accelerated water sampling for surface height, velocity, normals, and depth.
 */
export class WaterQueryManager extends QueryManager<WaterQueryResult> {
  id = "waterQueryManager";
  tickLayer = "environment";

  constructor() {
    super(WaterResultLayout, MAX_WATER_QUERIES);
  }

  getQueries(): BaseQuery<WaterQueryResult>[] {
    return [...this.game.entities.byConstructor(WaterQuery)];
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
      normal: V(
        buffer[offset + fields.normalX],
        buffer[offset + fields.normalY],
      ),
      depth: buffer[offset + fields.depth],
    };
  }

  dispatchCompute(pointCount: number): void {
    const waterSystem = this.game.entities.tryGetSingleton(WaterSystem);
    if (!waterSystem) {
      console.warn("[WaterQuery] WaterSystem not found in game");
      return;
    }

    waterSystem.computeQueryResults(
      this.pointBuffer!,
      this.resultBuffer!,
      pointCount,
    );
  }
}
