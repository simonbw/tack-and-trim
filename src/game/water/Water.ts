import { Filter, Graphics } from "pixi.js";
import { createNoise3D, NoiseFunction3D } from "simplex-noise";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { V, V2d } from "../../core/Vector";
import { WakeField } from "./WakeField";
import { createWaterShader } from "./WaterShader";

// Current variation configuration
// Water currents are much slower and vary more gradually than wind
const CURRENT_SPATIAL_SCALE = 0.002; // Currents vary slowly across space
const CURRENT_TIME_SCALE = 0.05; // Currents change slowly over time
const CURRENT_SPEED_VARIATION = 0.4; // ±40% speed variation
const CURRENT_ANGLE_VARIATION = 0.5; // ±~30° direction variation

/**
 * Water state at a given point in the world.
 */
export interface WaterState {
  /** Combined water velocity (currents + waves + wakes) */
  velocity: V2d;
  /** Wave surface displacement at this point */
  surfaceHeight: number;
  /** Wake intensity for visual effects (foam, spray) */
  wakeIntensity: number;
}

/**
 * Water entity that renders an infinite ocean using a custom shader.
 * The shader computes world-space coordinates from screen position + camera,
 * so the water pattern stays fixed in world space as the camera moves.
 *
 * Also provides a query interface for water state at any world position,
 * used by underwater physics components (keel, rudder, hull).
 */
export class Water extends BaseEntity {
  id = "water";
  private waterShader: Filter;
  private graphics: Graphics & GameSprite;

  // Current simulation
  private baseCurrentVelocity: V2d = V(15, 5); // Base current direction and speed
  private speedNoise: NoiseFunction3D = createNoise3D();
  private angleNoise: NoiseFunction3D = createNoise3D();

  constructor() {
    super();

    // Create a screen-sized quad. We position it to follow the camera each frame.
    // The shader handles converting screen coords to world coords.
    this.graphics = createGraphics("water");
    this.graphics.rect(0, 0, 1, 1).fill({ color: 0x0000ff });
    this.graphics.position.set(0, 0);

    this.waterShader = createWaterShader();
    this.graphics.filters = [this.waterShader];

    this.sprite = this.graphics;
  }

  onRender(dt: number) {
    if (!this.game) return;

    const camera = this.game.camera;
    const worldViewport = camera.getWorldViewport();

    // Make sure the graphics object is covering exactly the viewport
    this.graphics.position.set(worldViewport.left, worldViewport.top);
    this.graphics.setSize(worldViewport.width, worldViewport.height);

    const resolution =
      typeof this.waterShader.resolution === "number"
        ? this.waterShader.resolution
        : this.game.renderer.app.renderer.resolution;

    // Update shader uniforms
    this.waterShader.resources.waterUniforms.uniforms.uTime =
      this.game.elapsedTime;
    this.waterShader.resources.waterUniforms.uniforms.uResolution = resolution;
    camera
      .getMatrix()
      .scale(resolution, resolution)
      .invert()
      .toArray(
        true,
        this.waterShader.resources.waterUniforms.uniforms.uCameraMatrix
      );
  }

  /**
   * Get the water state at a given world position.
   * Used by underwater physics components to determine water velocity.
   */
  getStateAtPoint(point: V2d): WaterState {
    // Start with current velocity
    const velocity = this.getCurrentVelocityAtPoint(point);

    // Add wake contributions
    const wakeField = this.game?.entities.getById("wakeField") as
      | WakeField
      | undefined;

    let surfaceHeight = 0;
    let wakeIntensity = 0;

    if (wakeField) {
      velocity.iadd(wakeField.getVelocityAtPoint(point));
      surfaceHeight += wakeField.getHeightAtPoint(point);
      wakeIntensity = wakeField.getIntensityAtPoint(point);
    }

    return {
      velocity,
      surfaceHeight,
      wakeIntensity,
    };
  }

  /**
   * Get the current velocity at a given world position.
   * Uses simplex noise for natural spatial and temporal variation.
   */
  private getCurrentVelocityAtPoint([x, y]: V2d): V2d {
    const t = (this.game?.elapsedUnpausedTime ?? 0) * CURRENT_TIME_SCALE;

    const sx = x * CURRENT_SPATIAL_SCALE;
    const sy = y * CURRENT_SPATIAL_SCALE;

    // Sample noise for speed and angle variation
    const speedScale = 1 + this.speedNoise(sx, sy, t) * CURRENT_SPEED_VARIATION;
    const angleVariance = this.angleNoise(sx, sy, t) * CURRENT_ANGLE_VARIATION;

    return this.baseCurrentVelocity.mul(speedScale).irotate(angleVariance);
  }

  /**
   * Set the base current velocity.
   */
  setCurrentVelocity(velocity: V2d): void {
    this.baseCurrentVelocity.set(velocity);
  }

  /**
   * Get the current speed (magnitude of base velocity).
   */
  getCurrentSpeed(): number {
    return this.baseCurrentVelocity.magnitude;
  }

  /**
   * Get the current direction angle.
   */
  getCurrentAngle(): number {
    return this.baseCurrentVelocity.angle;
  }
}
