import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Body } from "../../../core/physics/body/Body";
import { createPointMass3D } from "../../../core/physics/body/bodyFactories";
import { PointToRigidLockConstraint3D } from "../../../core/physics/constraints/PointToRigidLockConstraint3D";
import { clamp } from "../../../core/util/MathUtil";
import {
  asyncProfiler,
  type AsyncOperationToken,
} from "../../../core/util/AsyncProfiler";
import { V, V2d } from "../../../core/Vector";
import { TimeOfDay } from "../../time/TimeOfDay";
import { WindQuery } from "../../world/wind/WindQuery";
import { ClothRenderer } from "./ClothRenderer";
import { ClothSolver } from "./ClothSolver";
import { ClothWorkerPool, type SailHandle } from "./ClothWorkerPool";
import {
  REACTION_TACK_X,
  REACTION_TACK_Y,
  REACTION_TACK_Z,
  REACTION_HEAD_X,
  REACTION_HEAD_Y,
  REACTION_HEAD_Z,
  REACTION_CLEW_X,
  REACTION_CLEW_Y,
  REACTION_CLEW_Z,
  type FurlMode,
} from "./cloth-worker-protocol";
import { generateSailMesh, SailMeshData } from "./SailMesh";
import { TellTail } from "./TellTail";

//#tunable { min: 1, max: 100, step: 1 }
let CLOTH_ITERATIONS: number = 20;

//#tunable { min: 1, max: 16, step: 1 }
let CLOTH_SUBSTEPS: number = 4;

//#tunable { min: 0, max: 1, step: 0.01 }
let CONSTRAINT_DAMPING: number = 0.2;

//#tunable { min: 0.1, max: 50 }
let CLOTH_MASS: number = 8.0;

// Optional config with defaults (see DEFAULT_CONFIG below for typical values)
export interface SailConfig {
  /** lbs, mass per cloth node for inertia scaling. Typical 0.5-2.0. */
  nodeMass: number;
  /** dimensionless, multiplier on aerodynamic lift force. Default 1.0. */
  liftScale: number;
  /** dimensionless, multiplier on aerodynamic drag force. Default 1.0. */
  dragScale: number;
  sailShape: "boom" | "triangle";
  /** fraction/s, rate at which sail hoists/lowers (0-1 range per second). Typical 0.3-0.6. */
  hoistSpeed: number;
  /** hex RGB, sail cloth color. */
  color: number;
  attachTellTail: boolean;
  /** count, number of cloth columns along the foot (chord). Typical 16-48. */
  clothColumns: number;
  /** count, number of cloth rows along the luff (height). Typical 8-24. */
  clothRows: number;
  /** dimensionless, Verlet velocity damping factor (0-1). Higher = more damping. Default 1.0. */
  clothDamping: number;
  /** count, constraint solver iterations per substep. Higher = stiffer cloth. Typical 5-20. */
  clothIterations: number;
  /** dimensionless, correction factor for bend constraints (0-1). Higher = stiffer. Default 0.3. */
  bendStiffness: number;
  /** dimensionless, damping of relative velocity along constraints (0-1). Default 0.1. */
  constraintDamping: number;
  /** ft above waterline, z-height of the sail foot (boom). Typical 2-5. */
  zFoot: number;
  /** ft above waterline, z-height of the sail head (masthead). Typical 15-40. */
  zHead: number;
}

// Required params (no defaults)
export interface SailParams {
  getHeadPosition: () => V2d; // Called each frame - head moves with boat
  headLocalPosition: V2d; // Boat-local XY of the luff base (tack end)
  /** Boat-local XY of the luff top (masthead). Defaults to headLocalPosition
   *  (correct for mainsails where the luff runs vertically up the mast).
   *  For jibs, set this to the mast position so the luff runs diagonally
   *  from bowsprit to masthead along the forestay. */
  luffTopLocalPosition?: V2d;
  headConstraint: { body: Body; localAnchor: V2d };
  getClewPosition?: () => V2d; // Called each frame for constrained clews
  initialClewPosition?: V2d; // Only used once during construction
  clewConstraint?: { body: Body; localAnchor: V2d };
  getHullBody?: () => Body;
}

const DEFAULT_CONFIG: SailConfig = {
  nodeMass: 1.0,
  liftScale: 1.0,
  dragScale: 1.0,
  sailShape: "boom",
  hoistSpeed: 0.4,
  color: 0xeeeeff,
  attachTellTail: true,
  clothColumns: 32,
  clothRows: 16,
  clothDamping: 1.0,
  clothIterations: 10,
  bendStiffness: 0.3,
  constraintDamping: 0.1,
  zFoot: 3,
  zHead: 20,
};

export class Sail extends BaseEntity {
  layer = "boat" as const;
  tickLayer = "sail" as const;
  tags = ["sail"];

  // Keep bodies/constraints for jib clew coupling (single Body for sheets)
  bodies: Body[];
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Hoist state (0 = fully furled, 1 = fully deployed)
  hoistAmount: number = 0;
  private hoistDirection: -1 | 0 | 1 = 0;

  // Cloth simulation
  private mesh: SailMeshData;
  private solver: ClothSolver; // Kept for initial setup; worker takes over after onAdd
  private handle!: SailHandle;
  private clothRenderer: ClothRenderer;

  // Pin vertex indices
  private tackIdx: number;
  private clewIdx: number;
  private headIdx: number;

  // Mesh topology for furling
  private readonly vertexU: Float64Array;
  private readonly vertexV: Float64Array;
  private readonly vertexChordFrac: Float64Array;
  private readonly furlMode: FurlMode;
  private readonly vertexActive: Uint8Array;

  // Wind query for aerodynamic forces
  private windQuery: WindQuery;

  /**
   * Lock constraint pinning the jib clew body to a hull-local anchor when
   * the sail is fully furled. Replaces the previous kinematic teleport:
   * with this in place, any force applied to the clew body (e.g., jib-sheet
   * tension) is transmitted to the hull via the constraint's solver
   * equations rather than absorbed silently.
   *
   * Null for mainsail (boom-clew) or any non-jib config. Disabled while
   * hoisted so the cloth-sim reactions own the clew position.
   */
  private furledLock: PointToRigidLockConstraint3D | null = null;

  private config: SailParams & SailConfig;

  // Cached geometry for mapping UV to world
  private headPos = V(0, 0);
  private clewPos = V(0, 0);

  // Pre-allocated buffers for furled sail line quad rendering
  private readonly furlQuadVerts: [number, number][] = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  private readonly furlQuadZ: number[] = [0, 0, 0, 0];
  private static readonly FURL_QUAD_INDICES = [0, 1, 2, 0, 2, 3];

  constructor(config: SailParams & Partial<SailConfig>) {
    super();

    this.config = { ...DEFAULT_CONFIG, ...config };

    const {
      getHeadPosition,
      initialClewPosition,
      getClewPosition,
      clothColumns,
      clothRows,
      clothDamping,
      clothIterations,
      bendStiffness,
      zFoot,
      zHead,
      sailShape,
      attachTellTail,
    } = this.config;

    // Generate mesh
    const taperFactor = 1.0;
    this.mesh = generateSailMesh({
      footColumns: clothColumns,
      luffRows: clothRows,
      taperFactor,
      zFoot,
      zHead,
    });

    // Extract per-vertex UV from mesh for furling
    this.vertexU = new Float64Array(this.mesh.vertexCount);
    this.vertexV = new Float64Array(this.mesh.vertexCount);
    this.vertexChordFrac = new Float64Array(this.mesh.vertexCount);
    const footColCount = this.mesh.colCounts[0];
    for (let j = 0; j < this.mesh.colCounts.length; j++) {
      const cf = (this.mesh.colCounts[j] - 1) / Math.max(1, footColCount - 1);
      const start = this.mesh.rowStarts[j];
      for (let c = 0; c < this.mesh.colCounts[j]; c++) {
        this.vertexChordFrac[start + c] = cf;
      }
    }
    for (let i = 0; i < this.mesh.vertexCount; i++) {
      this.vertexU[i] = this.mesh.restPositions[i * 2];
      this.vertexV[i] = this.mesh.restPositions[i * 2 + 1];
    }
    this.furlMode = sailShape === "boom" ? "v-cutoff" : "u-wrap";
    this.vertexActive = new Uint8Array(this.mesh.vertexCount);

    // Create cloth solver (used for initial position computation, then handed off)
    this.solver = new ClothSolver(this.mesh, {
      damping: clothDamping,
      constraintIterations: clothIterations,
      bendStiffness,
      constraintDamping: this.config.constraintDamping,
    });

    // Create cloth renderer
    this.clothRenderer = new ClothRenderer(
      this.mesh.vertexCount,
      this.mesh.indices,
    );

    // Initialize cloth positions in world space
    const head = getHeadPosition();
    const initialClew = initialClewPosition ?? getClewPosition?.() ?? head;
    this.headPos.set(head);
    this.clewPos.set(initialClew);

    const worldX = new Float64Array(this.mesh.vertexCount);
    const worldY = new Float64Array(this.mesh.vertexCount);
    const worldZ = new Float64Array(this.mesh.vertexCount);
    // Initialize at full height so rest lengths match the hoisted sail shape
    this.mapUVToWorld(head, initialClew, worldX, worldY, worldZ);
    this.solver.initializePositions(worldX, worldY, worldZ);
    // Collapse to lowered state — all Z at zFoot, XY along the boom.
    // Rest lengths are preserved, so constraints will pull the cloth
    // into the correct shape as the head pin rises during hoisting.
    worldZ.fill(zFoot);
    this.solver.resetPositions(worldX, worldY, worldZ);

    // Pin all luff vertices to the mast/forestay
    this.tackIdx = this.mesh.footVertices[0]; // (u=0, v=0)
    this.clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1]; // (u=1, v=0)
    this.headIdx = this.mesh.luffVertices[this.mesh.luffVertices.length - 1]; // (u=0, v=1)
    for (const luffIdx of this.mesh.luffVertices) {
      this.solver.setPinned(luffIdx, true);
    }
    if (sailShape === "boom") {
      // Mainsail: clew pinned to boom end
      this.solver.setPinned(this.clewIdx, true);
    }

    // For jib: create a 6DOF Body for the clew (last vertex of foot row)
    // to couple with 3D sheet constraints. The clew is pinned in the cloth sim
    // and reaction forces are applied to this body, creating two-way coupling.
    if (sailShape === "triangle") {
      const clewVertexIdx =
        this.mesh.footVertices[this.mesh.footVertices.length - 1];
      const cx = this.solver.getPositionX(clewVertexIdx);
      const cy = this.solver.getPositionY(clewVertexIdx);

      // Mass is set high enough to stabilize the two-way coupling with the
      // cloth sim (reaction forces feed back with a one-frame delay).
      const clewMass = 5;
      const clewBody = createPointMass3D({
        motion: "dynamic",
        mass: clewMass,
        position: [cx, cy],
        damping: 0.9,
        collisionResponse: false,
        allowSleep: false,
        zMass: clewMass,
        z: zFoot,
        zDamping: 0.9,
      });
      // No collision shape — the clew body is inside the hull polygon
      // and would collide with it. It only needs to participate in
      // constraint solving and force application.

      this.bodies = [clewBody];
      this.constraints = [];

      // Furled-state pin: when the jib is rolled up, the clew sits at the
      // forestay alongside the head. Modelled as a PointToRigidLock that
      // stays disabled while hoisted (cloth sim owns the clew then) and
      // enables once hoistAmount drops to zero. Using a real constraint
      // here — rather than a kinematic teleport — means rope forces on the
      // clew body round-trip through the solver into the hull at the pin's
      // lever arm, preserving Newton's third law on the boat as a whole.
      const hullBodyForPin = this.config.getHullBody?.();
      if (hullBodyForPin) {
        const head = this.config.headLocalPosition;
        this.furledLock = new PointToRigidLockConstraint3D(
          clewBody,
          hullBodyForPin,
          {
            localAnchorB: [head.x, head.y, this.config.zFoot],
            collideConnected: true,
          },
        );
        this.furledLock.disabled = this.hoistAmount > 0;
        this.constraints.push(this.furledLock);
      }
    } else {
      this.bodies = [];
      this.constraints = [];
    }

    // Wind query at sail centroid
    this.windQuery = this.addChild(
      new WindQuery(() => {
        if (this.hoistAmount <= 0) return [];
        const head = this.config.getHeadPosition();
        const clew = this.getClewPositionFromConfig();
        return [head.add(clew.sub(head).mul(0.33))];
      }),
    );

    // Attach tell tails along the leech (trailing edge) at 1/4, 1/2, 3/4 height
    if (attachTellTail) {
      const leech = this.mesh.leechVertices;
      const reader = () => this.handle ?? this.solver;
      for (const frac of [0.25, 0.5, 0.75]) {
        const leechIdx = leech[Math.round(frac * (leech.length - 1))];
        this.addChild(
          new TellTail(
            () =>
              V(
                reader().getPositionX(leechIdx),
                reader().getPositionY(leechIdx),
              ),
            () => {
              const r = reader();
              const dx =
                r.getPositionX(leechIdx) - r.getPrevPositionX(leechIdx);
              const dy =
                r.getPositionY(leechIdx) - r.getPrevPositionY(leechIdx);
              return V(dx * 120, dy * 120);
            },
            () => (this.vertexActive[leechIdx] ? this.hoistAmount : 0),
            () => reader().getZ(leechIdx),
          ),
        );
      }
    }
  }

  @on("add")
  onAdd() {
    // Register with the ClothWorkerPool to get an off-thread (or sync fallback) handle
    const pool = this.game.entities.getSingleton(ClothWorkerPool);
    this.handle = pool.register({
      solver: this.solver,
      vertexCount: this.mesh.vertexCount,
      indices: this.mesh.indices,
      tackIdx: this.tackIdx,
      clewIdx: this.clewIdx,
      headIdx: this.headIdx,
      luffVertices: this.mesh.luffVertices,
      vertexU: this.vertexU,
      vertexV: this.vertexV,
      vertexChordFrac: this.vertexChordFrac,
      furlMode: this.furlMode,
    });
  }

  /**
   * Map UV mesh positions to initial 3D world positions.
   *
   * The sail is a triangle in 3D:
   *   Tack  (u=0, v=0) → (tack_x, tack_y, zFoot)
   *   Clew  (u=1, v=0) → (clew_x, clew_y, zFoot)
   *   Head  (u=0, v=1) → (luffTop_x, luffTop_y, zHead)
   *
   * u interpolates along the chord (foot direction) in x,y, tapered by row.
   * v interpolates z from zFoot to zHead and shifts luff XY from tack to luffTop.
   * For mainsails, tack and luffTop have the same XY (mast). For jibs, the luff
   * runs diagonally from bowsprit (tack) to masthead (luffTop) along the forestay.
   */
  private mapUVToWorld(
    tack: V2d,
    clew: V2d,
    outX: Float64Array,
    outY: Float64Array,
    outZ: Float64Array,
  ): void {
    const footX = clew.x - tack.x;
    const footY = clew.y - tack.y;
    const { zFoot, zHead } = this.config;

    // Compute luffTop in world space (forestay head / masthead).
    // For mainsails this is the same as the tack XY (vertical mast).
    // For jibs this is the mast position (diagonal forestay).
    let luffTopWorld: V2d | null = null;
    if (this.config.luffTopLocalPosition) {
      const hullBody = this.config.getHullBody?.();
      if (hullBody) {
        const [ltx, lty] = hullBody.toWorldFrame(
          this.config.luffTopLocalPosition,
        );
        luffTopWorld = V(ltx, lty);
      } else {
        luffTopWorld = V(
          this.config.luffTopLocalPosition.x,
          this.config.luffTopLocalPosition.y,
        );
      }
    }

    const footColCount = this.mesh.colCounts[0];

    for (let j = 0; j < this.mesh.colCounts.length; j++) {
      const rowStart = this.mesh.rowStarts[j];
      const colCount = this.mesh.colCounts[j];
      const chordFrac = (colCount - 1) / Math.max(1, footColCount - 1);
      const v = j / (this.mesh.colCounts.length - 1);

      // Luff base XY at this row: lerp from tack to luffTop (forestay diagonal)
      const luffX = luffTopWorld
        ? tack.x + v * (luffTopWorld.x - tack.x)
        : tack.x;
      const luffY = luffTopWorld
        ? tack.y + v * (luffTopWorld.y - tack.y)
        : tack.y;

      for (let c = 0; c < colCount; c++) {
        const i = rowStart + c;
        const u = colCount > 1 ? c / (colCount - 1) : 0;

        // x,y: from luff base along the chord, tapered by row height
        outX[i] = luffX + u * footX * chordFrac;
        outY[i] = luffY + u * footY * chordFrac;
        // z: interpolate from zFoot to zHead by row
        outZ[i] = zFoot + v * (zHead - zFoot);
      }
    }
  }

  /** Get head body - for mainsail, returns the head constraint body. For jib, returns first body or constraint body */
  getHead(): Body {
    return this.config.headConstraint.body;
  }

  /** Get clew body - for jib returns the Body; for mainsail returns the clew constraint body */
  getClew(): Body {
    if (this.bodies.length > 0) {
      return this.bodies[0]; // jib clew Body
    }
    // Mainsail: clew is on the boom, use clewConstraint body
    return this.config.clewConstraint?.body ?? this.config.headConstraint.body;
  }

  /** Get current head position */
  getHeadPosition(): V2d {
    return this.config.getHeadPosition();
  }

  /** Get current clew position - from config or from cloth handle */
  getClewPosition(): V2d {
    if (this.config.getClewPosition) {
      return this.config.getClewPosition();
    }
    // Read from handle - clew is the last vertex of foot row
    return V(
      this.handle.getPositionX(this.clewIdx),
      this.handle.getPositionY(this.clewIdx),
    );
  }

  /** Check if sail is hoisted (or hoisting) */
  isHoisted(): boolean {
    return this.hoistAmount > 0.5;
  }

  /** Get current hoist amount (0 = furled, 1 = deployed) */
  getHoistAmount(): number {
    return this.hoistAmount;
  }

  /**
   * Z-height of the sail head at the current hoist state (ft). Interpolates
   * from `zFoot` (fully furled — head rides down at the boom) to `zHead`
   * (fully hoisted — head at the masthead).
   */
  getHeadZ(): number {
    const { zFoot, zHead } = this.config;
    return zFoot + this.hoistAmount * (zHead - zFoot);
  }

  /** Set hoist direction: 1 = hoisting, -1 = furling, 0 = hold position */
  setHoistInput(direction: -1 | 0 | 1): void {
    this.hoistDirection = direction;
  }

  /** Total reaction force magnitude from all pins (lbf). Updated each tick. */
  private _totalReactionForce = 0;
  getTotalReactionForce(): number {
    return this._totalReactionForce;
  }

  /** Damage multiplier applied to liftScale (1.0 = no damage) */
  private getDamageMultiplier: () => number = () => 1;

  private _clothSolveToken: AsyncOperationToken | null = null;
  setDamageMultiplier(fn: () => number): void {
    this.getDamageMultiplier = fn;
  }

  /**
   * onTick runs on the "sail" tick layer, BEFORE physics.
   * Reads results from the previous tick's worker solve and applies reaction forces.
   */
  @on("tick")
  async onTick({ dt }: GameEventMap["tick"]) {
    const { hoistSpeed, sailShape } = this.config;

    // Ramp hoist amount based on input direction
    if (this.hoistDirection !== 0) {
      this.hoistAmount = clamp(
        this.hoistAmount + this.hoistDirection * hoistSpeed * dt,
      );
    }

    // Furled-state pin: enable the lock constraint when the jib is rolled up
    // so the clew rides at the forestay, disable it otherwise so the cloth
    // sim's reaction forces own the clew's position. The constraint solver
    // handles the actual positioning during the physics step — no kinematic
    // teleport needed, and rope forces on the clew transfer cleanly to the
    // hull via the pin's lever arm.
    if (this.furledLock) {
      this.furledLock.disabled = this.hoistAmount > 0;
    }

    // Wait for the previous tick's solve to finish, then read its results.
    // Blocking here (instead of skipping when the worker is slow) keeps the
    // cloth pipeline at a deterministic one-tick lag — without this, slow
    // solves would silently drop inputs and skip reaction-force application.
    await this.handle.awaitResults();

    // Read results from the worker's previous solve (one-tick lag)
    if (this.handle.hasNewResults()) {
      if (this._clothSolveToken) {
        asyncProfiler.endAsync(this._clothSolveToken);
        this._clothSolveToken = null;
      }
      const reactions = this.handle.readReactionForces();
      const vertexMass = CLOTH_MASS / this.mesh.vertexCount;

      // Feed reaction forces from pinned vertices to constraint bodies.
      // Reaction forces are summed across sub-steps; divide by substeps to average.
      const { headConstraint, clewConstraint } = this.config;
      const vm = vertexMass / CLOTH_SUBSTEPS;

      const tackRx = reactions[REACTION_TACK_X] * vm;
      const tackRy = reactions[REACTION_TACK_Y] * vm;
      const tackRz = reactions[REACTION_TACK_Z] * vm;
      const headRx = reactions[REACTION_HEAD_X] * vm;
      const headRy = reactions[REACTION_HEAD_Y] * vm;
      const headRz = reactions[REACTION_HEAD_Z] * vm;
      const clewRx = reactions[REACTION_CLEW_X] * vm;
      const clewRy = reactions[REACTION_CLEW_Y] * vm;
      const clewRz = reactions[REACTION_CLEW_Z] * vm;

      // Total reaction force magnitude across all pins (for damage tracking)
      this._totalReactionForce =
        Math.hypot(tackRx, tackRy, tackRz) +
        Math.hypot(headRx, headRy, headRz) +
        Math.hypot(clewRx, clewRy, clewRz);

      // Only feed reactions into rigid bodies while hoisted. When furled the
      // worker still runs so cloth positions track the boat, but any reaction
      // it produces is from tracking drag, not sail load — applying it would
      // push the hull/boom for no reason.
      if (this.hoistAmount > 0) {
        // Tack + head both attach at the mast (headConstraint)
        const hBody = headConstraint.body as Body;
        hBody.applyForce3D(
          tackRx + headRx,
          tackRy + headRy,
          tackRz + headRz,
          headConstraint.localAnchor.x,
          headConstraint.localAnchor.y,
          0,
        );

        // Clew reaction forces — apply to constraint body (mainsail: boom)
        // or directly to the clew body (jib: free body constrained by sheets)
        if (clewConstraint) {
          const cBody = clewConstraint.body as Body;
          cBody.applyForce3D(
            clewRx,
            clewRy,
            clewRz,
            clewConstraint.localAnchor.x,
            clewConstraint.localAnchor.y,
            0,
          );
        } else if (sailShape === "triangle" && this.bodies.length > 0) {
          const cBody = this.bodies[0] as Body;
          cBody.applyForce3D(clewRx, clewRy, clewRz, 0, 0, 0);
        }
      } else {
        this._totalReactionForce = 0;
      }

      this.handle.ackResults();
    }
  }

  /**
   * onAfterPhysicsStep runs AFTER physics.
   * Gathers fresh pin targets from post-physics body positions and kicks off
   * the next worker solve (non-blocking).
   */
  @on("afterPhysicsStep")
  onAfterPhysicsStep(dt: number) {
    // Furled clew pin is now enforced by `furledLock` during the solver
    // step, so no post-physics teleport is needed. (The constraint
    // transmits rope forces to the hull correctly; a teleport would
    // silently discard them.)

    const { sailShape, liftScale, dragScale } = this.config;

    // Apply damage multiplier to lift (damaged sails produce less drive)
    const effectiveLiftScale = liftScale * this.getDamageMultiplier();

    // Get hull body for 3D pin targets (or use identity-like defaults when no body)
    const hullBody = this.config.getHullBody?.();
    const local = this.config.headLocalPosition;

    // Update pin targets for 3 pinned vertices: tack, clew, head
    const head = this.config.getHeadPosition();
    const clew = this.getClewPositionFromConfig();
    this.headPos.set(head);
    this.clewPos.set(clew);

    // Tack (u=0, v=0): at mast/forestay junction, z=zFoot — transformed to heeled 3D
    let tackX: number, tackY: number, tackZ: number;
    if (hullBody) {
      // toWorldFrame3D includes body.z in Z; subtract it to get rotation-only Z
      // (the cloth sim works in its own coordinate frame, not absolute world height)
      [tackX, tackY, tackZ] = hullBody.toWorldFrame3D(
        local.x,
        local.y,
        this.config.zFoot,
      );
      tackZ -= hullBody.z;
    } else {
      tackX = local.x;
      tackY = local.y;
      tackZ = this.config.zFoot;
    }

    // Clew (u=1, v=0): position depends on sail type
    let clewX: number, clewY: number, clewZ: number;
    if (sailShape === "triangle" && this.bodies.length > 0) {
      // Jib: use the clew body's physics position as the pin target.
      // The sheet constrains this body, so when trimmed the body moves
      // inward → cloth sim pins the vertex to the new position → wind
      // pushes back via reaction forces → equilibrium.
      const clewBody = this.bodies[0] as Body;
      clewX = clewBody.position[0];
      clewY = clewBody.position[1];
      // Z from the body's 6DOF position, minus hull heave (cloth sim frame)
      clewZ = clewBody.z - (hullBody?.z ?? 0);
    } else {
      // Mainsail: clew at boom end. The boom body is 6DOF with its
      // orientation kinematically slaved to the hull (Rig.syncOrientationToHull),
      // so toWorldFrame3D returns the 3D boom end position directly.
      const boomBody = this.config.clewConstraint?.body as Body | undefined;
      const clewLocal = this.config.clewConstraint?.localAnchor;
      if (boomBody && clewLocal) {
        const [bcx, bcy, bcz] = boomBody.toWorldFrame3D(
          clewLocal.x,
          clewLocal.y,
          0,
        );
        clewX = bcx;
        clewY = bcy;
        // Cloth sim frame: subtract hull heave like the jib pin does
        clewZ = bcz - (hullBody?.z ?? 0);
      } else {
        clewX = clew.x;
        clewY = clew.y;
        clewZ = this.config.zFoot;
      }
    }

    // Head (u=0, v=1): full mast/forestay top position — worker uses hoistAmount
    // to determine the active region and interpolate luff pin targets.
    // For jibs, luffTopLocalPosition is at the mast (different XY from the tack
    // at the bowsprit), so the luff runs diagonally along the forestay.
    const luffTop = this.config.luffTopLocalPosition ?? local;
    let headWX: number, headWY: number, headWZ: number;
    if (hullBody) {
      [headWX, headWY, headWZ] = hullBody.toWorldFrame3D(
        luffTop.x,
        luffTop.y,
        this.config.zHead,
      );
      headWZ -= hullBody.z;
    } else {
      headWX = luffTop.x;
      headWY = luffTop.y;
      headWZ = this.config.zHead;
    }

    // Sample wind
    let windX = 0,
      windY = 0;
    if (this.hoistAmount > 0 && this.windQuery.length > 0) {
      const wind = this.windQuery.get(0).velocity;
      windX = wind.x;
      windY = wind.y;
    }

    // Kick off worker solve and start async profiling
    this._clothSolveToken = asyncProfiler.startAsync("Cloth.solve");
    this.handle.writeInputsAndKick({
      dt,
      substeps: CLOTH_SUBSTEPS,
      iterations: CLOTH_ITERATIONS,
      constraintDamping: CONSTRAINT_DAMPING,
      clothMass: CLOTH_MASS,
      hoistAmount: this.hoistAmount,
      windX,
      windY,
      liftScale: effectiveLiftScale,
      dragScale,
      tackX,
      tackY,
      tackZ,
      clewX,
      clewY,
      clewZ,
      headX: headWX,
      headY: headWY,
      headZ: headWZ,
      clewPinned: true,
    });

    // The jib clew body is a real 3D physics body — sheet constraints and
    // cloth 3D reaction forces find equilibrium in all three axes.
  }

  /** Get clew position from config (for boom/constraint based sails) */
  private getClewPositionFromConfig(): V2d {
    if (this.config.getClewPosition) {
      return this.config.getClewPosition();
    }
    if (this.config.initialClewPosition) {
      return this.config.initialClewPosition;
    }
    return this.config.getHeadPosition();
  }

  @on("render")
  onRender({ draw }: { draw: import("../../../core/graphics/Draw").Draw }) {
    // Draw furled sail as a white line along the boom/forestay.
    // Min width matches the spar it wraps; drawn slightly above to stay visible.
    if (this.hoistAmount < 1) {
      const hullBody = this.config.getHullBody?.();
      const sparWidth = this.furlMode === "v-cutoff" ? 0.5 : 0.1;
      const furlWidth = sparWidth + 0.5 * (1 - this.hoistAmount);
      // The furled sail wraps around the spar, sitting slightly above its surface.
      const zBump = 0.05;

      let x1: number, y1: number, z1: number;
      let x2: number, y2: number, z2: number;
      let valid = false;

      if (this.furlMode === "v-cutoff") {
        // Mainsail: line along the boom from mast to boom end. The boom body
        // is 6DOF, locked to the hull's tilt, so toWorldFrame3D gives the
        // correct 3D position at both endpoints.
        const clewLocal = this.config.clewConstraint?.localAnchor;
        const boomBody = this.config.clewConstraint?.body as Body | undefined;
        if (boomBody && clewLocal) {
          [x1, y1, z1] = boomBody.toWorldFrame3D(0, 0, zBump);
          [x2, y2, z2] = boomBody.toWorldFrame3D(
            clewLocal.x,
            clewLocal.y,
            zBump,
          );
          valid = true;
        } else {
          x1 = y1 = z1 = x2 = y2 = z2 = 0;
        }
      } else {
        // Jib: line along the forestay from bowsprit tip to mast top
        const local = this.config.headLocalPosition;
        const luffTop = this.config.luffTopLocalPosition ?? local;
        if (hullBody) {
          [x1, y1, z1] = hullBody.toWorldFrame3D(
            local.x,
            local.y,
            this.config.zFoot + zBump,
          );
          [x2, y2, z2] = hullBody.toWorldFrame3D(
            luffTop.x,
            luffTop.y,
            this.config.zHead + zBump,
          );
          valid = true;
        } else {
          x1 = y1 = z1 = x2 = y2 = z2 = 0;
        }
      }

      if (valid) {
        // Build a quad perpendicular to the line with per-vertex z
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1e-6) {
          const hw = furlWidth / 2;
          const nx = (-dy / len) * hw;
          const ny = (dx / len) * hw;
          this.furlQuadVerts[0][0] = x1 + nx;
          this.furlQuadVerts[0][1] = y1 + ny;
          this.furlQuadVerts[1][0] = x2 + nx;
          this.furlQuadVerts[1][1] = y2 + ny;
          this.furlQuadVerts[2][0] = x2 - nx;
          this.furlQuadVerts[2][1] = y2 - ny;
          this.furlQuadVerts[3][0] = x1 - nx;
          this.furlQuadVerts[3][1] = y1 - ny;
          this.furlQuadZ[0] = z1;
          this.furlQuadZ[1] = z2;
          this.furlQuadZ[2] = z2;
          this.furlQuadZ[3] = z1;
          draw.renderer.submitTrianglesWithZ(
            this.furlQuadVerts,
            Sail.FURL_QUAD_INDICES,
            0xffffff,
            0.9,
            this.furlQuadZ,
          );
        }
      }
    }

    if (this.hoistAmount <= 0) {
      return;
    }

    // Compute vertex active flags for rendering
    const active = this.vertexActive;
    if (this.furlMode === "v-cutoff") {
      for (let i = 0; i < this.mesh.vertexCount; i++) {
        active[i] = this.vertexV[i] <= this.hoistAmount ? 1 : 0;
      }
    } else {
      const wrapThreshold = 1 - this.hoistAmount;
      for (let i = 0; i < this.mesh.vertexCount; i++) {
        active[i] = this.vertexU[i] >= wrapThreshold ? 1 : 0;
      }
    }

    const { color } = this.config;
    const alpha = 1.0;

    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay) ?? null;

    this.clothRenderer.render(
      this.handle,
      draw,
      color,
      alpha,
      timeOfDay,
      active,
    );

    // Draw a line along the leech (trailing edge) to give the sail more definition.
    // Each segment uses the average z of its endpoints so the line sits on the
    // sail surface rather than at z=0 (which would be behind the sail mesh).
    const leech = this.mesh.leechVertices;
    for (let i = 0; i < leech.length - 1; i++) {
      const a = leech[i];
      const b = leech[i + 1];
      // Skip inactive leech segments
      if (!active[a] || !active[b]) continue;
      const z = (this.handle.getZ(a) + this.handle.getZ(b)) / 2;
      draw.line(
        this.handle.getPositionX(a),
        this.handle.getPositionY(a),
        this.handle.getPositionX(b),
        this.handle.getPositionY(b),
        { color: 0xffffff, alpha: 0.95, width: 0.15, z },
      );
    }
  }

  @on("destroy")
  onDestroy() {
    if (this.isDestroyed) return;
    const pool = this.game.entities.tryGetSingleton(ClothWorkerPool);
    if (pool && this.handle) {
      pool.unregister(this.handle);
    }
  }
}
