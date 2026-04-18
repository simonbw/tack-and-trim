import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Body } from "../../../core/physics/body/Body";
import { createPointMass3D } from "../../../core/physics/body/bodyFactories";
import { type HullBoundaryData } from "../../../core/physics/constraints/DeckContactConstraint";
import { PointToRigidLockConstraint3D } from "../../../core/physics/constraints/PointToRigidLockConstraint3D";
import { SailorDeckConstraint } from "../../../core/physics/constraints/SailorDeckConstraint";
import { V, V2d } from "../../../core/Vector";
import { V3d } from "../../../core/Vector3";
import type { StationDef } from "./StationConfig";

/** Sailor mass in lbs — average adult. Affects boat balance via deck constraint reaction. */
export const SAILOR_MASS = 170;

/** Walking speed in ft/s — cautious walking on a moving boat. */
export const SAILOR_WALK_SPEED = 4;
/** Running speed in ft/s — hustling when Shift is held. */
export const SAILOR_RUN_SPEED = 8;
/** Proximity radius (ft) for snapping to a station on arrival. */
export const SAILOR_SNAP_RADIUS = 2.5;

const SAILOR_RADIUS = 0.8; // ft — visual radius of the orange circle
const SAILOR_GRAVITY = 32.174; // ft/s² (standard gravity in engine units)
const SAILOR_FRICTION = 20.0; // high friction to track target velocity closely
/**
 * Cap on the deck-normal reaction force (in force units, measured as
 * multiples of the sailor's weight). The normal equation stays stiff so
 * the sailor rests on the deck without sagging, but bounding the force
 * means a sudden deck-height discontinuity produces a manageable impulse
 * on the hull instead of yanking the ship downward.
 */
const SAILOR_NORMAL_FORCE_CAP = 4; // × sailor weight

/**
 * Cap on the station weld's max force per axis (× sailor weight). Bounds
 * the impulse if the sailor happens to activate with a nonzero position
 * error and limits how hard the weld can yank the hull.
 */
const SAILOR_WELD_FORCE_CAP = 8; // × sailor weight
/**
 * Relaxation for the station weld's three axis equations. The weld is a
 * full 3-axis position lock, so radial and tangential motion both settle
 * naturally; default-ish relaxation is sufficient.
 */
const SAILOR_WELD_RELAXATION = 6;
/**
 * Seconds to slide the weld's hull-local anchor from the sailor's entry
 * position to the actual station position. The constraint stays stiff
 * throughout; only the target moves, so the sailor tracks it without a
 * large position-error impulse at activation.
 */
const SAILOR_WELD_RAMP_DURATION = 0.3;

export type SailorState =
  | { kind: "atStation"; stationId: string }
  | { kind: "walking" };

export class Sailor extends BaseEntity {
  layer = "boat" as const;

  readonly body: Body;
  private readonly stations: readonly StationDef[];
  private readonly hullBody: Body;
  private readonly deckConstraint: SailorDeckConstraint;
  /** 3-axis position lock to the current station. Disabled while walking. */
  private readonly stationWeld: PointToRigidLockConstraint3D;
  private readonly deckHeight: number;

  private _state: SailorState;
  /**
   * Ramp progress [0, 1] for sliding the weld's hull-local anchor from the
   * sailor's entry position toward the station's actual position. 1 = anchor
   * fully at the station. Reset to 0 on station entry and advances each tick
   * while stationed.
   */
  private _weldRampT: number = 1;
  /** Hull-local anchor position at activation (start of the slide). */
  private readonly _weldRampStart: V3d = new V3d(0, 0, 0);
  /** Hull-local anchor position at the station (end of the slide). */
  private readonly _weldRampTarget: V3d = new V3d(0, 0, 0);

  constructor(
    stations: readonly StationDef[],
    initialStationId: string,
    hullBody: Body,
    getDeckHeight: (localX: number, localY: number) => number | null,
    hullBoundary: HullBoundaryData,
    deckHeight: number,
  ) {
    super();

    this.stations = stations;
    this.hullBody = hullBody;
    this.deckHeight = deckHeight;

    // Find the initial station and compute world position
    const initialStation = this.getStation(initialStationId);
    const worldPos = this.stationWorldPosition(initialStation);

    // Create the sailor's physics body — a point particle on the deck
    this.body = createPointMass3D({
      motion: "dynamic",
      mass: SAILOR_MASS,
      position: [worldPos.x, worldPos.y],
      damping: 0.1,
      allowSleep: false,
      zMass: SAILOR_MASS,
      zDamping: 0.9,
      z: deckHeight + SAILOR_RADIUS,
    });

    // Create deck contact constraint — keeps sailor on deck with a
    // vertex-aware inward wall that prevents walking off the edge.
    this.deckConstraint = new SailorDeckConstraint(
      this.body,
      hullBody,
      getDeckHeight,
      hullBoundary,
      SAILOR_FRICTION,
      SAILOR_RADIUS,
      SAILOR_RADIUS,
      { collideConnected: true, wakeUpBodies: false },
    );

    // Cap the normal equation's max force so sudden deck-height
    // discontinuities don't jerk the hull. Steady-state support (gravity)
    // sits well below the cap, so normal behavior is unaffected. Friction
    // is decoupled from the (now-bounded) normal multiplier so lateral
    // grip stays firm regardless of transient normal dips.
    const sailorWeight = SAILOR_MASS * SAILOR_GRAVITY;
    this.deckConstraint.equations[0].maxForce =
      sailorWeight * SAILOR_NORMAL_FORCE_CAP;
    this.deckConstraint.fixedFrictionForce = sailorWeight * SAILOR_FRICTION;

    // 3-axis position lock that holds the sailor at a station's hull-local
    // anchor while stationed. Disabled while walking. The per-axis maxForce
    // cap bounds activation impulses and limits how hard the weld can yank
    // the hull.
    this.stationWeld = new PointToRigidLockConstraint3D(this.body, hullBody, {
      localAnchorB: [
        initialStation.position[0],
        initialStation.position[1],
        deckHeight + SAILOR_RADIUS,
      ],
      maxForce: sailorWeight * SAILOR_WELD_FORCE_CAP,
      collideConnected: true,
      wakeUpBodies: false,
    });
    for (const eq of this.stationWeld.equations) {
      eq.relaxation = SAILOR_WELD_RELAXATION;
      eq.needsUpdate = true;
    }

    // Start pinned to the initial station: deck constraint off, weld on.
    this.deckConstraint.disabled = true;
    this.stationWeld.disabled = false;

    this.constraints = [this.deckConstraint, this.stationWeld];

    this._state = { kind: "atStation", stationId: initialStationId };
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
      this.deckConstraint.disabled = false;
      this.stationWeld.disabled = true;
      this.game.dispatch("sailorLeftStation", { stationId: prevStation });
    }
  }

  /**
   * Set the walk velocity in hull-local coordinates (ft/s), clamped to
   * `maxSpeed` by magnitude. Only has effect while walking.
   */
  setWalkVelocity(localX: number, localY: number, maxSpeed: number): void {
    if (this._state.kind !== "walking") return;

    const mag = Math.sqrt(localX * localX + localY * localY);
    if (mag > maxSpeed) {
      const scale = maxSpeed / mag;
      localX *= scale;
      localY *= scale;
    }

    this.deckConstraint.targetVelocityX = localX;
    this.deckConstraint.targetVelocityY = localY;
  }

  // ── Tick ─────────────────────────────────────────────────────────

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    // Gravity always acts on the sailor body. When stationed, the 3-axis
    // station weld resists gravity and transfers the reaction to the hull
    // at the station anchor. When walking, the deck constraint handles it.
    this.body.applyForce3D(0, 0, -SAILOR_GRAVITY * this.body.mass, 0, 0, 0);
    if (this._state.kind === "atStation") {
      this.deckConstraint.targetVelocityX = 0;
      this.deckConstraint.targetVelocityY = 0;
      this.advanceWeldRamp(dt);
    }
  }

  private advanceWeldRamp(dt: number): void {
    if (this._weldRampT >= 1) return;
    this._weldRampT = Math.min(
      1,
      this._weldRampT + dt / SAILOR_WELD_RAMP_DURATION,
    );
    // Smoothstep ease so the anchor accelerates in and decelerates out.
    const t = this._weldRampT;
    const eased = t * t * (3 - 2 * t);
    const start = this._weldRampStart;
    const target = this._weldRampTarget;
    this.stationWeld.localAnchorB[0] =
      start[0] + (target[0] - start[0]) * eased;
    this.stationWeld.localAnchorB[1] =
      start[1] + (target[1] - start[1]) * eased;
    this.stationWeld.localAnchorB[2] =
      start[2] + (target[2] - start[2]) * eased;
  }

  /**
   * Kick off a fresh pull-in ramp toward the given station. Snapshots the
   * sailor's current hull-local 3D position as the slide's start so the
   * weld activates with zero position error, then lerps the anchor over
   * `SAILOR_WELD_RAMP_DURATION` to the station's actual local position.
   */
  private beginWeldRamp(station: StationDef): void {
    const localStart = this.hullBody.toLocalFrame3D(
      this.body.position[0],
      this.body.position[1],
      this.body.z,
    );
    this._weldRampStart.set(localStart[0], localStart[1], localStart[2]);
    this._weldRampTarget.set(
      station.position[0],
      station.position[1],
      this.deckHeight + SAILOR_RADIUS,
    );
    this.stationWeld.localAnchorB.set(
      this._weldRampStart[0],
      this._weldRampStart[1],
      this._weldRampStart[2],
    );
    this._weldRampT = 0;
    for (const eq of this.stationWeld.equations) {
      eq.warmLambda = 0;
      eq.multiplier = 0;
    }
  }

  /** Return the station within snapRadius of the sailor, or null. */
  findNearbyStation(): StationDef | null {
    const [lx, ly] = this.getLocalPosition();
    const r2 = SAILOR_SNAP_RADIUS * SAILOR_SNAP_RADIUS;
    for (const station of this.stations) {
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
    // Switch from walking to the station weld. No position/velocity
    // teleport — the ramped weld slides the anchor from the sailor's
    // current spot to the station, dragging them along smoothly.
    this.deckConstraint.targetVelocityX = 0;
    this.deckConstraint.targetVelocityY = 0;
    this.deckConstraint.disabled = true;
    this.stationWeld.disabled = false;
    this.beginWeldRamp(station);

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
    const station = this.stations.find((s) => s.id === id);
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
      const station = this.stations.find((s) => s.id === stationId);
      if (station) {
        const worldPos = this.stationWorldPosition(station);
        this.body.position.set(worldPos);
        this.body.velocity.set(0, 0);
        this.body.zVelocity = 0;
        this.deckConstraint.disabled = true;
        this.stationWeld.localAnchorB.set(
          station.position[0],
          station.position[1],
          this.deckHeight + SAILOR_RADIUS,
        );
        this.stationWeld.disabled = false;
        // Load fully pinned — no pull-in animation on a fresh game.
        this._weldRampT = 1;
        this._weldRampStart.set(this.stationWeld.localAnchorB);
        this._weldRampTarget.set(this.stationWeld.localAnchorB);
        for (const eq of this.stationWeld.equations) {
          eq.warmLambda = 0;
          eq.multiplier = 0;
        }
        this._state = { kind: "atStation", stationId };
        return;
      }
    }

    // Walking or unknown station — place at position
    const [wx, wy] = this.hullBody.toWorldFrame3D(position[0], position[1], 0);
    this.body.position.set(wx, wy);
    this.body.velocity.set(0, 0);
    this.body.zVelocity = 0;
    this.deckConstraint.disabled = false;
    this.stationWeld.disabled = true;
    this._state = { kind: "walking" };
  }
}
