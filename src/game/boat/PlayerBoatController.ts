import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { clamp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import { Port } from "../port/Port";
import { PortMenu } from "../port/PortMenu";
import { Boat } from "./Boat";
import { findBowPoint } from "./Hull";

const DOCK_RANGE = 30; // feet — max distance to dock from bow

/**
 * Maps player input to boat actions.
 * Separating this from Boat allows for AI-controlled boats, network boats, etc.
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

    // Handle continuous input
    const steer = io.getRudderSteerInput();
    const sheet = io.getSheetInput();
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    // Update rudder steering (A/D or left/right arrows)
    this.boat.rudder.setSteer(steer, shiftHeld);
    io.setSteeringWheelForceFeedback(this.computeWheelFeedback(steer));

    // Update mainsheet (W = trim in, S = ease out)
    // Normal = 30% winch force, shift = full grind
    const mainsheetInput = -sheet * (shiftHeld ? 1.0 : 0.3);
    this.boat.mainsheet.adjust(mainsheetInput);

    // Mainsail hoist/furl (T = hoist, G = furl)
    const mainHoist = io.isKeyDown("KeyT") ? 1 : io.isKeyDown("KeyG") ? -1 : 0;
    this.boat.rig.sail.setHoistInput(mainHoist as -1 | 0 | 1);

    // Jib hoist/furl (Y = hoist, H = furl)
    if (this.boat.jib) {
      const jibHoist = io.isKeyDown("KeyY") ? 1 : io.isKeyDown("KeyH") ? -1 : 0;
      this.boat.jib.setHoistInput(jibHoist as -1 | 0 | 1);
    }

    // Jib sheet controls - only if boat has a jib
    if (
      this.boat.jib &&
      this.boat.portJibSheet &&
      this.boat.starboardJibSheet
    ) {
      // Single active sheet model
      // Q/E meaning depends on which sheet is active:
      //   Port active: Q = ease out, E = trim in
      //   Starboard active: Q = trim in, E = ease out
      // SHIFT + Q/E = switch sheets (tack)
      const qHeld = io.isKeyDown("KeyQ");
      const eHeld = io.isKeyDown("KeyE");

      // Get active sheet reference
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
        // Shift+Q/E explicitly switches sheets
        if (qHeld) {
          this.activeJibSheet = "starboard";
          this.boat.portJibSheet.release();
        } else if (eHeld) {
          this.activeJibSheet = "port";
          this.boat.starboardJibSheet.release();
        }
      } else if (trimInput > 0 && activeSheet.isAtMaxLength()) {
        // Auto-switch when trying to ease out a fully slack sheet
        const newSheet = this.activeJibSheet === "port" ? "starboard" : "port";
        this.activeJibSheet = newSheet;
        if (newSheet === "port") {
          this.boat.starboardJibSheet.release();
        } else {
          this.boat.portJibSheet.release();
        }
      }

      // Jib sheet: normal = 30% winch force, shift = full grind
      const jibInput = trimInput * (shiftHeld ? 1.0 : 0.3);
      activeSheet.adjust(jibInput);
    }

    if (io.isKeyDown("Space")) {
      this.boat.row();
    }

    // Anchor rode controls: F (hold) = lower, R (hold) = raise, release = locked
    if (io.isKeyDown("KeyF") && !this.boat.mooring.isMoored()) {
      this.boat.anchor.lower();
    } else if (io.isKeyDown("KeyR")) {
      this.boat.anchor.raise();
    } else {
      this.boat.anchor.idle();
    }

    // Debug: apply heeling forces with [ and ]
    // Apply roll torque by pushing up on one side of the hull
    if (io.isKeyDown("BracketLeft")) {
      this.boat.hull.body.applyForce3D(0, 0, 80000, 0, 3, 0);
    }
    if (io.isKeyDown("BracketRight")) {
      this.boat.hull.body.applyForce3D(0, 0, -80000, 0, 3, 0);
    }

    // Debug: fill bilge with water (hold ')
    if (io.isKeyDown("Quote")) {
      const rate = shiftHeld ? 0.25 : 0.05;
      this.boat.bilge.waterVolume +=
        this.boat.bilge.getMaxWaterVolume() * rate * dt;
    }
  }

  private computeWheelFeedback(driverSteerInput: number): number {
    const rudderSteer = this.boat.rudder.getSteer();
    const rudderAngularVelocity = this.boat.rudder.getRelativeAngularVelocity();
    const speed = this.boat.getVelocity().magnitude;
    const speedFactor = Math.min(speed / 16, 1);

    // Simple PoC signal:
    // - gentle centering spring around helm center
    // - hydrodynamic loading that grows with speed and rudder deflection
    // - light damping from rudder angular velocity
    const centering = driverSteerInput * 0.25;
    const waterLoad = rudderSteer * speedFactor * 0.65;
    const damping = rudderAngularVelocity * 0.06;

    return clamp(-(centering + waterLoad + damping), -1, 1);
  }

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

    // Dock toggle (F key, only when near a port — anchor is now hold-to-use)
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
  }

  @on("destroy")
  onDestroy({ game }: GameEventMap["destroy"]): void {
    game.io.setSteeringWheelForceFeedback(0);
  }
}
