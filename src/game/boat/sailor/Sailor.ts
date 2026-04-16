import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { DynamicBody } from "../../../core/physics/body/DynamicBody";
import {
  DeckContactConstraint,
  type HullBoundaryData,
} from "../../../core/physics/constraints/DeckContactConstraint";
import { PointToRigidDistanceConstraint3D } from "../../../core/physics/constraints/PointToRigidDistanceConstraint3D";
import { V, V2d } from "../../../core/Vector";
import type { SailorConfig, StationDef } from "./StationConfig";

const SAILOR_RADIUS = 0.6; // ft — visual radius of the orange circle
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
 * Cap on the station weld's max force (× sailor weight). Bounds the
 * impulse if the sailor happens to activate with a nonzero position error.
 */
const SAILOR_WELD_FORCE_CAP = 8; // × sailor weight
/**
 * Damping ratio for the station weld. Higher than the default 4 so any
 * residual oscillation after activation dies out quickly.
 */
const SAILOR_WELD_RELAXATION = 16;
/**
 * Seconds to ramp the weld's target distance from the initial separation
 * down to zero on station entry. The constraint stays stiff throughout;
 * the target moves smoothly so the sailor tracks it without a big error
 * impulse at activation.
 */
const SAILOR_WELD_RAMP_DURATION = 0.3;

export type SailorState =
  | { kind: "atStation"; stationId: string }
  | { kind: "walking" };

export class Sailor extends BaseEntity {
  layer = "boat" as const;

  readonly body: DynamicBody;
  private readonly config: SailorConfig;
  private readonly hullBody: DynamicBody;
  private readonly deckConstraint: DeckContactConstraint;
  /** Zero-distance weld to the current station. Disabled while walking. */
  private readonly stationWeld: PointToRigidDistanceConstraint3D;
  private readonly deckHeight: number;

  private _state: SailorState;
  /**
   * Ramp progress [0, 1] for the station weld's target distance.
   * 1 = target fully at zero (sailor pinned to anchor). Reset to 0 on
   * station entry and advances each tick while stationed.
   */
  private _weldRampT: number = 1;
  /** Initial separation at the moment of weld activation (ft). */
  private _weldRampStartDistance: number = 0;

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

    // Cap the normal equation's max force so sudden deck-height
    // discontinuities don't jerk the hull. Steady-state support (gravity)
    // sits well below the cap, so normal behavior is unaffected. Friction
    // is decoupled from the (now-bounded) normal multiplier so lateral
    // grip stays firm regardless of transient normal dips.
    const sailorWeight = config.mass * SAILOR_GRAVITY;
    this.deckConstraint.equations[0].maxForce =
      sailorWeight * SAILOR_NORMAL_FORCE_CAP;
    this.deckConstraint.fixedFrictionForce = sailorWeight * SAILOR_FRICTION;

    // Zero-distance weld that holds the sailor at a station's hull-local
    // position while stationed. Disabled while walking. maxForce cap keeps
    // an activation with residual position error from spiking the hull.
    this.stationWeld = new PointToRigidDistanceConstraint3D(
      this.body,
      hullBody,
      {
        distance: 0,
        localAnchorB: [
          initialStation.position[0],
          initialStation.position[1],
          deckHeight + SAILOR_RADIUS,
        ],
        maxForce: sailorWeight * SAILOR_WELD_FORCE_CAP,
        collideConnected: true,
        wakeUpBodies: false,
      },
    );
    // Over-damp the weld so any residual error settles without ringing.
    const weldEq = this.stationWeld.equations[0];
    weldEq.relaxation = SAILOR_WELD_RELAXATION;
    weldEq.needsUpdate = true;

    // Start pinned to the initial station: deck constraint off, weld on.
    this.deckConstraint.disabled = true;
    this.stationWeld.disabled = false;

    this.constraints = [this.deckConstraint, this.stationWeld];

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
    // Gravity always acts on the sailor body. When stationed, the zero-
    // distance weld resists gravity and transfers the reaction to the hull
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
    // Smoothstep ease so the target accelerates in and decelerates out.
    const t = this._weldRampT;
    const eased = t * t * (3 - 2 * t);
    this.stationWeld.distance = this._weldRampStartDistance * (1 - eased);
  }

  /**
   * Kick off a fresh pull-in ramp. Captures the current 3D separation
   * between body and anchor so the target distance can decay smoothly
   * from there to 0, avoiding a large initial position error.
   */
  private beginWeldRamp(): void {
    const [ax, ay, az] = this.hullBody.toWorldFrame3D(
      this.stationWeld.localAnchorB[0],
      this.stationWeld.localAnchorB[1],
      this.stationWeld.localAnchorB[2],
    );
    const dx = this.body.position[0] - ax;
    const dy = this.body.position[1] - ay;
    const dz = this.body.z - az;
    this._weldRampStartDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this._weldRampT = 0;
    this.stationWeld.distance = this._weldRampStartDistance;
    const weldEq = this.stationWeld.equations[0];
    weldEq.warmLambda = 0;
    weldEq.multiplier = 0;
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
    // Switch from walking to the station weld. No position/velocity
    // teleport — the ramped weld pulls the sailor to the anchor
    // smoothly from wherever they currently are.
    this.deckConstraint.targetVelocityX = 0;
    this.deckConstraint.targetVelocityY = 0;
    this.deckConstraint.disabled = true;
    this.stationWeld.localAnchorB.set(
      station.position[0],
      station.position[1],
      this.deckHeight + SAILOR_RADIUS,
    );
    this.stationWeld.disabled = false;
    this.beginWeldRamp();

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
        this.deckConstraint.disabled = true;
        this.stationWeld.localAnchorB.set(
          station.position[0],
          station.position[1],
          this.deckHeight + SAILOR_RADIUS,
        );
        this.stationWeld.disabled = false;
        // Load fully pinned — no pull-in animation on a fresh game.
        this._weldRampT = 1;
        this.stationWeld.distance = 0;
        const weldEq = this.stationWeld.equations[0];
        weldEq.warmLambda = 0;
        weldEq.multiplier = 0;
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
