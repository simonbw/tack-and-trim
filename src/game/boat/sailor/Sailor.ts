import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { DynamicBody } from "../../../core/physics/body/DynamicBody";
import {
  DeckContactConstraint,
  type HullBoundaryData,
} from "../../../core/physics/constraints/DeckContactConstraint";
import { V, V2d } from "../../../core/Vector";
import type { SailorConfig, StationDef } from "./StationConfig";

const SAILOR_RADIUS = 0.6; // ft — visual radius of the orange circle
const SAILOR_GRAVITY = 32.174; // ft/s² (standard gravity in engine units)
const SAILOR_FRICTION = 20.0; // high friction to track target velocity closely

export type SailorState =
  | { kind: "atStation"; stationId: string }
  | { kind: "walking" };

export class Sailor extends BaseEntity {
  layer = "boat" as const;

  readonly body: DynamicBody;
  private readonly config: SailorConfig;
  private readonly hullBody: DynamicBody;
  private readonly deckConstraint: DeckContactConstraint;
  private readonly deckHeight: number;

  private _state: SailorState;

  constructor(
    config: SailorConfig,
    hullBody: DynamicBody,
    getDeckHeight: (localX: number, localY: number) => number | null,
    hullBoundary: HullBoundaryData,
    deckHeight: number,
  ) {
    super();

    this.config = config;
    this.hullBody = hullBody;
    this.deckHeight = deckHeight;

    // Find the initial station and compute world position
    const initialStation = this.getStation(config.initialStationId);
    const worldPos = this.stationWorldPosition(initialStation);

    // Create the sailor's physics body — a point particle on the deck
    this.body = new DynamicBody({
      mass: config.mass,
      position: [worldPos.x, worldPos.y],
      fixedRotation: true,
      damping: 0.1,
      allowSleep: false,
      sixDOF: {
        rollInertia: 1,
        pitchInertia: 1,
        zMass: config.mass,
        zDamping: 0.9,
        rollPitchDamping: 0,
        zPosition: deckHeight + SAILOR_RADIUS,
      },
    });

    // Create deck contact constraint — keeps sailor on deck, prevents fall-off
    this.deckConstraint = new DeckContactConstraint(
      this.body,
      hullBody,
      getDeckHeight,
      hullBoundary,
      SAILOR_FRICTION,
      SAILOR_RADIUS,
      { collideConnected: true, wakeUpBodies: false },
    );
    this.deckConstraint.preventFallOff = true;

    this.constraints = [this.deckConstraint];

    this._state = { kind: "atStation", stationId: config.initialStationId };
  }

  // ── Public API ──────────────────────────────────────────────────

  get state(): SailorState {
    return this._state;
  }

  /** The current station, or null if walking. */
  getCurrentStation(): StationDef | null {
    if (this._state.kind === "atStation") {
      return this.getStation(this._state.stationId);
    }
    return null;
  }

  /** Whether the sailor is at the given station. */
  isAtStation(id: string): boolean {
    return this._state.kind === "atStation" && this._state.stationId === id;
  }

  /** Leave the current station and begin walking. */
  beginWalking(): void {
    if (this._state.kind === "atStation") {
      const prevStation = this._state.stationId;
      this._state = { kind: "walking" };
      this.game.dispatch("sailorLeftStation", { stationId: prevStation });
    }
  }

  /**
   * Set the walk velocity in hull-local coordinates (ft/s).
   * Only has effect while walking.
   */
  setWalkVelocity(localX: number, localY: number): void {
    if (this._state.kind !== "walking") return;

    // Clamp to walk speed
    const mag = Math.sqrt(localX * localX + localY * localY);
    if (mag > this.config.walkSpeed) {
      const scale = this.config.walkSpeed / mag;
      localX *= scale;
      localY *= scale;
    }

    this.deckConstraint.targetVelocityX = localX;
    this.deckConstraint.targetVelocityY = localY;
  }

  // ── Tick ─────────────────────────────────────────────────────────

  @on("tick")
  onTick(): void {
    // Gravity
    this.body.applyForce3D(0, 0, -SAILOR_GRAVITY * this.body.mass, 0, 0, 0);

    if (this._state.kind === "atStation") {
      // At station — zero the motorized velocity and hold position
      this.deckConstraint.targetVelocityX = 0;
      this.deckConstraint.targetVelocityY = 0;
    }
  }

  /** Return the station within snapRadius of the sailor, or null. */
  findNearbyStation(): StationDef | null {
    const [lx, ly] = this.getLocalPosition();
    const r2 = this.config.snapRadius * this.config.snapRadius;
    for (const station of this.config.stations) {
      const dx = lx - station.position[0];
      const dy = ly - station.position[1];
      if (dx * dx + dy * dy < r2) return station;
    }
    return null;
  }

  /** Snap to a nearby station if one is in range. Does nothing otherwise. */
  snapToNearbyStation(): void {
    if (this._state.kind !== "walking") return;
    const near = this.findNearbyStation();
    if (near) this.snapToStation(near);
  }

  private snapToStation(station: StationDef): void {
    // Snap body position to the station's world position
    const worldPos = this.stationWorldPosition(station);
    this.body.position.set(worldPos);
    this.body.velocity.set(0, 0);
    this.body.zVelocity = 0;

    // Stop motorized friction
    this.deckConstraint.targetVelocityX = 0;
    this.deckConstraint.targetVelocityY = 0;

    this._state = { kind: "atStation", stationId: station.id };
    this.game.dispatch("sailorEnteredStation", { stationId: station.id });
  }

  // ── Rendering ───────────────────────────────────────────────────

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    // Draw in world space without the hull's tilt transform so the sailor
    // always reads as a flat 2D circle regardless of roll/pitch.
    const [px, py] = this.body.position;
    draw.fillCircle(px, py, SAILOR_RADIUS, {
      color: 0xff8800,
      z: this.body.z,
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private getStation(id: string): StationDef {
    const station = this.config.stations.find((s) => s.id === id);
    if (!station) {
      throw new Error(`Unknown station: ${id}`);
    }
    return station;
  }

  private stationWorldPosition(station: StationDef): V2d {
    return this.hullBody.toWorldFrame(
      V(station.position[0], station.position[1]),
    );
  }

  /** Get the sailor's hull-local position. */
  getLocalPosition(): [number, number] {
    const [lx, ly] = this.hullBody.toLocalFrame3D(
      this.body.position[0],
      this.body.position[1],
      this.body.z,
    );
    return [lx, ly];
  }

  /**
   * Restore sailor state from a save file.
   * If stationId is non-null, snaps to that station.
   * Otherwise, places the sailor at the given hull-local position in walking mode.
   */
  restoreState(stationId: string | null, position: [number, number]): void {
    if (stationId) {
      const station = this.config.stations.find((s) => s.id === stationId);
      if (station) {
        const worldPos = this.stationWorldPosition(station);
        this.body.position.set(worldPos);
        this.body.velocity.set(0, 0);
        this.body.zVelocity = 0;
        this._state = { kind: "atStation", stationId };
        return;
      }
    }

    // Walking or unknown station — place at position
    const [wx, wy] = this.hullBody.toWorldFrame3D(position[0], position[1], 0);
    this.body.position.set(wx, wy);
    this.body.velocity.set(0, 0);
    this.body.zVelocity = 0;
    this._state = { kind: "walking" };
  }
}
