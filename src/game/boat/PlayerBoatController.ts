import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Port } from "../port/Port";
import { PortMenu } from "../port/PortMenu";
import { Boat } from "./Boat";
import { findBowPoint } from "./Hull";
import {
  SAILOR_RUN_SPEED,
  SAILOR_WALK_SPEED,
  type Sailor,
} from "./sailor/Sailor";
import type { StationDef } from "./sailor/StationConfig";

const DOCK_RANGE = 30; // feet — max distance to dock from bow

/**
 * Maps player input to boat actions. Controls are gated by the sailor's
 * current station: when walking, WASD drives the sailor and all boat
 * controls are inert; when at a station, WASD/QE drive that station's
 * bound controls.
 */
export class PlayerBoatController extends BaseEntity {
  tickLayer = "input" as const;
  private activeJibSheet: "port" | "starboard" = "port";

  constructor(private boat: Boat) {
    super();
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const io = this.game.io;

    // Port menu open — no controls
    if (this.game.entities.tryGetSingleton(PortMenu)) {
      io.setSteeringWheelForceFeedback(0);
      return;
    }

    // Boat is sinking — no controls
    if (this.boat.bilge.isSinking()) {
      this.boat.bilge.setBailing(false);
      io.setSteeringWheelForceFeedback(0);
      return;
    }

    const sailor = this.boat.sailor;

    // Not at a bail station — ensure bailing is off
    this.boat.bilge.setBailing(false);

    // Sailor is walking — WASD drives walking, boat controls inert
    if (sailor.state.kind === "walking") {
      this.onTickWalking(sailor);
      return;
    }

    // Sailor is at a station — dispatch controls based on station bindings
    const station = sailor.getCurrentStation()!;
    this.onTickAtStation(station, dt);
  }

  // ── Walking mode ────────────────────────────────────────────────

  private onTickWalking(sailor: Sailor): void {
    const io = this.game.io;

    // Release the rudder — it floats when unattended
    this.boat.rudder.setSteer(0);
    io.setSteeringWheelForceFeedback(0);

    // Idle the anchor (no input)
    this.boat.anchor.idle();

    // WASD → hull-local walk velocity. Shift = run.
    // The deck friction equations' Jacobian sign convention makes a
    // positive `relativeVelocity` push the sailor along the -tangent
    // direction, so we negate here: W (forward) = -X motor target, etc.
    const running = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");
    const speed = running ? SAILOR_RUN_SPEED : SAILOR_WALK_SPEED;
    let vx = 0;
    let vy = 0;
    if (io.isKeyDown("KeyW")) vx -= speed;
    if (io.isKeyDown("KeyS")) vx += speed;
    if (io.isKeyDown("KeyD")) vy -= speed;
    if (io.isKeyDown("KeyA")) vy += speed;

    sailor.setWalkVelocity(vx, vy, speed);
  }

  // ── Station mode ────────────────────────────────────────────────

  private onTickAtStation(station: StationDef, dt: number): void {
    const io = this.game.io;
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    // --- Steer axis (A/D) ---
    if (station.steerAxis) {
      const steer = io.getRudderSteerInput();
      switch (station.steerAxis) {
        case "rudder":
          this.boat.rudder.setSteer(steer, shiftHeld);
          io.setSteeringWheelForceFeedback(this.computeWheelFeedback(steer));
          break;
      }
    } else {
      // No steer binding — rudder floats
      this.boat.rudder.setSteer(0);
      io.setSteeringWheelForceFeedback(0);
    }

    // --- Primary axis (W/S) ---
    if (station.primaryAxis) {
      // getSheetInput: W → -1, S → +1
      const raw = io.getSheetInput();
      switch (station.primaryAxis) {
        case "mainsheet":
          this.boat.mainsheet.adjust(-raw * (shiftHeld ? 1.0 : 0.3));
          break;
        case "mainHoist": {
          const hoist = (-raw > 0 ? 1 : -raw < 0 ? -1 : 0) as -1 | 0 | 1;
          this.boat.rig.sail.setHoistInput(hoist);
          break;
        }
        case "jibHoistFurl": {
          const hoist = (-raw > 0 ? 1 : -raw < 0 ? -1 : 0) as -1 | 0 | 1;
          this.boat.jib?.setHoistInput(hoist);
          break;
        }
        case "jibSheets":
          this.updateJibSheets(raw, shiftHeld);
          break;
      }
    }

    // --- Secondary axis (Q/E) ---
    if (station.secondaryAxis) {
      switch (station.secondaryAxis) {
        case "jibSheets": {
          // Q/E jib sheet logic uses its own key reading
          const qHeld = io.isKeyDown("KeyQ");
          const eHeld = io.isKeyDown("KeyE");
          this.updateJibSheetsQE(qHeld, eHeld, shiftHeld);
          break;
        }
      }
    }

    // --- Station actions ---
    if (station.actions?.includes("anchor")) {
      if (io.isKeyDown("KeyG") && !this.boat.mooring.isMoored()) {
        this.boat.anchor.lower();
      } else if (io.isKeyDown("KeyR")) {
        this.boat.anchor.raise();
      } else {
        this.boat.anchor.idle();
      }
    } else {
      this.boat.anchor.idle();
    }

    // Bailing — only at stations with the bail action
    if (station.actions?.includes("bail")) {
      const bailing =
        io.isKeyDown("KeyB") && this.boat.bilge.getWaterFraction() > 0;
      this.boat.bilge.setBailing(bailing);
    }

    // Rowing — always available at any station
    if (io.isKeyDown("Space")) {
      this.boat.row();
    }

    // Debug controls
    if (io.isKeyDown("KeyJ")) {
      this.boat.hull.body.applyForce3D(0, 0, 80000, 0, 3, 0);
    }
    if (io.isKeyDown("KeyL")) {
      this.boat.hull.body.applyForce3D(0, 0, -80000, 0, 3, 0);
    }
    if (io.isKeyDown("KeyI")) {
      this.boat.hull.body.applyForce3D(0, 0, -80000, 3, 0, 0);
    }
    if (io.isKeyDown("KeyK")) {
      this.boat.hull.body.applyForce3D(0, 0, 80000, 3, 0, 0);
    }
    if (io.isKeyDown("Quote")) {
      const rate = shiftHeld ? 0.25 : 0.05;
      this.boat.bilge.waterVolume +=
        this.boat.bilge.getMaxWaterVolume() * rate * dt;
    }
  }

  // ── Jib sheet helpers ───────────────────────────────────────────

  /**
   * Jib sheet trimming via Q/E keys (when secondaryAxis = "jibSheets").
   * Single active sheet model with auto-tacking.
   */
  private updateJibSheetsQE(
    qHeld: boolean,
    eHeld: boolean,
    shiftHeld: boolean,
  ): void {
    if (
      !this.boat.jib ||
      !this.boat.portJibSheet ||
      !this.boat.starboardJibSheet
    )
      return;

    const activeSheet =
      this.activeJibSheet === "port"
        ? this.boat.portJibSheet
        : this.boat.starboardJibSheet;

    // Calculate trim input based on active sheet
    let trimInput = 0;
    if (this.activeJibSheet === "port") {
      if (eHeld)
        trimInput = -1; // E = trim in (port)
      else if (qHeld) trimInput = 1; // Q = ease out
    } else {
      if (qHeld)
        trimInput = -1; // Q = trim in (starboard)
      else if (eHeld) trimInput = 1; // E = ease out
    }

    // Handle tacking (switching sheets)
    if (shiftHeld) {
      if (qHeld) {
        this.activeJibSheet = "starboard";
        this.boat.portJibSheet.release();
      } else if (eHeld) {
        this.activeJibSheet = "port";
        this.boat.starboardJibSheet.release();
      }
    } else if (trimInput > 0 && activeSheet.isAtMaxLength()) {
      const newSheet = this.activeJibSheet === "port" ? "starboard" : "port";
      this.activeJibSheet = newSheet;
      if (newSheet === "port") {
        this.boat.starboardJibSheet.release();
      } else {
        this.boat.portJibSheet.release();
      }
    }

    const jibInput = trimInput * (shiftHeld ? 1.0 : 0.3);
    activeSheet.adjust(jibInput);
  }

  /**
   * Jib sheet trimming via W/S primary axis (when primaryAxis = "jibSheets").
   * Uses sheet input directly for trim.
   */
  private updateJibSheets(rawSheetInput: number, shiftHeld: boolean): void {
    if (
      !this.boat.jib ||
      !this.boat.portJibSheet ||
      !this.boat.starboardJibSheet
    )
      return;

    const activeSheet =
      this.activeJibSheet === "port"
        ? this.boat.portJibSheet
        : this.boat.starboardJibSheet;

    const trimInput = rawSheetInput;

    // Auto-switch when easing a fully slack sheet
    if (trimInput > 0 && activeSheet.isAtMaxLength()) {
      const newSheet = this.activeJibSheet === "port" ? "starboard" : "port";
      this.activeJibSheet = newSheet;
      if (newSheet === "port") {
        this.boat.starboardJibSheet.release();
      } else {
        this.boat.portJibSheet.release();
      }
    }

    const jibInput = -trimInput * (shiftHeld ? 1.0 : 0.3);
    activeSheet.adjust(jibInput);
  }

  // ── Steering wheel force feedback ───────────────────────────────

  private computeWheelFeedback(driverSteerInput: number): number {
    const rudderSteer = this.boat.rudder.getSteer();
    const rudderAngularVelocity = this.boat.rudder.getRelativeAngularVelocity();
    const speed = this.boat.getVelocity().magnitude;
    const speedFactor = Math.min(speed / 16, 1);

    const centering = driverSteerInput * 0.25;
    const waterLoad = rudderSteer * speedFactor * 0.65;
    const damping = rudderAngularVelocity * 0.06;

    return clamp(-(centering + waterLoad + damping), -1, 1);
  }

  // ── Port detection ──────────────────────────────────────────────

  /** Find the nearest port within docking range, or null. */
  private findNearbyPort(): Port | null {
    const bowLocal = findBowPoint(this.boat.config.hull.vertices);
    const bowWorld = bowLocal
      .rotate(this.boat.hull.body.angle)
      .iadd(this.boat.hull.body.position);

    let closest: Port | null = null;
    let closestDist = DOCK_RANGE;

    for (const entity of this.game.entities.getTagged("port")) {
      const port = entity as Port;
      const dist = V(port.getPosition()).sub(bowWorld).magnitude;
      if (dist < closestDist) {
        closestDist = dist;
        closest = port;
      }
    }
    return closest;
  }

  // ── Key events ──────────────────────────────────────────────────

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]) {
    if (key === "Comma") {
      void this.game.io.requestSteeringWheelConnection().then((result) => {
        if (result.connected) {
          console.info(`[Wheel] ${result.message}`);
        } else {
          console.warn(`[Wheel] ${result.message}`);
        }
      });
    }

    // No actions while port menu is open
    if (this.game.entities.tryGetSingleton(PortMenu)) return;

    const sailor = this.boat.sailor;

    if (sailor.state.kind === "atStation") {
      const station = sailor.getCurrentStation()!;

      // F at any station → leave and start walking
      if (key === "KeyF") {
        sailor.beginWalking();
        return;
      }

      // M at a station with mooring action → dock toggle
      if (key === "KeyM" && station.actions?.includes("mooring")) {
        if (this.boat.mooring.isMoored()) {
          this.boat.mooring.castOff();
        } else {
          const nearbyPort = this.findNearbyPort();
          if (nearbyPort) {
            this.boat.mooring.moorTo(nearbyPort);
          }
        }
        return;
      }
    } else {
      // Walking — F snaps to a nearby station (auto-snap also runs each tick).
      if (key === "KeyF") {
        sailor.snapToNearbyStation();
        return;
      }
    }
  }

  @on("destroy")
  onDestroy({ game }: GameEventMap["destroy"]): void {
    game.io.setSteeringWheelForceFeedback(0);
  }
}
