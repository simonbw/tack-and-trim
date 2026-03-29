import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
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
    if (this.game.entities.tryGetSingleton(PortMenu)) return;

    // Boat is sinking — no controls
    if (this.boat.bilge.isSinking()) {
      this.boat.bilge.setBailing(false);
      return;
    }

    // Bailing — B key locks out all other controls
    const bailing =
      io.isKeyDown("KeyB") && this.boat.bilge.getWaterFraction() > 0;
    this.boat.bilge.setBailing(bailing);
    if (bailing) return;

    // Handle continuous input
    const [steer, sheet] = io.getMovementVector();
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    // Update rudder steering (A/D or left/right arrows)
    this.boat.rudder.setSteer(steer, shiftHeld);

    // Update mainsheet (W = trim in, S = ease out)
    const mainsheetDt = shiftHeld ? dt * 2.5 : dt;
    this.boat.mainsheet.adjust(-sheet, mainsheetDt);

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

      // Jib sheet speed: normal = 0.5x, fast = 1x
      const jibDt = shiftHeld ? dt : dt * 0.5;
      activeSheet.adjust(trimInput, jibDt);
    }

    if (io.isKeyDown("Space")) {
      this.boat.row();
    }

    // Debug: apply heeling forces with [ and ]
    // Apply roll torque by pushing up on one side of the hull
    if (io.isKeyDown("BracketLeft")) {
      this.boat.hull.body.applyForce3D(0, 0, 20000, 0, 3, 0);
    }
    if (io.isKeyDown("BracketRight")) {
      this.boat.hull.body.applyForce3D(0, 0, -20000, 0, 3, 0);
    }
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
    // No actions while port menu is open or sinking
    if (this.game.entities.tryGetSingleton(PortMenu)) return;
    if (this.boat.bilge.isSinking()) return;

    // Toggle sails hoisted/lowered
    if (key === "KeyR") {
      this.boat.toggleSails();
    }

    // Dock / anchor toggle
    if (key === "KeyF") {
      if (this.boat.mooring.isMoored()) {
        this.boat.mooring.castOff();
      } else {
        const nearbyPort = this.findNearbyPort();
        if (nearbyPort) {
          this.boat.mooring.moorTo(nearbyPort);
        } else {
          this.boat.anchor.toggle();
        }
      }
    }
  }
}
