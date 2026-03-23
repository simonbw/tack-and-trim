import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Body } from "../../../core/physics/body/Body";
import { DynamicBody } from "../../../core/physics/body/DynamicBody";
import { Particle } from "../../../core/physics/shapes/Particle";
import { stepToward } from "../../../core/util/MathUtil";
import { V, V2d } from "../../../core/Vector";
import { TimeOfDay } from "../../time/TimeOfDay";
import { WindQuery } from "../../world/wind/WindQuery";
import { TiltTransform } from "../TiltTransform";
import { ClothRenderer } from "./ClothRenderer";
import { ClothSolver } from "./ClothSolver";
import { ClothWorkerPool, type SailHandle } from "./ClothWorkerPool";
import {
  REACTION_TACK_X,
  REACTION_TACK_Y,
  REACTION_HEAD_X,
  REACTION_HEAD_Y,
  REACTION_CLEW_X,
  REACTION_CLEW_Y,
} from "./cloth-worker-protocol";
import { generateSailMesh, SailMeshData } from "./SailMesh";
import { TellTail } from "./TellTail";

//#tunable { min: 1, max: 100, step: 1 }
let CLOTH_ITERATIONS: number = 64;

//#tunable { min: 1, max: 16, step: 1 }
let CLOTH_SUBSTEPS: number = 8;

//#tunable { min: 0, max: 1, step: 0.01 }
let CONSTRAINT_DAMPING: number = 0.02;

//#tunable { min: 0.1, max: 50 }
let CLOTH_MASS: number = 8.0;

// Optional config with defaults
export interface SailConfig {
  nodeMass: number;
  liftScale: number;
  dragScale: number;
  sailShape: "boom" | "triangle";
  hoistSpeed: number;
  color: number;
  attachTellTail: boolean;
  clothColumns: number;
  clothRows: number;
  clothDamping: number;
  clothIterations: number;
  bendStiffness: number;
  constraintDamping: number;
  zFoot: number;
  zHead: number;
}

// Required params (no defaults)
export interface SailParams {
  getHeadPosition: () => V2d; // Called each frame - head moves with boat
  headLocalPosition: V2d; // Boat-local XY of the mast/forestay attachment
  headConstraint: { body: Body; localAnchor: V2d };
  getClewPosition?: () => V2d; // Called each frame for constrained clews
  initialClewPosition?: V2d; // Only used once during construction
  clewConstraint?: { body: Body; localAnchor: V2d };
  getTiltTransform?: () => TiltTransform;
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
  layer = "sails" as const;
  tickLayer = "sail" as const;
  tags = ["sail"];

  // Keep bodies/constraints for jib clew coupling (single DynamicBody for sheets)
  bodies: DynamicBody[];
  constraints: NonNullable<BaseEntity["constraints"]>;

  // Hoist state (0 = fully lowered, 1 = fully hoisted)
  hoistAmount: number = 0;
  targetHoistAmount: number = 0;

  // Cloth simulation
  private mesh: SailMeshData;
  private solver: ClothSolver; // Kept for initial setup; worker takes over after onAdd
  private handle!: SailHandle;
  private clothRenderer: ClothRenderer;

  // Pin vertex indices
  private tackIdx: number;
  private clewIdx: number;
  private headIdx: number;

  // Wind query for aerodynamic forces
  private windQuery: WindQuery;

  // Tilt torque from sail forces × pin world-Z heights
  private _rollTorque = 0;
  private _pitchTorque = 0;

  // Cached tilt-dependent pin world-Z heights from last reaction force read
  private lastTackZ = 0;
  private lastHeadWZ = 0;
  private lastClewWorldZ = 0;

  private config: SailParams & SailConfig;

  // Cached geometry for mapping UV to world
  private headPos = V(0, 0);
  private clewPos = V(0, 0);

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

    // Pin just 3 corners: tack, clew, head
    this.tackIdx = this.mesh.footVertices[0]; // (u=0, v=0)
    this.clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1]; // (u=1, v=0)
    this.headIdx = this.mesh.luffVertices[this.mesh.luffVertices.length - 1]; // (u=0, v=1)
    this.solver.setPinned(this.tackIdx, true);
    this.solver.setPinned(this.headIdx, true);
    if (sailShape === "boom") {
      // Mainsail: clew pinned to boom end
      this.solver.setPinned(this.clewIdx, true);
    }

    // For jib: create a single DynamicBody for the clew (last vertex of foot row)
    // to couple with Sheet constraints
    if (sailShape === "triangle") {
      const clewVertexIdx =
        this.mesh.footVertices[this.mesh.footVertices.length - 1];
      const cx = this.solver.getPositionX(clewVertexIdx);
      const cy = this.solver.getPositionY(clewVertexIdx);

      const clewBody = new DynamicBody({
        mass: this.config.nodeMass,
        position: [cx, cy],
        collisionResponse: false,
        fixedRotation: true,
      }).addShape(new Particle());

      this.bodies = [clewBody];
      this.constraints = [];
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
            () => this.hoistAmount,
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
    });
  }

  /**
   * Map UV mesh positions to initial 3D world positions.
   *
   * The sail is a triangle in 3D:
   *   Tack  (u=0, v=0) → (mast_x, mast_y, zFoot)
   *   Clew  (u=1, v=0) → (boom_x, boom_y, zFoot)
   *   Head  (u=0, v=1) → (mast_x, mast_y, zHead)
   *
   * u interpolates along the foot (boom direction) in x,y, tapered by row.
   * v interpolates z from zFoot to zHead.
   * The cloth solver operates in full 3D, so constraints along the luff
   * (which differ only in z) have real nonzero rest lengths.
   */
  private mapUVToWorld(
    head: V2d,
    clew: V2d,
    outX: Float64Array,
    outY: Float64Array,
    outZ: Float64Array,
  ): void {
    const footX = clew.x - head.x;
    const footY = clew.y - head.y;
    const { zFoot, zHead } = this.config;

    const footColCount = this.mesh.colCounts[0];

    for (let j = 0; j < this.mesh.colCounts.length; j++) {
      const rowStart = this.mesh.rowStarts[j];
      const colCount = this.mesh.colCounts[j];
      const chordFrac = (colCount - 1) / Math.max(1, footColCount - 1);
      const v = j / (this.mesh.colCounts.length - 1);

      for (let c = 0; c < colCount; c++) {
        const i = rowStart + c;
        const u = colCount > 1 ? c / (colCount - 1) : 0;

        // x,y: along the boom, tapered by row height
        outX[i] = head.x + u * footX * chordFrac;
        outY[i] = head.y + u * footY * chordFrac;
        // z: interpolate from zFoot to zHead by row
        outZ[i] = zFoot + v * (zHead - zFoot);
      }
    }
  }

  /** Get head body - for mainsail, returns the head constraint body. For jib, returns first body or constraint body */
  getHead(): Body {
    return this.config.headConstraint.body;
  }

  /** Get clew body - for jib returns the DynamicBody; for mainsail returns the clew constraint body */
  getClew(): Body {
    if (this.bodies.length > 0) {
      return this.bodies[0]; // jib clew DynamicBody
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
    return this.targetHoistAmount > 0.5;
  }

  /** Get current hoist amount (0 = lowered, 1 = hoisted) */
  getHoistAmount(): number {
    return this.hoistAmount;
  }

  /** Set sail hoist state - will animate to target */
  setHoisted(hoisted: boolean): void {
    this.targetHoistAmount = hoisted ? 1 : 0;
  }

  /** Get tilt torque from sail pin reaction forces × world-Z heights */
  getTiltTorque(): { roll: number; pitch: number } {
    return { roll: this._rollTorque, pitch: this._pitchTorque };
  }

  /**
   * onTick runs on the "sail" tick layer, BEFORE physics.
   * Reads results from the previous tick's worker solve and applies reaction forces.
   */
  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const { hoistSpeed, sailShape } = this.config;

    // Animate hoist amount toward target
    this.hoistAmount = stepToward(
      this.hoistAmount,
      this.targetHoistAmount,
      hoistSpeed * dt,
    );

    this._rollTorque = 0;
    this._pitchTorque = 0;

    // Read results from the worker's previous solve (one-tick lag)
    if (this.handle.hasNewResults()) {
      const reactions = this.handle.readReactionForces();
      const vertexMass = CLOTH_MASS / this.mesh.vertexCount;

      // Feed reaction forces from pinned vertices to constraint bodies.
      // Reaction forces are summed across sub-steps; divide by substeps to average.
      // Only apply when hoisted.
      if (this.hoistAmount > 0) {
        const { headConstraint, clewConstraint } = this.config;
        const vm = vertexMass / CLOTH_SUBSTEPS;

        const tackRx = reactions[REACTION_TACK_X] * vm;
        const tackRy = reactions[REACTION_TACK_Y] * vm;
        const headRx = reactions[REACTION_HEAD_X] * vm;
        const headRy = reactions[REACTION_HEAD_Y] * vm;

        // Tack + head both attach at the mast (headConstraint)
        const hBody = headConstraint.body as DynamicBody;
        const hPoint = hBody.vectorToWorldFrame(headConstraint.localAnchor);
        hBody.applyForce(V(tackRx + headRx, tackRy + headRy), hPoint);

        // Clew attaches at boom end (mainsail) or is free (jib)
        if (clewConstraint) {
          const clewRx = reactions[REACTION_CLEW_X] * vm;
          const clewRy = reactions[REACTION_CLEW_Y] * vm;
          const cBody = clewConstraint.body as DynamicBody;
          const cPoint = cBody.vectorToWorldFrame(clewConstraint.localAnchor);
          cBody.applyForce(V(clewRx, clewRy), cPoint);
        }

        // Compute per-pin tilt torque: reaction force × world-Z height
        const tilt = this.config.getTiltTransform?.() ?? DEFAULT_TILT_TRANSFORM;
        const latX = -tilt.sinAngle;
        const latY = tilt.cosAngle;
        const fwdX = tilt.cosAngle;
        const fwdY = tilt.sinAngle;

        // Tack pin
        const tackLat = tackRx * latX + tackRy * latY;
        const tackFwd = tackRx * fwdX + tackRy * fwdY;
        this._rollTorque += tackLat * this.lastTackZ;
        this._pitchTorque += tackFwd * this.lastTackZ;

        // Head pin
        const headLat = headRx * latX + headRy * latY;
        const headFwd = headRx * fwdX + headRy * fwdY;
        this._rollTorque += headLat * this.lastHeadWZ;
        this._pitchTorque += headFwd * this.lastHeadWZ;

        // Clew pin (if boom-attached)
        if (clewConstraint) {
          const clewRx2 = reactions[REACTION_CLEW_X] * vm;
          const clewRy2 = reactions[REACTION_CLEW_Y] * vm;
          const clewLat = clewRx2 * latX + clewRy2 * latY;
          const clewFwd = clewRx2 * fwdX + clewRy2 * fwdY;
          this._rollTorque += clewLat * this.lastClewWorldZ;
          this._pitchTorque += clewFwd * this.lastClewWorldZ;
        }
      }

      // Sync jib clew body from handle positions
      if (sailShape === "triangle" && this.bodies.length > 0) {
        const clewBody = this.bodies[0];
        clewBody.position.set(
          this.handle.getPositionX(this.clewIdx),
          this.handle.getPositionY(this.clewIdx),
        );
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
    const { sailShape, liftScale, dragScale } = this.config;

    // Get tilt transform for 3D pin targets
    const tilt = this.config.getTiltTransform?.() ?? DEFAULT_TILT_TRANSFORM;
    const local = this.config.headLocalPosition;

    // Update pin targets for 3 pinned vertices: tack, clew, head
    const head = this.config.getHeadPosition();
    const clew = this.getClewPositionFromConfig();
    this.headPos.set(head);
    this.clewPos.set(clew);

    // Tack (u=0, v=0): at mast/forestay junction, z=zFoot — transformed to heeled 3D
    const [tackX, tackY, tackZ] = tilt.toWorld3D(
      local.x,
      local.y,
      this.config.zFoot,
    );

    // Clew (u=1, v=0): at boom end (mainsail only), z=zFoot
    let clewX = clew.x,
      clewY = clew.y,
      clewZ = this.config.zFoot;
    if (sailShape === "boom") {
      const clewParallax = tilt.worldOffset(this.config.zFoot);
      clewX = clew.x + clewParallax.x;
      clewY = clew.y + clewParallax.y;
      clewZ = this.config.zFoot * tilt.cosRoll * tilt.cosPitch;
    }

    // Head (u=0, v=1): at mast position, z varies with hoist.
    const headZ =
      this.config.zFoot +
      this.hoistAmount * (this.config.zHead - this.config.zFoot);
    const [headWX, headWY, headWZ] = tilt.toWorld3D(local.x, local.y, headZ);

    // Cache world-Z heights for next tick's torque computation
    this.lastTackZ = tackZ;
    this.lastHeadWZ = headWZ;
    this.lastClewWorldZ = this.config.zFoot * tilt.cosRoll * tilt.cosPitch;

    // Sample wind
    let windX = 0,
      windY = 0;
    if (this.hoistAmount > 0 && this.windQuery.length > 0) {
      const wind = this.windQuery.get(0).velocity;
      windX = wind.x;
      windY = wind.y;
    }

    // Kick off worker solve
    this.handle.writeInputsAndKick({
      dt,
      substeps: CLOTH_SUBSTEPS,
      iterations: CLOTH_ITERATIONS,
      constraintDamping: CONSTRAINT_DAMPING,
      clothMass: CLOTH_MASS,
      hoistAmount: this.hoistAmount,
      windX,
      windY,
      liftScale,
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
      clewPinned: sailShape === "boom",
    });
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
    if (this.hoistAmount <= 0) {
      return;
    }

    const { color } = this.config;

    // Slight transparency so you can see through the sail, with extra fade when lowering
    const fadeStart = 0.4;
    const baseAlpha = 0.99;
    const alpha =
      this.hoistAmount >= fadeStart
        ? baseAlpha
        : baseAlpha * (this.hoistAmount / fadeStart) ** 0.5;

    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    const time = timeOfDay?.getTimeInSeconds() ?? 43200; // default noon

    this.clothRenderer.render(this.handle, draw, color, alpha, time);

    // Draw a line along the leech (trailing edge) to give the sail more definition
    const leech = this.mesh.leechVertices;
    for (let i = 0; i < leech.length - 1; i++) {
      const a = leech[i];
      const b = leech[i + 1];
      draw.line(
        this.handle.getPositionX(a),
        this.handle.getPositionY(a),
        this.handle.getPositionX(b),
        this.handle.getPositionY(b),
        { color: 0xffffff, alpha: 0.95, width: 0.15 },
      );
    }
  }

  @on("destroy")
  onDestroy() {
    const pool = this.game.entities.tryGetSingleton(ClothWorkerPool);
    if (pool && this.handle) {
      pool.unregister(this.handle);
    }
  }
}

// Default identity tilt transform (no tilt)
const DEFAULT_TILT_TRANSFORM = new TiltTransform();
