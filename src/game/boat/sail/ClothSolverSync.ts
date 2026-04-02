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

export class ClothSolverSync implements ClothPositionReader {
  private readonly solver: ClothSolver;
  private readonly indices: number[];
  private readonly tackIdx: number;
  private readonly clewIdx: number;
  private readonly headIdx: number;
  private readonly luffVertices: number[];
  private readonly vertexU: Float64Array;
  private readonly vertexV: Float64Array;
  private readonly furlMode: FurlMode;
  private readonly vertexActive: Uint8Array;
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
    this.furlMode = furlMode;
    this.vertexActive = new Uint8Array(solver.vertexCount);
  }

  hasNewResults(): boolean {
    return this.solved;
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

    // Compute active flags and set up furl state
    this.updateFurlState(
      hoistAmount,
      tackX,
      tackY,
      tackZ,
      headX,
      headY,
      headZ,
      clewPinned,
    );

    const vertexMass = clothMass / vertexCount;
    solver.clearForces();

    // Gravity — only active vertices
    const gravZ = GRAVITY_Z * vertexMass;
    for (let i = 0; i < vertexCount; i++) {
      if (this.vertexActive[i]) {
        solver.applyForce(i, 0, 0, gravZ);
      }
    }

    // Aerodynamic forces — only active triangles
    if (hoistAmount > 0 && (windX !== 0 || windY !== 0)) {
      const invVertexMass = 1 / vertexMass;
      const indices = this.indices;
      const active = this.vertexActive;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

        if (!active[i0] || !active[i1] || !active[i2]) continue;

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

        const scale = invVertexMass / 3;
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

    this.luffRx = sumLuffRx;
    this.luffRy = sumLuffRy;
    this.clewRx = sumClewRx;
    this.clewRy = sumClewRy;

    this.solved = true;
  }

  private updateFurlState(
    hoistAmount: number,
    tackX: number,
    tackY: number,
    tackZ: number,
    headX: number,
    headY: number,
    headZ: number,
    clewPinned: boolean,
  ): void {
    const solver = this.solver;
    const vertexCount = solver.vertexCount;
    const active = this.vertexActive;

    // Compute active flags
    if (this.furlMode === "v-cutoff") {
      for (let i = 0; i < vertexCount; i++) {
        active[i] = this.vertexV[i] <= hoistAmount ? 1 : 0;
      }
    } else {
      const wrapThreshold = 1 - hoistAmount;
      for (let i = 0; i < vertexCount; i++) {
        active[i] = this.vertexU[i] >= wrapThreshold ? 1 : 0;
      }
    }

    // Clear pins and skipped
    for (let i = 0; i < vertexCount; i++) {
      solver.setPinned(i, false);
      solver.setSkipped(i, false);
    }

    // Pin active luff vertices
    for (const li of this.luffVertices) {
      if (!active[li] && this.furlMode === "v-cutoff") continue;
      const v = this.vertexV[li];
      solver.setPinned(li, true);
      solver.setPinTarget(
        li,
        tackX + v * (headX - tackX),
        tackY + v * (headY - tackY),
        tackZ + v * (headZ - tackZ),
      );
    }

    if (this.furlMode === "v-cutoff") {
      for (let i = 0; i < vertexCount; i++) {
        if (!active[i]) solver.setSkipped(i, true);
      }
    } else {
      // u-wrap: pin wrapped vertices to forestay
      for (let i = 0; i < vertexCount; i++) {
        if (!active[i]) {
          const v = this.vertexV[i];
          solver.setPinned(i, true);
          solver.setPinTarget(
            i,
            tackX + v * (headX - tackX),
            tackY + v * (headY - tackY),
            tackZ + v * (headZ - tackZ),
          );
        }
      }
    }

    // Clew pin
    if (clewPinned && active[this.clewIdx]) {
      solver.setPinned(this.clewIdx, true);
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
