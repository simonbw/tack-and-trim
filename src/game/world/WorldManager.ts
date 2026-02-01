import { BaseEntity } from "../../core/entity/BaseEntity";
import { V, V2d } from "../../core/Vector";
import { TerrainSystem } from "./terrain/TerrainSystem";
import { WaterSystem, WaterSystemConfig } from "./water/WaterSystem";
import { WindSystem } from "./wind/WindSystem";
import type { TerrainDefinition } from "./terrain/TerrainTypes";
import { TerrainQueryManager } from "./query/TerrainQuery.js";
import { WindQueryManager } from "./query/WindQuery.js";
import { WaterQueryManager } from "./query/WaterQuery.js";

/**
 * Minimal level definition for stub implementation
 */
export interface LevelDefinition {
  /** Level name/identifier */
  name?: string;
  /** Optional terrain definition (if not provided, uses default test terrain) */
  terrain?: TerrainDefinition;
  /** Base wind velocity (m/s) */
  baseWind?: V2d;
  /** Water system configuration */
  water?: WaterSystemConfig;
}

/**
 * Create a simple test terrain for Phase 2.
 * This creates a rectangular island with a hill in the center.
 */
function createTestTerrain(): TerrainDefinition {
  return {
    defaultDepth: -10, // 10 meters deep water
    contours: [
      // Outer coastline (0 meters)
      {
        controlPoints: [V(-100, -100), V(100, -100), V(100, 100), V(-100, 100)],
        height: 0,
      },
      // Inner hill (5 meters high)
      {
        controlPoints: [V(-30, -30), V(30, -30), V(30, 30), V(-30, 30)],
        height: 5,
      },
      // Peak (10 meters high)
      {
        controlPoints: [V(-10, -10), V(10, -10), V(10, 10), V(-10, 10)],
        height: 10,
      },
    ],
  };
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

    // Use baseWind from level definition or default to 5 m/s from west
    this.baseWind = levelDef.baseWind ?? V(5, 0);

    // Create terrain system with provided or default terrain
    const terrainDef = levelDef.terrain || createTestTerrain();
    this.addChild(new TerrainSystem(terrainDef));

    // Create wind system
    this.addChild(new WindSystem(this.baseWind));

    // Create water system with config from level definition or defaults
    const waterConfig: WaterSystemConfig = levelDef.water ?? {
      waves: [
        { direction: 0, amplitude: 0.5, wavelength: 20 }, // Primary wave: 20m wavelength
        { direction: Math.PI / 4, amplitude: 0.3, wavelength: 15 }, // Secondary wave: 15m wavelength
      ],
    };
    this.addChild(new WaterSystem(waterConfig));

    // Add query managers
    this.addChild(new TerrainQueryManager());
    this.addChild(new WaterQueryManager());
    this.addChild(new WindQueryManager());
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
    return { speed: this.baseWind.magnitude, direction: this.baseWind.angle };
  }
}
