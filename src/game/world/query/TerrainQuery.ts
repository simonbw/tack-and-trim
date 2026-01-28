import { BaseQuery } from "./BaseQuery";
import type { V2d } from "../../../core/Vector";
import type { Game } from "../../../core/Game";
import type Entity from "../../../core/entity/Entity";
import { TerrainType } from "./TerrainType";

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
  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }

  /**
   * Get all TerrainQuery entities from the game
   * Used by TerrainQueryManager for type-safe query collection
   */
  static allFromGame(game: Game): TerrainQuery[] {
    return Array.from(game.entities.getTagged("terrainQuery")).filter(
      isTerrainQuery,
    );
  }
}
