import { BaseQuery } from "./BaseQuery";
import type { V2d } from "../../../core/Vector";
import type { Game } from "../../../core/Game";
import type Entity from "../../../core/entity/Entity";

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

  /**
   * Get all WaterQuery entities from the game
   * Used by WaterQueryManager for type-safe query collection
   */
  static allFromGame(game: Game): WaterQuery[] {
    return Array.from(game.entities.getTagged("waterQuery")).filter(
      isWaterQuery,
    );
  }
}
