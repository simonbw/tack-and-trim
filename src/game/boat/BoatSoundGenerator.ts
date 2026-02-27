import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { SoundInstance } from "../../core/sound/SoundInstance";
import { clamp } from "../../core/util/MathUtil";
import { rUniform } from "../../core/util/Random";
import type { Boat } from "./Boat";
import type { Sheet } from "./Sheet";

// Minimum time between consecutive sounds from the same source (seconds)
const MIN_SHEET_INTERVAL = 0.15;
const MIN_BOOM_INTERVAL = 0.3;

// Sheet snap thresholds
const SHEET_FORCE_MIN = 1000; // Below this, no sound (filters out constraint bouncing)
const SHEET_FORCE_MAX = 8000; // Above this, max volume

// Boom slam thresholds — force on mainsheet when it catches the boom
const BOOM_FORCE_MIN = 2000; // Below this, no slam sound
const BOOM_FORCE_MAX = 10000; // Above this, max volume

// Volume
const SHEET_MAX_GAIN = 0.4;
const BOOM_MAX_GAIN = 0.6;

/**
 * Plays sheet-snap and boom-slam sounds on the boat.
 *
 * Sheet snap: triggered when a sheet's distance constraint activates
 * (rope goes taut) with sufficient force.
 *
 * Boom slam: triggered when the mainsheet goes taut while the boom
 * has significant angular velocity — the heavy thud of the boom
 * hitting the end of its travel.
 */
export class BoatSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  private sheetStates: Map<Sheet, SheetState> = new Map();
  private lastBoomSlamTime = -Infinity;

  constructor(private boat: Boat) {
    super();
  }

  @on("add")
  onAdd() {
    // Track all sheets on the boat
    this.trackSheet(this.boat.mainsheet);
    if (this.boat.portJibSheet) this.trackSheet(this.boat.portJibSheet);
    if (this.boat.starboardJibSheet)
      this.trackSheet(this.boat.starboardJibSheet);
  }

  private trackSheet(sheet: Sheet) {
    this.sheetStates.set(sheet, {
      wasActive: false,
      lastSnapTime: -Infinity,
    });
  }

  @on("tick")
  onTick({ audioTime }: GameEventMap["tick"]) {
    for (const [sheet, state] of this.sheetStates) {
      this.updateSheet(sheet, state, audioTime);
    }
  }

  private updateSheet(sheet: Sheet, state: SheetState, now: number) {
    // The sheet's constraint equation is enabled when the rope is at its limit
    const constraint = sheet.constraints?.[0];
    if (!constraint) return;

    const equation = constraint.equations[0];
    if (!equation) return;

    const isActive = equation.enabled;
    const force = Math.abs(equation.multiplier);

    // Detect transition from slack to taut
    if (isActive && !state.wasActive && force > SHEET_FORCE_MIN) {
      const isMainsheet = sheet === this.boat.mainsheet;

      // Check if this is a boom slam (mainsheet with high force = boom hit hard)
      if (isMainsheet && force > BOOM_FORCE_MIN) {
        if (now - this.lastBoomSlamTime > MIN_BOOM_INTERVAL) {
          this.playBoomSlam(force, now);
        }
      }

      // Play sheet snap (for any sheet, including mainsheet)
      if (now - state.lastSnapTime > MIN_SHEET_INTERVAL) {
        this.playSheetSnap(sheet, force, now);
        state.lastSnapTime = now;
      }
    }

    state.wasActive = isActive;
  }

  private playSheetSnap(sheet: Sheet, force: number, _now: number) {
    const t = clamp(
      (force - SHEET_FORCE_MIN) / (SHEET_FORCE_MAX - SHEET_FORCE_MIN),
    );
    const gain = t * t * SHEET_MAX_GAIN;

    // Pitch variation: higher force = slightly lower pitch (heavier snap)
    const speed = rUniform(0.9, 1.1) - t * 0.15;

    this.game!.addEntity(new SoundInstance("sheetSnap", { gain, speed }));
  }

  private playBoomSlam(force: number, now: number) {
    this.lastBoomSlamTime = now;

    const t = clamp(
      (force - BOOM_FORCE_MIN) / (BOOM_FORCE_MAX - BOOM_FORCE_MIN),
    );
    const gain = t * BOOM_MAX_GAIN;

    // Higher force = slightly higher pitch (harder impact)
    const speed = rUniform(0.85, 1.0) + t * 0.15;

    this.game!.addEntity(new SoundInstance("boomSlam", { gain, speed }));
  }
}

interface SheetState {
  wasActive: boolean;
  lastSnapTime: number;
}
