import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V2d } from "../../core/Vector";
import { TerrainQueryManager } from "./query/TerrainQueryManager";
import { WaterQueryManager } from "./query/WaterQueryManager";
import { WindQueryManager } from "./query/WindQueryManager";

/**
 * Minimal level definition for stub implementation
 */
export interface LevelDefinition {
  /** Base wind velocity (m/s) */
  baseWind: V2d;
  /** Level name/identifier */
  name?: string;
}

/**
 * Central manager for the world simulation system.
 * Manages query infrastructure and world data systems.
 */
export class WorldManager extends BaseEntity {
  private baseWind: V2d;

  /**
   * @param levelDef Level definition containing world parameters
   */
  constructor(levelDef: LevelDefinition) {
    super();
    this.id = "world-manager";
    this.baseWind = levelDef.baseWind;
  }

  @on("add")
  onAdd(): void {
    // Initialize query managers as child entities
    // Each manager handles its own query type independently
    this.game.addEntity(new TerrainQueryManager());
    this.game.addEntity(new WaterQueryManager());
    this.game.addEntity(new WindQueryManager());
  }

  /**
   * Get the base wind velocity (unmodified by terrain/obstacles)
   */
  getBaseWind(): V2d {
    return this.baseWind;
  }

  /**
   * Set the base wind velocity
   */
  setBaseWind(wind: V2d): void {
    this.baseWind = wind;
  }

  /**
   * Get base wind as speed and direction
   */
  getBaseWindPolar(): { speed: number; direction: number } {
    const speed = this.baseWind.magnitude;
    const direction = Math.atan2(this.baseWind.y, this.baseWind.x);
    return { speed, direction };
  }
}
