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
import { computeClothWindForce } from "./sail-aerodynamics";
import { generateSailMesh, SailMeshData } from "./SailMesh";
import { TellTail } from "./TellTail";

// Gravity in ft/s² (downward in z)
const GRAVITY_Z = -32.174;

//#tunable { min: 1, max: 100, step: 1 }
let CLOTH_ITERATIONS: number = 10;

//#tunable { min: 1, max: 16, step: 1 }
let CLOTH_SUBSTEPS: number = 4;

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
  private vertexMass: number; // lbs per vertex — for converting between force and acceleration

  // Wind query for aerodynamic forces
  private windQuery: WindQuery;

  // Tilt torque from sail forces × pin world-Z heights
  private _rollTorque = 0;
  private _pitchTorque = 0;

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

    this.vertexMass = CLOTH_MASS / this.mesh.vertexCount;

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

  /** Get tilt torque from sail pin reaction forces × world-Z heights */
  getTiltTorque(): { roll: number; pitch: number } {
    return { roll: this._rollTorque, pitch: this._pitchTorque };
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

    this._rollTorque = 0;
    this._pitchTorque = 0;

    // Recompute vertex mass from tunable (allows runtime adjustment)
    this.vertexMass = CLOTH_MASS / this.mesh.vertexCount;

    // Get tilt transform for 3D pin targets
    const tilt = this.config.getTiltTransform?.() ?? DEFAULT_TILT_TRANSFORM;
    const local = this.config.headLocalPosition;

    // Update pin targets for 3 pinned vertices: tack, clew, head
    const head = this.config.getHeadPosition();
    const clew = this.getClewPositionFromConfig();
    this.headPos.set(head);
    this.clewPos.set(clew);

    const tackIdx = this.mesh.footVertices[0];
    const clewIdx = this.mesh.footVertices[this.mesh.footVertices.length - 1];
    const headIdx = this.mesh.luffVertices[this.mesh.luffVertices.length - 1];

    // Tack (u=0, v=0): at mast/forestay junction, z=zFoot — transformed to heeled 3D
    const [tackX, tackY, tackZ] = tilt.toWorld3D(
      local.x,
      local.y,
      this.config.zFoot,
    );
    this.solver.setPinTarget(tackIdx, tackX, tackY, tackZ);

    // Clew (u=1, v=0): at boom end (mainsail only), z=zFoot
    // Boom body's 2D position comes from the physics engine; add parallax for zFoot
    if (sailShape === "boom") {
      const clewParallax = tilt.worldOffset(this.config.zFoot);
      this.solver.setPinTarget(
        clewIdx,
        clew.x + clewParallax.x,
        clew.y + clewParallax.y,
        this.config.zFoot * tilt.cosRoll * tilt.cosPitch,
      );
    }

    // Head (u=0, v=1): at mast position, z varies with hoist.
    // When lowering, z drops toward zFoot so the head collapses toward the tack.
    const headZ =
      this.config.zFoot +
      this.hoistAmount * (this.config.zHead - this.config.zFoot);
    const [headWX, headWY, headWZ] = tilt.toWorld3D(local.x, local.y, headZ);
    this.solver.setPinTarget(headIdx, headWX, headWY, headWZ);

    this.solver.clearForces();

    // Gravity (downward in z).
    // Scale by vertexMass so lighter cloth feels proportionally less gravity.
    // (The Verlet integrator treats force as acceleration; gravity acceleration
    // is mass-independent, but the cloth's effective weight should match its
    // actual mass, not the implicit unit mass.)
    const gravZ = GRAVITY_Z * this.vertexMass;
    for (let i = 0; i < this.mesh.vertexCount; i++) {
      this.solver.applyForce(i, 0, 0, gravZ);
    }

    // Aerodynamic forces from wind (per-triangle, distributed to vertices).
    // Wind forces from computeClothWindForce are in engine force units.
    // Divide by vertexMass to convert to acceleration for the Verlet solver.
    if (this.hoistAmount > 0 && this.windQuery.length > 0) {
      const wind = this.windQuery.get(0).velocity;
      const windX = wind.x;
      const windY = wind.y;
      const indices = this.mesh.indices;
      const invVertexMass = 1 / this.vertexMass;

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

        // Convert force → acceleration, distribute 1/3 to each vertex
        const scale = (this.hoistAmount * invVertexMass) / 3;
        const sfx = fx * scale;
        const sfy = fy * scale;
        const sfz = fz * scale;

        this.solver.applyForce(i0, sfx, sfy, sfz);
        this.solver.applyForce(i1, sfx, sfy, sfz);
        this.solver.applyForce(i2, sfx, sfy, sfz);
      }
    }

    // Sub-step the solver for better integration stability.
    // Smaller dt per step means the Verlet integrator is more accurate,
    // so fewer constraint iterations are needed per sub-step.
    // Accumulate reaction forces across sub-steps and average them so
    // the hull/boom receive the correct time-averaged force for the tick.
    const subDt = dt / CLOTH_SUBSTEPS;
    const subIter = Math.max(1, Math.round(CLOTH_ITERATIONS / CLOTH_SUBSTEPS));
    let sumTackRx = 0,
      sumTackRy = 0;
    let sumHeadRx = 0,
      sumHeadRy = 0;
    let sumClewRx = 0,
      sumClewRy = 0;
    for (let s = 0; s < CLOTH_SUBSTEPS; s++) {
      this.solver.update(subDt, subIter);
      sumTackRx += this.solver.getReactionForceX(tackIdx);
      sumTackRy += this.solver.getReactionForceY(tackIdx);
      sumHeadRx += this.solver.getReactionForceX(headIdx);
      sumHeadRy += this.solver.getReactionForceY(headIdx);
      sumClewRx += this.solver.getReactionForceX(clewIdx);
      sumClewRy += this.solver.getReactionForceY(clewIdx);
    }

    // Feed reaction forces from pinned vertices to constraint bodies.
    // Reaction forces from the solver are in acceleration units (implicit unit mass).
    // Multiply by vertexMass to convert back to engine force units for the physics engine.
    // Average across sub-steps so the hull receives the correct impulse over the tick.
    // Only apply when hoisted — when lowered, the cloth hangs limply and its
    // gravity/inertial reaction forces shouldn't drive the boom or hull.
    if (this.hoistAmount > 0) {
      const { headConstraint, clewConstraint } = this.config;
      const vm = this.vertexMass / CLOTH_SUBSTEPS;

      const tackRx = sumTackRx * vm;
      const tackRy = sumTackRy * vm;
      const headRx = sumHeadRx * vm;
      const headRy = sumHeadRy * vm;

      // Tack + head both attach at the mast (headConstraint)
      const hBody = headConstraint.body as DynamicBody;
      const hPoint = hBody.vectorToWorldFrame(headConstraint.localAnchor);
      hBody.applyForce(V(tackRx + headRx, tackRy + headRy), hPoint);

      // Clew attaches at boom end (mainsail) or is free (jib)
      if (clewConstraint) {
        const clewRx = sumClewRx * vm;
        const clewRy = sumClewRy * vm;
        const cBody = clewConstraint.body as DynamicBody;
        const cPoint = cBody.vectorToWorldFrame(clewConstraint.localAnchor);
        cBody.applyForce(V(clewRx, clewRy), cPoint);
      }

      // Compute per-pin tilt torque: reaction force × world-Z height
      // Lateral = force component perpendicular to heading → roll torque
      // Forward = force component along heading → pitch torque
      const latX = -tilt.sinAngle;
      const latY = tilt.cosAngle;
      const fwdX = tilt.cosAngle;
      const fwdY = tilt.sinAngle;

      // Tack pin
      const tackLat = tackRx * latX + tackRy * latY;
      const tackFwd = tackRx * fwdX + tackRy * fwdY;
      this._rollTorque += tackLat * tackZ;
      this._pitchTorque += tackFwd * tackZ;

      // Head pin
      const headLat = headRx * latX + headRy * latY;
      const headFwd = headRx * fwdX + headRy * fwdY;
      this._rollTorque += headLat * headWZ;
      this._pitchTorque += headFwd * headWZ;

      // Clew pin (if boom-attached)
      if (clewConstraint) {
        const clewRx2 = sumClewRx * vm;
        const clewRy2 = sumClewRy * vm;
        const clewWorldZ = this.config.zFoot * tilt.cosRoll * tilt.cosPitch;
        const clewLat = clewRx2 * latX + clewRy2 * latY;
        const clewFwd = clewRx2 * fwdX + clewRy2 * fwdY;
        this._rollTorque += clewLat * clewWorldZ;
        this._pitchTorque += clewFwd * clewWorldZ;
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

    // Slight transparency so you can see through the sail, with extra fade when lowering
    const fadeStart = 0.4;
    const baseAlpha = 0.95;
    const alpha =
      this.hoistAmount >= fadeStart
        ? baseAlpha
        : baseAlpha * (this.hoistAmount / fadeStart) ** 0.5;

    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    const time = timeOfDay?.getTimeInSeconds() ?? 43200; // default noon

    this.clothRenderer.render(this.solver, draw, color, alpha, time);
  }
}

// Default identity tilt transform (no tilt)
const DEFAULT_TILT_TRANSFORM = new TiltTransform();
