import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { StaticBody } from "../core/physics/body/StaticBody";
import { Particle } from "../core/physics/shapes/Particle";
import { V, V2d } from "../core/Vector";
import { WaterQuery } from "./world/water/WaterQuery";

// Visual configuration
const MOORING_RADIUS = 1.5; // ft - visual radius of mooring point
const RING_RADIUS = 0.6; // ft - inner ring radius
const HEIGHT_SCALE_FACTOR = 0.15; // How much surface height affects scale
const MOORING_COLOR = 0xffaa00; // Orange/yellow
const RING_COLOR = 0x666666; // Gray metal ring

// Interaction configuration
export const MOORING_RANGE = 20; // ft - how close the boat needs to be to moor

/**
 * A mooring point that boats can tie up to.
 * When a boat gets close and presses F, it creates a mooring line
 * that reels the boat in close.
 */
export class MooringPoint extends BaseEntity {
  tags = ["mooringPoint"];
  layer = "main" as const;

  body: StaticBody;
  private currentScale: number = 1;

  // Water query for mooring point position
  private waterQuery = this.addChild(
    new WaterQuery(() => [V(this.body.position)]),
  );

  constructor(x: number, y: number) {
    super();

    // Static body - doesn't move
    this.body = new StaticBody();
    this.body.addShape(new Particle());
    this.body.position.set(x, y);
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  @on("tick")
  onTick() {
    // Get water state from previous frame's query (1-frame latency)
    const result = this.waterQuery.results[0];
    const surfaceHeight = result?.surfaceHeight ?? 0;

    // Update scale based on water surface height (simulates bobbing)
    this.currentScale = 1 + surfaceHeight * HEIGHT_SCALE_FACTOR;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;

    draw.at(
      { pos: V(x, y), angle: 0, scale: this.currentScale },
      () => {
        // Draw mooring buoy (orange/yellow)
        draw.fillCircle(0, 0, MOORING_RADIUS, { color: MOORING_COLOR });
        // Draw metal ring in center
        draw.fillCircle(0, 0, RING_RADIUS, { color: RING_COLOR });
        draw.fillCircle(0, 0, RING_RADIUS * 0.5, { color: MOORING_COLOR });
      },
    );
  }
}
