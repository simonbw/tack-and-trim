/**
 * Synchronous fallback for cloth solving when SharedArrayBuffer is unavailable.
 * Same interface as SailWorkerHandle but runs the solver on the main thread.
 * Includes furling logic (luff pinning, active region, furl modes).
 */

import type { ClothPositionReader } from "./ClothRenderer";
import { ClothSolver } from "./ClothSolver";
import type { FurlMode } from "./cloth-worker-protocol";
import { computeClothWindForce } from "./sail-aerodynamics";
import type { SailSolveInputs } from "./SailWorkerHandle";

// Gravity in ft/s² (downward in z)
const GRAVITY_Z = -32.174;
// Activation band width (in v or u units) over which rows ease in.
const ACTIVATION_BAND = 0.1;

export class ClothSolverSync implements ClothPositionReader {
  private readonly solver: ClothSolver;
  private readonly indices: number[];
  private readonly tackIdx: number;
  private readonly clewIdx: number;
  private readonly headIdx: number;
  private readonly luffVertices: number[];
  private readonly luffSet: Set<number>;
  private readonly vertexU: Float64Array;
  private readonly vertexV: Float64Array;
  private readonly vertexChordFrac: Float64Array;
  private readonly furlMode: FurlMode;
  private readonly vertexActive: Uint8Array;
  private readonly prevActive: Uint8Array;
  private readonly vertexBlend: Float64Array;
  private readonly restShape: Float64Array;
  private readonly prevRestShape: Float64Array;
  private restShapeInitialized = false;
  private solved = false;

  // Reaction force accumulators
  private luffRx = 0;
  private luffRy = 0;
  private clewRx = 0;
  private clewRy = 0;

  constructor(
    solver: ClothSolver,
    indices: number[],
    tackIdx: number,
    clewIdx: number,
    headIdx: number,
    luffVertices: number[],
    vertexU: Float64Array,
    vertexV: Float64Array,
    vertexChordFrac: Float64Array,
    furlMode: FurlMode,
  ) {
    this.solver = solver;
    this.indices = indices;
    this.tackIdx = tackIdx;
    this.clewIdx = clewIdx;
    this.headIdx = headIdx;
    this.luffVertices = luffVertices;
    this.vertexU = vertexU;
    this.vertexV = vertexV;
    this.vertexChordFrac = vertexChordFrac;
    this.furlMode = furlMode;
    this.vertexActive = new Uint8Array(solver.vertexCount);
    this.prevActive = new Uint8Array(solver.vertexCount);
    this.vertexBlend = new Float64Array(solver.vertexCount);
    this.restShape = new Float64Array(solver.vertexCount * 3);
    this.prevRestShape = new Float64Array(solver.vertexCount * 3);
    this.luffSet = new Set(luffVertices);
  }

  private computeBlend(i: number, hoistAmount: number): number {
    const excess =
      this.furlMode === "v-cutoff"
        ? hoistAmount - this.vertexV[i]
        : this.vertexU[i] - (1 - hoistAmount);
    if (excess <= 0) return 0;
    if (excess >= ACTIVATION_BAND) return 1;
    const t = excess / ACTIVATION_BAND;
    return t * t * (3 - 2 * t);
  }

  private computeRestShape(
    tackX: number,
    tackY: number,
    tackZ: number,
    clewX: number,
    clewY: number,
    clewZ: number,
    headX: number,
    headY: number,
    headZ: number,
  ): void {
    const out = this.restShape;
    const vertexCount = this.solver.vertexCount;
    const chordX = clewX - tackX;
    const chordY = clewY - tackY;
    for (let i = 0; i < vertexCount; i++) {
      const u = this.vertexU[i];
      const v = this.vertexV[i];
      const cf = this.vertexChordFrac[i];
      const i3 = i * 3;
      out[i3] = tackX + v * (headX - tackX) + u * cf * chordX;
      out[i3 + 1] = tackY + v * (headY - tackY) + u * cf * chordY;
      out[i3 + 2] = tackZ + v * (headZ - tackZ);
    }
  }

  hasNewResults(): boolean {
    return this.solved;
  }

  async awaitResults(): Promise<void> {
    // Synchronous fallback: writeInputsAndKick already finished the solve.
  }

  readReactionForces(): Float64Array {
    return new Float64Array([
      0,
      0,
      this.luffRx,
      this.luffRy,
      this.clewRx,
      this.clewRy,
    ]);
  }

  ackResults(): void {
    this.solved = false;
  }

  writeInputsAndKick(inputs: SailSolveInputs): void {
    const {
      dt,
      substeps,
      iterations,
      constraintDamping,
      clothMass,
      hoistAmount,
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
      headX,
      headY,
      headZ,
      clewPinned,
    } = inputs;

    const solver = this.solver;
    const vertexCount = solver.vertexCount;

    // Update solver config
    solver.setConstraintDamping(constraintDamping);

    // Update clew pin target
    solver.setPinTarget(this.clewIdx, clewX, clewY, clewZ);

    // Compute rest-shape positions and seed prev on the first frame.
    this.computeRestShape(
      tackX,
      tackY,
      tackZ,
      clewX,
      clewY,
      clewZ,
      headX,
      headY,
      headZ,
    );
    if (!this.restShapeInitialized) {
      this.prevRestShape.set(this.restShape);
      this.restShapeInitialized = true;
    }

    // Compute blend weights, luff pins, skipped verts, activation seeding
    this.updateFurlState(hoistAmount, clewPinned);

    const vertexMass = clothMass / vertexCount;
    solver.clearForces();

    // Gravity — scaled by blend so partially-active verts ease in
    const gravZ = GRAVITY_Z * vertexMass;
    for (let i = 0; i < vertexCount; i++) {
      const w = this.vertexBlend[i];
      if (w > 0) {
        solver.applyForce(i, 0, 0, gravZ * w);
      }
    }

    // Aerodynamic forces — scaled by minimum blend across triangle
    if (hoistAmount > 0 && (windX !== 0 || windY !== 0)) {
      const invVertexMass = 1 / vertexMass;
      const indices = this.indices;
      const blend = this.vertexBlend;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

        const wTri = Math.min(blend[i0], blend[i1], blend[i2]);
        if (wTri <= 0) continue;

        const [fx, fy, fz] = computeClothWindForce(
          solver,
          i0,
          i1,
          i2,
          windX,
          windY,
          liftScale,
          dragScale,
        );

        const scale = (invVertexMass / 3) * wTri;
        const sfx = fx * scale;
        const sfy = fy * scale;
        const sfz = fz * scale;

        solver.applyForce(i0, sfx, sfy, sfz);
        solver.applyForce(i1, sfx, sfy, sfz);
        solver.applyForce(i2, sfx, sfy, sfz);
      }
    }

    // Sub-step the solver
    const subDt = dt / substeps;
    const subIter = Math.max(1, Math.round(iterations / substeps));
    let sumLuffRx = 0,
      sumLuffRy = 0;
    let sumClewRx = 0,
      sumClewRy = 0;

    for (let s = 0; s < substeps; s++) {
      solver.update(subDt, subIter);

      for (const li of this.luffVertices) {
        if (this.vertexActive[li]) {
          sumLuffRx += solver.getReactionForceX(li);
          sumLuffRy += solver.getReactionForceY(li);
        }
      }

      sumClewRx += solver.getReactionForceX(this.clewIdx);
      sumClewRy += solver.getReactionForceY(this.clewIdx);
    }

    // Post-solve soft pin for partially-active verts
    for (let i = 0; i < vertexCount; i++) {
      const w = this.vertexBlend[i];
      if (w <= 0 || w >= 1) continue;
      const i3 = i * 3;
      solver.blendTowardTarget(
        i,
        this.restShape[i3],
        this.restShape[i3 + 1],
        this.restShape[i3 + 2],
        this.prevRestShape[i3],
        this.prevRestShape[i3 + 1],
        this.prevRestShape[i3 + 2],
        1 - w,
      );
    }

    // Store current rest shape for next frame
    this.prevRestShape.set(this.restShape);

    this.luffRx = sumLuffRx;
    this.luffRy = sumLuffRy;
    this.clewRx = sumClewRx;
    this.clewRy = sumClewRy;

    this.solved = true;
  }

  private updateFurlState(hoistAmount: number, clewPinned: boolean): void {
    const solver = this.solver;
    const vertexCount = solver.vertexCount;
    const active = this.vertexActive;
    const blend = this.vertexBlend;
    const restShape = this.restShape;
    const prevRestShape = this.prevRestShape;

    // Compute blend weights and active flags
    for (let i = 0; i < vertexCount; i++) {
      const w = this.computeBlend(i, hoistAmount);
      blend[i] = w;
      active[i] = w > 0 ? 1 : 0;
    }

    // Clear pin and skipped states — set fresh each frame
    for (let i = 0; i < vertexCount; i++) {
      solver.setPinned(i, false);
      solver.setSkipped(i, false);
    }

    // Luff verts: hard-pinned at rest shape (which is exactly the luff line)
    for (const li of this.luffVertices) {
      const i3 = li * 3;
      if (active[li]) {
        solver.setPinned(li, true);
        solver.setPinTarget(
          li,
          restShape[i3],
          restShape[i3 + 1],
          restShape[i3 + 2],
        );
      }
    }

    // Non-luff skipped verts: position = rest shape, prev = prev rest shape
    for (let i = 0; i < vertexCount; i++) {
      if (this.luffSet.has(i)) continue;
      if (!active[i]) {
        solver.setSkipped(i, true);
        const i3 = i * 3;
        solver.setPositionAndPrev(
          i,
          restShape[i3],
          restShape[i3 + 1],
          restShape[i3 + 2],
          prevRestShape[i3],
          prevRestShape[i3 + 1],
          prevRestShape[i3 + 2],
        );
      }
    }

    // Clew pin — only when fully active
    if (clewPinned && blend[this.clewIdx] >= 1) {
      solver.setPinned(this.clewIdx, true);
    }

    // Activation seeding: newly-active verts inherit the boat's velocity via
    // prev = prevRestShape (the previous frame's rest shape tracks boat motion)
    const prevActive = this.prevActive;
    for (let i = 0; i < vertexCount; i++) {
      if (active[i] && !prevActive[i]) {
        const i3 = i * 3;
        solver.setPositionAndPrev(
          i,
          restShape[i3],
          restShape[i3 + 1],
          restShape[i3 + 2],
          prevRestShape[i3],
          prevRestShape[i3 + 1],
          prevRestShape[i3 + 2],
        );
      }
      prevActive[i] = active[i];
    }
  }

  // ---- ClothPositionReader interface ----

  getPositionX(i: number): number {
    return this.solver.getPositionX(i);
  }

  getPositionY(i: number): number {
    return this.solver.getPositionY(i);
  }

  getZ(i: number): number {
    return this.solver.getZ(i);
  }

  // ---- Previous positions for TellTail velocity ----

  getPrevPositionX(i: number): number {
    return this.solver.getPrevPositionX(i);
  }

  getPrevPositionY(i: number): number {
    return this.solver.getPrevPositionY(i);
  }
}
