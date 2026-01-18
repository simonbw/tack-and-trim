import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { V, V2d, type ReadonlyV2d } from "../../core/Vector";
import { WaterInfo } from "../water/WaterInfo";

const WAYPOINT_PULSE_SPEED = 2; // Pulses per second
const WAYPOINT_MIN_ALPHA = 0.3;
const WAYPOINT_MAX_ALPHA = 0.8;

export type WaypointState = "inactive" | "active" | "completed";

/**
 * Visual marker for mission objectives.
 * Renders as a glowing circle at the target location.
 */
export class Waypoint extends BaseEntity {
  layer = "main" as const;

  private state: WaypointState = "inactive";
  private pulsePhase: number = 0;
  private currentScale: number = 1;

  constructor(
    private position: ReadonlyV2d,
    private radius: number,
    private label?: string
  ) {
    super();
  }

  getPosition(): ReadonlyV2d {
    return this.position;
  }

  getRadius(): number {
    return this.radius;
  }

  getLabel(): string | undefined {
    return this.label;
  }

  setState(state: WaypointState): void {
    this.state = state;
  }

  getState(): WaypointState {
    return this.state;
  }

  @on("tick")
  onTick(dt: number) {
    // Animate pulse
    this.pulsePhase += dt * WAYPOINT_PULSE_SPEED * Math.PI * 2;
    if (this.pulsePhase > Math.PI * 2) {
      this.pulsePhase -= Math.PI * 2;
    }

    // Apply water surface height for bobbing effect
    const water = WaterInfo.fromGame(this.game!);
    const waterState = water.getStateAtPoint(V(this.position));
    this.currentScale = 1 + waterState.surfaceHeight * 0.1;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.position;

    // Calculate pulse alpha
    const pulseT = (Math.sin(this.pulsePhase) + 1) / 2; // 0 to 1
    const alpha =
      WAYPOINT_MIN_ALPHA + pulseT * (WAYPOINT_MAX_ALPHA - WAYPOINT_MIN_ALPHA);

    draw.at({ pos: V(x, y), scale: this.currentScale }, () => {
      this.renderWaypoint(draw, alpha);
    });
  }

  private renderWaypoint(draw: Draw, alpha: number) {
    const r = this.radius;

    switch (this.state) {
      case "inactive":
        // Gray, dim ring
        draw.strokeCircle(0, 0, r, {
          color: 0x888888,
          width: 2,
          alpha: alpha * 0.5,
        });
        break;

      case "active":
        // Bright yellow/gold pulsing ring with inner glow
        draw.fillCircle(0, 0, r, { color: 0xffdd44, alpha: alpha * 0.2 });
        draw.strokeCircle(0, 0, r, { color: 0xffdd44, width: 3, alpha });
        draw.strokeCircle(0, 0, r * 0.7, {
          color: 0xffff88,
          width: 1,
          alpha: alpha * 0.5,
        });
        break;

      case "completed":
        // Green checkmark appearance
        draw.fillCircle(0, 0, r * 0.5, { color: 0x44ff44, alpha: 0.6 });
        draw.strokeCircle(0, 0, r, { color: 0x44ff44, width: 2, alpha: 0.8 });
        break;
    }
  }
}
