import { QueryManager, type ResultLayout } from "./QueryManager";
import { WindQuery, type WindQueryResult, isWindQuery } from "./WindQuery";
import type { BaseQuery } from "./BaseQuery";
import { V } from "../../../core/Vector";
import { WindSystem } from "../wind/WindSystem";

/**
 * Named constants for wind result buffer layout
 */
const WindResultLayout: ResultLayout = {
  stride: 4,
  fields: {
    velocityX: 0,
    velocityY: 1,
    speed: 2,
    direction: 3,
  },
};

/**
 * Query manager for wind queries.
 *
 * Handles GPU-accelerated wind sampling for velocity, speed, and direction.
 */
export class WindQueryManager extends QueryManager<WindQueryResult> {
  id = "windQueryManager";
  tickLayer = "environment";

  constructor() {
    super(WindResultLayout, 8192);
  }

  getQueries(): BaseQuery<WindQueryResult>[] {
    return WindQuery.allFromGame(this.game);
  }

  packResult(
    result: WindQueryResult,
    buffer: Float32Array,
    offset: number,
  ): void {
    const { fields } = WindResultLayout;
    buffer[offset + fields.velocityX] = result.velocity.x;
    buffer[offset + fields.velocityY] = result.velocity.y;
    buffer[offset + fields.speed] = result.speed;
    buffer[offset + fields.direction] = result.direction;
  }

  unpackResult(buffer: Float32Array, offset: number): WindQueryResult {
    const { fields } = WindResultLayout;
    return {
      velocity: V(
        buffer[offset + fields.velocityX],
        buffer[offset + fields.velocityY],
      ),
      speed: buffer[offset + fields.speed],
      direction: buffer[offset + fields.direction],
    };
  }

  protected generateStubData(data: Float32Array, pointCount: number): void {
    const { fields, stride } = WindResultLayout;
    for (let i = 0; i < pointCount; i++) {
      const offset = i * stride;
      data[offset + fields.velocityX] = 5; // 5 m/s from west
      data[offset + fields.velocityY] = 0;
      data[offset + fields.speed] = 5;
      data[offset + fields.direction] = 0;
    }
  }

  protected dispatchCompute(pointCount: number): void {
    const windSystem = this.game.entities.getById("windSystem") as
      | WindSystem
      | undefined;

    if (!windSystem) {
      console.warn("WindQueryManager: WindSystem not found, using stub data");
      super.dispatchCompute(pointCount);
      return;
    }

    // Dispatch GPU compute via WindSystem
    windSystem.computeQueryResults(
      this.pointBuffer,
      this.resultBuffer,
      pointCount,
    );
  }
}
