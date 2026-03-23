/**
 * Synchronous fallback for cloth solving when SharedArrayBuffer is unavailable.
 * Same interface as SailWorkerHandle but runs the solver on the main thread.
 */

import type { ClothPositionReader } from "./ClothRenderer";
import { ClothSolver } from "./ClothSolver";
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
  private solved = false;

  // Reaction force accumulators
  private tackRx = 0;
  private tackRy = 0;
  private headRx = 0;
  private headRy = 0;
  private clewRx = 0;
  private clewRy = 0;

  constructor(
    solver: ClothSolver,
    indices: number[],
    tackIdx: number,
    clewIdx: number,
    headIdx: number,
  ) {
    this.solver = solver;
    this.indices = indices;
    this.tackIdx = tackIdx;
    this.clewIdx = clewIdx;
    this.headIdx = headIdx;
  }

  hasNewResults(): boolean {
    return this.solved;
  }

  readReactionForces(): Float64Array {
    return new Float64Array([
      this.tackRx,
      this.tackRy,
      this.headRx,
      this.headRy,
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

    // Update pin targets
    solver.setPinTarget(this.tackIdx, tackX, tackY, tackZ);
    solver.setPinTarget(this.clewIdx, clewX, clewY, clewZ);
    solver.setPinTarget(this.headIdx, headX, headY, headZ);

    solver.setPinned(this.tackIdx, true);
    solver.setPinned(this.headIdx, true);
    solver.setPinned(this.clewIdx, clewPinned);

    const vertexMass = clothMass / vertexCount;
    solver.clearForces();

    // Gravity
    const gravZ = GRAVITY_Z * vertexMass;
    for (let i = 0; i < vertexCount; i++) {
      solver.applyForce(i, 0, 0, gravZ);
    }

    // Aerodynamic forces
    if (hoistAmount > 0 && (windX !== 0 || windY !== 0)) {
      const invVertexMass = 1 / vertexMass;
      const indices = this.indices;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

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

        const scale = (hoistAmount * invVertexMass) / 3;
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
    let sumTackRx = 0,
      sumTackRy = 0;
    let sumHeadRx = 0,
      sumHeadRy = 0;
    let sumClewRx = 0,
      sumClewRy = 0;

    for (let s = 0; s < substeps; s++) {
      solver.update(subDt, subIter);
      sumTackRx += solver.getReactionForceX(this.tackIdx);
      sumTackRy += solver.getReactionForceY(this.tackIdx);
      sumHeadRx += solver.getReactionForceX(this.headIdx);
      sumHeadRy += solver.getReactionForceY(this.headIdx);
      sumClewRx += solver.getReactionForceX(this.clewIdx);
      sumClewRy += solver.getReactionForceY(this.clewIdx);
    }

    this.tackRx = sumTackRx;
    this.tackRy = sumTackRy;
    this.headRx = sumHeadRx;
    this.headRy = sumHeadRy;
    this.clewRx = sumClewRx;
    this.clewRy = sumClewRy;

    this.solved = true;
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
