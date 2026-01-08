import BaseEntity from "../core/entity/BaseEntity";
import DynamicBody from "../core/physics/body/DynamicBody";
import Circle from "../core/physics/shapes/Circle";
import { V } from "../core/Vector";
import { WaterInfo } from "./water/WaterInfo";

// Units: feet (ft), pounds (lbs)
const BUOY_RADIUS = 2; // ft - typical racing mark buoy
const BUOY_MASS = 50; // lbs - buoy with ballast
const BUOYANCY_STRENGTH = 0.5; // Dimensionless force per unit displacement
const WATER_DAMPING = 0.98; // Dimensionless velocity retention
const WATER_DRAG = 0.1; // Dimensionless - how strongly the buoy is pushed by water velocity
const HEIGHT_SCALE_FACTOR = 0.2; // Dimensionless - how much surface height affects sprite scale

export class Buoy extends BaseEntity {
  layer = "main" as const;
  body: DynamicBody;
  private currentScale: number = 1;

  constructor(x: number, y: number) {
    super();

    // Physics: circular body
    this.body = new DynamicBody({ mass: BUOY_MASS });
    this.body.addShape(new Circle({ radius: BUOY_RADIUS }));
    this.body.position.set(x, y);
  }

  onTick() {
    const [x, y] = this.body.position;

    // Simple buoyancy: push up when below water (y > 0)
    if (y > 0) {
      const buoyancyForce = -y * BUOYANCY_STRENGTH;
      this.body.applyForce(V(0, buoyancyForce));
    }

    // Apply water velocity as a drag force (pushes buoy with the current/wake)
    const water = this.game?.entities.getById("waterInfo") as
      | WaterInfo
      | undefined;
    if (water) {
      const waterState = water.getStateAtPoint(V(x, y));
      // Force proportional to difference between water velocity and buoy velocity
      const relativeVelocity = waterState.velocity.sub(V(this.body.velocity));
      this.body.applyForce(relativeVelocity.mul(WATER_DRAG));
    }

    // Damping to prevent wild oscillation
    this.body.velocity[0] *= WATER_DAMPING;
    this.body.velocity[1] *= WATER_DAMPING;
    this.body.angularVelocity *= WATER_DAMPING;

    // Update scale based on water surface height (simulates bobbing up/down)
    if (water) {
      const waterState = water.getStateAtPoint(V(x, y));
      this.currentScale = 1 + waterState.surfaceHeight * HEIGHT_SCALE_FACTOR;
    }
  }

  onRender() {
    const renderer = this.game!.getRenderer();
    const [x, y] = this.body.position;

    renderer.save();
    renderer.translate(x, y);
    renderer.rotate(this.body.angle);
    renderer.scale(this.currentScale);

    // Draw buoy: red/orange filled circle
    renderer.drawCircle(0, 0, BUOY_RADIUS, { color: 0xff4422 });
    renderer.drawCircle(0, 0, BUOY_RADIUS * 0.3, { color: 0xcccccc });

    renderer.restore();
  }
}
