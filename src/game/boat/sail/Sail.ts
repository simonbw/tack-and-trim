import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import type { Body } from "../../../core/physics/body/Body";
import { DynamicBody } from "../../../core/physics/body/DynamicBody";
import { Particle } from "../../../core/physics/shapes/Particle";
import { stepToward } from "../../../core/util/MathUtil";
import { V, V2d } from "../../../core/Vector";
import { WindQuery } from "../../world/wind/WindQuery";
import { TiltTransform } from "../TiltTransform";
import { ClothRenderer } from "./ClothRenderer";
import { ClothSolver } from "./ClothSolver";
import { computeClothWindForce } from "./sail-aerodynamics";
import { generateSailMesh, SailMeshData } from "./SailMesh";
import { TimeOfDay } from "../../time/TimeOfDay";
import { TellTail } from "./TellTail";

// Gravity in ft/s² (downward in z)
const GRAVITY_Z = -32.174;

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
  zFoot: number;
  zHead: number;
}

// Required params (no defaults)
export interface SailParams {
  getHeadPosition: () => V2d; // Called each frame - head moves with boat
  headConstraint: { body: Body; localAnchor: V2d };
  getClewPosition?: () => V2d; // Called each frame for constrained clews
  initialClewPosition?: V2d; // Only used once during construction
  clewConstraint?: { body: Body; localAnchor: V2d };
  getTiltTransform?: () => TiltTransform;
  /** Visual-only offset applied during rendering (e.g. tilt parallax). Not used in physics. */
  getRenderOffset?: () => V2d;
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
  private solver: ClothSolver;
  private clothRenderer: ClothRenderer;

  // Wind query for aerodynamic forces
  private windQuery: WindQuery;

  // Total aerodynamic force applied this tick (for heeling torque calculation)
  private _totalForce = V(0, 0);

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
    const taperFactor = sailShape === "triangle" ? 1.0 : 0.85;
    this.mesh = generateSailMesh({
      footColumns: clothColumns,
      luffRows: clothRows,
      taperFactor,
      zFoot,
      zHead,
    });

    // Create cloth solver
    this.solver = new ClothSolver(this.mesh, {
      damping: clothDamping,
      constraintIterations: clothIterations,
      bendStiffness,
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
    this.mapUVToWorld(head, initialClew, worldX, worldY, worldZ);
    this.solver.initializePositions(worldX, worldY, worldZ);

    // Pin just 3 corners: tack, clew, head
    const tackIdx = this.mesh.footVertices[0]; // (u=0, v=0)
    const clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1]; // (u=1, v=0)
    const headIdx = this.mesh.luffVertices[this.mesh.luffVertices.length - 1]; // (u=0, v=1)
    this.solver.setPinned(tackIdx, true);
    this.solver.setPinned(headIdx, true);
    if (sailShape === "boom") {
      // Mainsail: clew pinned to boom end
      this.solver.setPinned(clewIdx, true);
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

    // Attach tell tails to leech edge vertices
    if (attachTellTail) {
      const leechIdx =
        this.mesh.leechVertices[this.mesh.leechVertices.length - 1];
      this.addChild(
        new TellTail(
          () =>
            V(
              this.solver.getPositionX(leechIdx),
              this.solver.getPositionY(leechIdx),
            ),
          () => {
            const dx =
              this.solver.getPositionX(leechIdx) -
              this.solver.getPrevPositionX(leechIdx);
            const dy =
              this.solver.getPositionY(leechIdx) -
              this.solver.getPrevPositionY(leechIdx);
            // Approximate velocity (positions are 1 tick apart)
            return V(dx * 120, dy * 120);
          },
          () => this.hoistAmount,
          this.config.getRenderOffset,
        ),
      );
    }
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

  /** Get current clew position - from config or from cloth solver */
  getClewPosition(): V2d {
    if (this.config.getClewPosition) {
      return this.config.getClewPosition();
    }
    // Read from cloth solver - clew is the last vertex of foot row
    const clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1];
    return V(
      this.solver.getPositionX(clewIdx),
      this.solver.getPositionY(clewIdx),
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

  /** Get total aerodynamic force applied this tick (for heeling torque calculation) */
  getTotalForce(): V2d {
    return this._totalForce;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const { hoistSpeed, sailShape, liftScale, dragScale } = this.config;

    // Animate hoist amount toward target
    this.hoistAmount = stepToward(
      this.hoistAmount,
      this.targetHoistAmount,
      hoistSpeed * dt,
    );

    this._totalForce.set(0, 0);

    // Update pin targets for 3 pinned vertices: tack, clew, head
    const head = this.config.getHeadPosition();
    const clew = this.getClewPositionFromConfig();
    this.headPos.set(head);
    this.clewPos.set(clew);

    const tackIdx = this.mesh.footVertices[0];
    const clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1];
    const headIdx = this.mesh.luffVertices[this.mesh.luffVertices.length - 1];

    // Tack (u=0, v=0): at mast/boom junction, z=zFoot
    this.solver.setPinTarget(tackIdx, head.x, head.y, this.config.zFoot);

    // Clew (u=1, v=0): at boom end (mainsail only), z=zFoot
    if (sailShape === "boom") {
      this.solver.setPinTarget(clewIdx, clew.x, clew.y, this.config.zFoot);
    }

    // Head (u=0, v=1): at mast position in XY (same as tack), z varies with hoist.
    // The z-height difference creates visual separation via parallax when heeled.
    // When lowering, z drops toward zFoot so the head collapses toward the tack.
    const headZ =
      this.config.zFoot +
      this.hoistAmount * (this.config.zHead - this.config.zFoot);
    this.solver.setPinTarget(headIdx, head.x, head.y, headZ);

    this.solver.clearForces();

    // Gravity (downward in z)
    for (let i = 0; i < this.mesh.vertexCount; i++) {
      this.solver.applyForce(i, 0, 0, GRAVITY_Z);
    }

    // Aerodynamic forces from wind (per-triangle, distributed to vertices)
    if (this.hoistAmount > 0 && this.windQuery.length > 0) {
      const wind = this.windQuery.get(0).velocity;
      const windX = wind.x;
      const windY = wind.y;
      const indices = this.mesh.indices;

      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

        const [fx, fy, fz] = computeClothWindForce(
          this.solver,
          i0,
          i1,
          i2,
          windX,
          windY,
          liftScale,
          dragScale,
        );

        const scale = this.hoistAmount / 3;
        const sfx = fx * scale;
        const sfy = fy * scale;
        const sfz = fz * scale;

        this.solver.applyForce(i0, sfx, sfy, sfz);
        this.solver.applyForce(i1, sfx, sfy, sfz);
        this.solver.applyForce(i2, sfx, sfy, sfz);

        // Accumulate aerodynamic force for heeling torque (XY only).
        // This is separate from the reaction forces used for physics body coupling,
        // because reaction forces include inertial effects from hull movement
        // that shouldn't cause heeling.
        this._totalForce.x += fx * this.hoistAmount;
        this._totalForce.y += fy * this.hoistAmount;
      }
    }

    // Update solver (computes reaction forces on pinned vertices)
    this.solver.update(dt);

    // Feed reaction forces from pinned vertices to constraint bodies.
    // These represent the cloth pulling on its attachment points (mast, boom end)
    // and transfer through the physics engine (boom → hull via revolute constraint).
    // Only apply when hoisted — when lowered, the cloth hangs limply and its
    // gravity/inertial reaction forces shouldn't drive the boom or hull.
    if (this.hoistAmount > 0) {
      const { headConstraint, clewConstraint } = this.config;

      const tackRx = this.solver.getReactionForceX(tackIdx);
      const tackRy = this.solver.getReactionForceY(tackIdx);
      const headRx = this.solver.getReactionForceX(headIdx);
      const headRy = this.solver.getReactionForceY(headIdx);

      // Tack + head both attach at the mast (headConstraint)
      const hBody = headConstraint.body as DynamicBody;
      const hPoint = hBody.vectorToWorldFrame(headConstraint.localAnchor);
      hBody.applyForce(V(tackRx + headRx, tackRy + headRy), hPoint);

      // Clew attaches at boom end (mainsail) or is free (jib)
      if (clewConstraint) {
        const clewRx = this.solver.getReactionForceX(clewIdx);
        const clewRy = this.solver.getReactionForceY(clewIdx);
        const cBody = clewConstraint.body as DynamicBody;
        const cPoint = cBody.vectorToWorldFrame(clewConstraint.localAnchor);
        cBody.applyForce(V(clewRx, clewRy), cPoint);
      }
    }

    // TODO: Jib clew coupling is currently one-way — the cloth solver computes
    // the clew position, then teleports the DynamicBody there. The jib sheets
    // (DistanceConstraints on this body) can't push back into the cloth solver,
    // so they don't actually constrain the sail or transfer force to the hull.
    // To fix: either feed sheet constraint forces back as external forces on the
    // clew vertex, or pin the clew vertex and drive it from the DynamicBody
    // position (letting the physics engine resolve sheets first).
    if (sailShape === "triangle" && this.bodies.length > 0) {
      const clewBody = this.bodies[0];
      const clewVertexIdx =
        this.mesh.footVertices[this.mesh.footVertices.length - 1];

      clewBody.position.set(
        this.solver.getPositionX(clewVertexIdx),
        this.solver.getPositionY(clewVertexIdx),
      );
    }
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

    // Fade alpha near the end of lowering
    const fadeStart = 0.4;
    const alpha =
      this.hoistAmount >= fadeStart ? 1 : (this.hoistAmount / fadeStart) ** 0.5;

    // Get tilt transform for parallax
    const tiltTransform =
      this.config.getTiltTransform?.() ?? DEFAULT_TILT_TRANSFORM;

    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    const time = timeOfDay?.getTimeInSeconds() ?? 43200; // default noon

    this.clothRenderer.render(
      this.solver,
      tiltTransform,
      draw,
      color,
      alpha,
      time,
    );
  }
}

// Default identity tilt transform (no tilt)
const DEFAULT_TILT_TRANSFORM = new TiltTransform();
