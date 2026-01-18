import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { KeyCode } from "../../core/io/Keys";
import DynamicBody from "../../core/physics/body/DynamicBody";
import Circle from "../../core/physics/shapes/Circle";
import { V, type ReadonlyV2d } from "../../core/Vector";
import { WaterInfo } from "../water/WaterInfo";
import type { Mission } from "./MissionTypes";
import { WorldLabel } from "./WorldLabel";

// Physics constants (same as Buoy)
const SPOT_RADIUS = 3; // ft - slightly larger than regular buoy
const SPOT_MASS = 60; // lbs
const BUOYANCY_STRENGTH = 0.5;
const WATER_DAMPING = 0.98;
const WATER_DRAG = 0.1;
const HEIGHT_SCALE_FACTOR = 0.2;

// Interaction constants
const INTERACTION_RADIUS = 30; // ft - how close boat must be to interact
const INTERACTION_KEY: KeyCode = "KeyF";

export type MissionSpotState = "locked" | "available" | "active" | "completed";

/**
 * A buoy with a flag that marks a mission start location.
 * Players can approach and press F to start the mission.
 */
export class MissionSpot extends BaseEntity {
  layer = "main" as const;
  body: DynamicBody;

  private state: MissionSpotState = "available";
  private playerInRange: boolean = false;
  private currentScale: number = 1;
  private flagWave: number = 0;
  private nameLabel: WorldLabel | null = null;

  /** Callback when player presses interact key while in range */
  public onInteract?: () => void;

  constructor(
    private mission: Mission,
    initialState: MissionSpotState = "available"
  ) {
    super();
    this.state = initialState;

    // Physics body for water interaction
    this.body = new DynamicBody({ mass: SPOT_MASS });
    this.body.addShape(new Circle({ radius: SPOT_RADIUS }));
    this.body.position.set(mission.spotPosition[0], mission.spotPosition[1]);
  }

  getMission(): Mission {
    return this.mission;
  }

  getState(): MissionSpotState {
    return this.state;
  }

  setState(state: MissionSpotState): void {
    this.state = state;
  }

  isPlayerInRange(): boolean {
    return this.playerInRange;
  }

  @on("add")
  onAdd() {
    // Create world-space label for mission name
    this.nameLabel = new WorldLabel(
      () => this.body.getPosition(),
      () => this.mission.name,
      {
        offset: V(0, -50),
        fadeStartDistance: 60,
        fadeEndDistance: 120,
        fontSize: 16,
      }
    );
    this.game!.addEntity(this.nameLabel);
  }

  @on("destroy")
  onDestroy() {
    if (this.nameLabel) {
      this.nameLabel.destroy();
    }
  }

  @on("tick")
  onTick(dt: number) {
    const [x, y] = this.body.position;

    // Buoyancy physics (same as Buoy)
    if (y > 0) {
      const buoyancyForce = -y * BUOYANCY_STRENGTH;
      this.body.applyForce(V(0, buoyancyForce));
    }

    // Water current/wake interaction
    const water = WaterInfo.fromGame(this.game!);
    const waterState = water.getStateAtPoint(V(x, y));
    const relativeVelocity = waterState.velocity.sub(V(this.body.velocity));
    this.body.applyForce(relativeVelocity.mul(WATER_DRAG));

    // Damping
    this.body.velocity[0] *= WATER_DAMPING;
    this.body.velocity[1] *= WATER_DAMPING;
    this.body.angularVelocity *= WATER_DAMPING;

    // Surface bobbing
    this.currentScale = 1 + waterState.surfaceHeight * HEIGHT_SCALE_FACTOR;

    // Flag waving animation
    this.flagWave += dt * 3;
    if (this.flagWave > Math.PI * 2) {
      this.flagWave -= Math.PI * 2;
    }

    // Check if player is in range
    this.updatePlayerProximity();

    // Update label visibility based on state
    if (this.nameLabel) {
      this.nameLabel.setVisible(
        this.state !== "locked" && this.playerInRange
      );
    }
  }

  private updatePlayerProximity() {
    const boat = this.game!.entities.getById("boat");
    if (!boat || !("getPosition" in boat)) {
      this.playerInRange = false;
      return;
    }

    const boatPos = (boat as { getPosition: () => ReadonlyV2d }).getPosition();
    const distance = V(this.body.getPosition()).distanceTo(boatPos);
    this.playerInRange = distance <= INTERACTION_RADIUS;
  }

  @on("keyDown")
  onKeyDown(keyCode: KeyCode) {
    if (
      keyCode === INTERACTION_KEY &&
      this.playerInRange &&
      this.state === "available" &&
      this.onInteract
    ) {
      this.onInteract();
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;

    draw.at(
      { pos: V(x, y), angle: this.body.angle, scale: this.currentScale },
      () => {
        this.renderSpot(draw);
      }
    );
  }

  private renderSpot(draw: Draw) {
    const r = SPOT_RADIUS;

    // Base buoy color based on state
    const baseColor = this.getBaseColor();
    const flagColor = this.getFlagColor();

    // Draw buoy base
    draw.fillCircle(0, 0, r, { color: baseColor });
    draw.strokeCircle(0, 0, r, { color: 0x333333, width: 1 });

    // Draw pole
    const poleHeight = r * 4;
    draw.drawLine(0, 0, 0, -poleHeight, { color: 0x444444, width: 2 });

    // Draw flag (waving)
    const flagWidth = r * 2.5;
    const flagHeight = r * 1.5;
    const waveOffset = Math.sin(this.flagWave) * 2;

    // Flag as a simple polygon (triangle-ish shape)
    const flagPoints = [
      V(0, -poleHeight),
      V(flagWidth + waveOffset, -poleHeight + flagHeight * 0.3),
      V(flagWidth * 0.8 + waveOffset * 0.8, -poleHeight + flagHeight * 0.5),
      V(flagWidth + waveOffset, -poleHeight + flagHeight * 0.7),
      V(0, -poleHeight + flagHeight),
    ];

    // Draw flag shape
    for (let i = 0; i < flagPoints.length - 1; i++) {
      draw.drawLine(
        flagPoints[i].x,
        flagPoints[i].y,
        flagPoints[i + 1].x,
        flagPoints[i + 1].y,
        { color: flagColor, width: 2 }
      );
    }

    // Fill flag (simplified as lines)
    for (let t = 0.1; t < 1; t += 0.1) {
      const leftY = -poleHeight + flagHeight * t;
      const rightX =
        flagWidth * (1 - Math.abs(t - 0.5) * 0.4) +
        waveOffset * (1 - t * 0.5);
      const rightY = -poleHeight + flagHeight * (0.3 + t * 0.4);
      draw.drawLine(0, leftY, rightX, rightY, {
        color: flagColor,
        width: 1,
        alpha: 0.7,
      });
    }

    // Interaction prompt when in range and available
    if (this.playerInRange && this.state === "available") {
      this.renderInteractionPrompt(draw);
    }

    // Lock icon for locked missions
    if (this.state === "locked") {
      this.renderLockIcon(draw);
    }
  }

  private renderInteractionPrompt(draw: Draw) {
    // Small "F" indicator above the flag
    const promptY = -SPOT_RADIUS * 6;

    // Background circle
    draw.fillCircle(0, promptY, 8, { color: 0x000000, alpha: 0.6 });
    draw.strokeCircle(0, promptY, 8, { color: 0xffffff, width: 1 });

    // The actual "F" would need text rendering - for now just show a marker
    draw.fillCircle(0, promptY, 4, { color: 0xffff00 });
  }

  private renderLockIcon(draw: Draw) {
    // Simple lock shape on the buoy
    const lockSize = SPOT_RADIUS * 0.6;
    draw.fillCircle(0, 0, lockSize, { color: 0x666666, alpha: 0.8 });
    draw.strokeCircle(0, -lockSize * 0.5, lockSize * 0.4, {
      color: 0x666666,
      width: 2,
    });
  }

  private getBaseColor(): number {
    switch (this.state) {
      case "locked":
        return 0x666666; // Gray
      case "available":
        return 0x4488ff; // Blue
      case "active":
        return 0xffaa00; // Orange/gold
      case "completed":
        return 0x44cc44; // Green
    }
  }

  private getFlagColor(): number {
    switch (this.state) {
      case "locked":
        return 0x888888; // Gray
      case "available":
        return 0xff4444; // Red (like a racing flag)
      case "active":
        return 0xffdd00; // Yellow
      case "completed":
        return 0x44ff44; // Green
    }
  }
}
