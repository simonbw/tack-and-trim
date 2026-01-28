import { BaseQuery } from "./BaseQuery";
import type { V2d } from "../../../core/Vector";
import type { Game } from "../../../core/Game";
import type Entity from "../../../core/entity/Entity";

/**
 * Result data from a wind query at a specific point
 */
export interface WindQueryResult {
  /** Wind velocity vector (m/s) */
  velocity: V2d;
  /** Wind speed (m/s, derived from velocity) */
  speed: number;
  /** Wind direction in radians (derived from velocity) */
  direction: number;
}

/**
 * Type guard for WindQuery entities
 */
export function isWindQuery(entity: Entity): entity is WindQuery {
  return entity instanceof WindQuery;
}

/**
 * Entity that queries wind data at multiple points each frame.
 */
export class WindQuery extends BaseQuery<WindQueryResult> {
  // Tag for discovery by WindQueryManager
  tags = ["windQuery"];

  /**
   * @param getPoints Callback that returns the points to query this frame
   */
  constructor(getPoints: () => V2d[]) {
    super(getPoints);
  }

  /**
   * Get all WindQuery entities from the game
   * Used by WindQueryManager for type-safe query collection
   */
  static allFromGame(game: Game): WindQuery[] {
    return Array.from(game.entities.getTagged("windQuery")).filter(isWindQuery);
  }
}
