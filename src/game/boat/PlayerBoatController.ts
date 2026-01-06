import BaseEntity from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { Boat } from "./Boat";

/**
 * Maps player input to boat actions.
 * Separating this from Boat allows for AI-controlled boats, network boats, etc.
 */
export class PlayerBoatController extends BaseEntity {
  constructor(private boat: Boat) {
    super();
  }

  onTick(dt: GameEventMap["tick"]) {
    const io = this.game!.io;

    // Handle continuous input
    const [steer, sheet] = io.getMovementVector();
    const shiftHeld = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");

    // Update rudder steering (A/D or left/right arrows)
    this.boat.steer(steer, dt, shiftHeld);

    // Update mainsheet (W = trim in, S = ease out)
    this.boat.adjustMainsheet(-sheet, dt, shiftHeld);

    // Jib sheet controls - single active sheet model
    // Q/E meaning depends on which sheet is active:
    //   Port active: Q = ease out, E = trim in
    //   Starboard active: Q = trim in, E = ease out
    // SHIFT + Q/E = switch sheets (tack)
    const qHeld = io.isKeyDown("KeyQ");
    const eHeld = io.isKeyDown("KeyE");

    // Calculate trim input based on active sheet
    const activeSheet = this.boat.getActiveJibSheet();
    let trimInput = 0;
    if (activeSheet === "port") {
      if (eHeld) trimInput = -1; // E = trim in (port)
      else if (qHeld) trimInput = 1; // Q = ease out
    } else {
      if (qHeld) trimInput = -1; // Q = trim in (starboard)
      else if (eHeld) trimInput = 1; // E = ease out
    }

    // Handle tacking (switching sheets)
    if (shiftHeld) {
      // Shift+Q/E explicitly switches sheets
      if (qHeld) {
        this.boat.tackJib("starboard");
      } else if (eHeld) {
        this.boat.tackJib("port");
      }
    } else if (trimInput > 0 && this.boat.isActiveJibSheetAtMax()) {
      // Auto-switch when trying to ease out a fully slack sheet
      const newSheet = activeSheet === "port" ? "starboard" : "port";
      this.boat.tackJib(newSheet);
    }

    this.boat.adjustJibSheet(trimInput, dt, shiftHeld);
  }

  onKeyDown({ key }: GameEventMap["keyDown"]) {
    // Row the boat
    if (key === "Space") {
      this.boat.row();
    }

    // Toggle sails hoisted/lowered
    if (key === "KeyR") {
      this.boat.toggleSails();
    }

    // Toggle anchor
    if (key === "KeyF") {
      this.boat.toggleAnchor();
    }
  }
}
