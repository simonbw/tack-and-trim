import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { DynamicBody } from "../core/physics/body/DynamicBody";
import { Circle } from "../core/physics/shapes/Circle";
import { V } from "../core/Vector";
import { WaterQuery } from "./world/water/WaterQuery";

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

  // Water query for buoy position
  private waterQuery = this.addChild(
    new WaterQuery(() => [V(this.body.position)]),
  );

  constructor(x: number, y: number) {
    super();

    // Physics: circular body
    this.body = new DynamicBody({ mass: BUOY_MASS });
    this.body.addShape(new Circle({ radius: BUOY_RADIUS }));
    this.body.position.set(x, y);
  }

  @on("tick")
  onTick() {
    const [x, y] = this.body.position;

    // Simple buoyancy: push up when below water (y > 0)
    if (y > 0) {
      const buoyancyForce = -y * BUOYANCY_STRENGTH;
      this.body.applyForce(V(0, buoyancyForce));
    }

    // Get water state from previous frame's query (1-frame latency)
    const result = this.waterQuery.results[0];
    const waterVelocity = result?.velocity ?? V(0, 0);
    const surfaceHeight = result?.surfaceHeight ?? 0;

    // Force proportional to difference between water velocity and buoy velocity
    const relativeVelocity = waterVelocity.sub(V(this.body.velocity));
    this.body.applyForce(relativeVelocity.mul(WATER_DRAG));

    // Damping to prevent wild oscillation
    this.body.velocity[0] *= WATER_DAMPING;
    this.body.velocity[1] *= WATER_DAMPING;
    this.body.angularVelocity *= WATER_DAMPING;

    // Update scale based on water surface height (simulates bobbing up/down)
    this.currentScale = 1 + surfaceHeight * HEIGHT_SCALE_FACTOR;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;

    draw.at(
      { pos: V(x, y), angle: this.body.angle, scale: this.currentScale },
      () => {
        const r = BUOY_RADIUS;
        // Draw buoy: red/orange filled circle
        draw.fillCircle(0, 0, r, { color: 0xff4422 });
        draw.fillCircle(0, 0, r * 0.3, { color: 0xcccccc });
      },
    );
  }
}
