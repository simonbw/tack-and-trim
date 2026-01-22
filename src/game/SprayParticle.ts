import { BaseEntity } from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { profile } from "../core/util/Profiler";
import { V2d } from "../core/Vector";
import { FoamParticle } from "./FoamParticle";

// Physics (in ft and ft/s)
const GRAVITY = 32; // ft/s² - gravitational acceleration
const DRAG = 2.5; // 1/s - air drag (lower = particles travel further)

// Rendering
const COLOR = 0xffffff;
const ALPHA = 0.8;
const Z_SCALE = 0.05;
const SEGMENTS = 6; // Hexagon for performance

/**
 * A water droplet flying through the air.
 * Spawns a FoamParticle when it hits the water surface.
 */
export class SprayParticle extends BaseEntity {
  layer = "sprayParticles" as const;

  private position: V2d;
  private velocity: V2d;
  private z: number; // Height above water
  private zVelocity: number; // Vertical velocity
  private size: number;

  /**
   * Create a new spray particle.
   * @param position Initial world position (x, y)
   * @param velocity Initial velocity (x, y) in ft/s
   * @param zVelocity Initial vertical velocity in ft/s
   * @param size Particle size (radius) in ft
   */
  constructor(position: V2d, velocity: V2d, zVelocity: number, size: number) {
    super();
    this.position = position;
    this.velocity = velocity;
    this.z = 0.1; // Start slightly above water
    this.zVelocity = zVelocity;
    this.size = size;
  }

  @on("render")
  @profile
  onRender({ draw, dt }: GameEventMap["render"]): void {
    // Physics update
    this.zVelocity -= GRAVITY * dt;
    this.z += this.zVelocity * dt;
    this.position.iaddScaled(this.velocity, dt);
    this.velocity.imul(Math.exp(-DRAG * dt));

    // Hit water - spawn foam and destroy
    if (this.z <= 0) {
      this.game.addEntity(new FoamParticle(this.position, this.size));
      this.destroy();
      return;
    }

    // Render (slightly larger when higher for perspective)
    const radius = this.size * (1 + this.z * Z_SCALE);

    // Skip if not visible
    if (!draw.camera.isVisible(this.position.x, this.position.y, radius)) {
      return;
    }

    draw.fillCircle(this.position.x, this.position.y, radius, {
      color: COLOR,
      alpha: ALPHA,
    });
  }
}
