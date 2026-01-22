import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { V } from "../../core/Vector";
import { MooringLine } from "../MooringLine";
import { MooringPoint, MOORING_RANGE } from "../MooringPoint";
import { Boat } from "./Boat";

/**
 * Maps player input to boat actions.
 * Separating this from Boat allows for AI-controlled boats, network boats, etc.
 */
export class PlayerBoatController extends BaseEntity {
  tickLayer = "input" as const;
  private activeJibSheet: "port" | "starboard" = "port";
  private activeMooringLine: MooringLine | null = null;

  constructor(private boat: Boat) {
    super();
  }

  /** Find the nearest mooring point within range, if any */
  private findNearestMooringPoint(): MooringPoint | null {
    const boatPos = V(this.boat.hull.body.position);
    let nearest: MooringPoint | null = null;
    let nearestDistance = MOORING_RANGE;

    for (const entity of this.game!.entities.getTagged("mooringPoint")) {
      const mooringPoint = entity as MooringPoint;
      const distance = boatPos.sub(mooringPoint.getPosition()).magnitude;
      if (distance < nearestDistance) {
        nearest = mooringPoint;
        nearestDistance = distance;
      }
    }

    return nearest;
  }

  /** Engage mooring to a mooring point */
  private engageMooring(mooringPoint: MooringPoint): void {
    // Don't engage if already moored or anchor is out
    if (this.activeMooringLine || this.boat.anchor.isDeployed()) {
      return;
    }

    this.activeMooringLine = new MooringLine(this.boat, mooringPoint);
    this.game!.addEntity(this.activeMooringLine);
  }

  /** Release the current mooring line */
  private releaseMooring(): void {
    if (this.activeMooringLine) {
      this.activeMooringLine.release();
      this.activeMooringLine = null;
    }
  }

  /** Check if currently moored */
  isMoored(): boolean {
    return this.activeMooringLine !== null && !this.activeMooringLine.isReleasing();
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const io = this.game.io;

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
  }

  @on("keyDown")
  onKeyDown({ key }: GameEventMap["keyDown"]) {
    // Toggle sails hoisted/lowered
    if (key === "KeyR") {
      this.boat.toggleSails();
    }

    // Toggle anchor or mooring
    if (key === "KeyF") {
      // If currently moored, release the mooring line
      if (this.activeMooringLine) {
        this.releaseMooring();
        return;
      }

      // If anchor is deployed, retrieve it
      if (this.boat.anchor.isDeployed()) {
        this.boat.anchor.toggle();
        return;
      }

      // Check for nearby mooring point
      const nearestMooring = this.findNearestMooringPoint();
      if (nearestMooring) {
        // Engage mooring to the nearest point
        this.engageMooring(nearestMooring);
      } else {
        // No mooring point nearby, drop anchor instead
        this.boat.anchor.toggle();
      }
    }
  }
}
