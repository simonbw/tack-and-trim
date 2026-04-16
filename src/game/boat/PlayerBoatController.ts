import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Port } from "../port/Port";
import { PortMenu } from "../port/PortMenu";
import { Boat } from "./Boat";
import { findBowPoint } from "./Hull";
import type { StationDef } from "./sailor/StationConfig";
import type { Sailor } from "./sailor/Sailor";

const DOCK_RANGE = 30; // feet — max distance to dock from bow

/**
 * Maps player input to boat actions.
 *
 * When the boat has a sailor (config.sailor is set), controls are gated
 * by the sailor's current station. When walking, WASD drives the sailor
 * and all boat controls are inert. When at a station, WASD/QE drive
 * that station's bound controls.
 *
 * When the boat has no sailor config, falls back to legacy direct controls.
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

    // Bailing — B key locks out all other controls
    const bailing =
      io.isKeyDown("KeyB") && this.boat.bilge.getWaterFraction() > 0;
    this.boat.bilge.setBailing(bailing);
    if (bailing) {
      io.setSteeringWheelForceFeedback(0);
      return;
    }

    const sailor = this.boat.sailor;

    // No sailor configured — use legacy controls
    if (!sailor) {
      this.onTickLegacy(dt);
      return;
    }

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

    // WASD → hull-local walk velocity
    // W = forward (+X), S = backward (-X)
    // D = starboard (+Y), A = port (-Y)
    const walkSpeed = this.boat.config.sailor!.walkSpeed;
    let vx = 0;
    let vy = 0;
    if (io.isKeyDown("KeyW")) vx += walkSpeed;
    if (io.isKeyDown("KeyS")) vx -= walkSpeed;
    if (io.isKeyDown("KeyD")) vy += walkSpeed;
    if (io.isKeyDown("KeyA")) vy -= walkSpeed;

    sailor.setWalkVelocity(vx, vy);
  }

  // ── Station mode ────────────────────────────────────────────────

  private onTickAtStation(station: StationDef, dt: number): void {
    const io = this.game.io;
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    // Check for implicit walk trigger: pressing an unbound WASD key
    if (this.shouldStartWalking(station)) {
      this.boat.sailor!.beginWalking();
      this.onTickWalking(this.boat.sailor!);
      return;
    }

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
      if (io.isKeyDown("KeyR")) {
        this.boat.anchor.raise();
      } else {
        this.boat.anchor.idle();
      }
    } else {
      this.boat.anchor.idle();
    }

    // Rowing — always available at any station
    if (io.isKeyDown("Space")) {
      this.boat.row();
    }

    // Debug controls
    if (io.isKeyDown("BracketLeft")) {
      this.boat.hull.body.applyForce3D(0, 0, 80000, 0, 3, 0);
    }
    if (io.isKeyDown("BracketRight")) {
      this.boat.hull.body.applyForce3D(0, 0, -80000, 0, 3, 0);
    }
    if (io.isKeyDown("Quote")) {
      const rate = shiftHeld ? 0.25 : 0.05;
      this.boat.bilge.waterVolume +=
        this.boat.bilge.getMaxWaterVolume() * rate * (1 / 120);
    }
  }

  /**
   * Check if the player is pressing a WASD key that has no binding
   * at the current station, which should trigger walking.
   */
  private shouldStartWalking(station: StationDef): boolean {
    const io = this.game.io;
    // A or D pressed with no steerAxis binding
    if (!station.steerAxis && (io.isKeyDown("KeyA") || io.isKeyDown("KeyD"))) {
      return true;
    }
    // W or S pressed with no primaryAxis binding
    if (
      !station.primaryAxis &&
      (io.isKeyDown("KeyW") || io.isKeyDown("KeyS"))
    ) {
      return true;
    }
    return false;
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
    if (!this.boat.jib || !this.boat.portJibSheet || !this.boat.starboardJibSheet)
      return;

    const activeSheet =
      this.activeJibSheet === "port"
        ? this.boat.portJibSheet
        : this.boat.starboardJibSheet;

    // Calculate trim input based on active sheet
    let trimInput = 0;
    if (this.activeJibSheet === "port") {
      if (eHeld) trimInput = -1; // E = trim in (port)
      else if (qHeld) trimInput = 1; // Q = ease out
    } else {
      if (qHeld) trimInput = -1; // Q = trim in (starboard)
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
    if (!this.boat.jib || !this.boat.portJibSheet || !this.boat.starboardJibSheet)
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

  // ── Legacy controls (no sailor configured) ──────────────────────

  private onTickLegacy(dt: number): void {
    const io = this.game.io;
    const steer = io.getRudderSteerInput();
    const sheet = io.getSheetInput();
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    this.boat.rudder.setSteer(steer, shiftHeld);
    io.setSteeringWheelForceFeedback(this.computeWheelFeedback(steer));

    const mainsheetInput = -sheet * (shiftHeld ? 1.0 : 0.3);
    this.boat.mainsheet.adjust(mainsheetInput);

    const mainHoist = io.isKeyDown("KeyT") ? 1 : io.isKeyDown("KeyG") ? -1 : 0;
    this.boat.rig.sail.setHoistInput(mainHoist as -1 | 0 | 1);

    if (this.boat.jib) {
      const jibHoist =
        io.isKeyDown("KeyY") ? 1 : io.isKeyDown("KeyH") ? -1 : 0;
      this.boat.jib.setHoistInput(jibHoist as -1 | 0 | 1);
    }

    if (
      this.boat.jib &&
      this.boat.portJibSheet &&
      this.boat.starboardJibSheet
    ) {
      const qHeld = io.isKeyDown("KeyQ");
      const eHeld = io.isKeyDown("KeyE");
      this.updateJibSheetsQE(qHeld, eHeld, shiftHeld);
    }

    if (io.isKeyDown("Space")) {
      this.boat.row();
    }

    if (io.isKeyDown("KeyF") && !this.boat.mooring.isMoored()) {
      this.boat.anchor.lower();
    } else if (io.isKeyDown("KeyR")) {
      this.boat.anchor.raise();
    } else {
      this.boat.anchor.idle();
    }

    if (io.isKeyDown("BracketLeft")) {
      this.boat.hull.body.applyForce3D(0, 0, 80000, 0, 3, 0);
    }
    if (io.isKeyDown("BracketRight")) {
      this.boat.hull.body.applyForce3D(0, 0, -80000, 0, 3, 0);
    }
    if (io.isKeyDown("Quote")) {
      const rate = shiftHeld ? 0.25 : 0.05;
      this.boat.bilge.waterVolume +=
        this.boat.bilge.getMaxWaterVolume() * rate * dt;
    }
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

    if (!sailor) {
      // Legacy dock toggle
      if (key === "KeyF") {
        if (this.boat.mooring.isMoored()) {
          this.boat.mooring.castOff();
        } else {
          const nearbyPort = this.findNearbyPort();
          if (nearbyPort) {
            this.boat.mooring.moorTo(nearbyPort);
          }
        }
      }
      return;
    }

    // Sailor exists — handle station-aware key events
    if (sailor.state.kind === "atStation") {
      const station = sailor.getCurrentStation()!;

      // F at a station with mooring action → dock toggle
      if (key === "KeyF" && station.actions?.includes("mooring")) {
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

      // F at a station with anchor action → lower anchor
      if (key === "KeyF" && station.actions?.includes("anchor")) {
        this.boat.anchor.lower();
        return;
      }

      // Escape at any station → leave and start walking
      if (key === "Escape") {
        sailor.beginWalking();
        return;
      }
    }
  }

  @on("destroy")
  onDestroy({ game }: GameEventMap["destroy"]): void {
    game.io.setSteeringWheelForceFeedback(0);
  }
}
