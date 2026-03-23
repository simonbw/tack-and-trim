/**
 * Web Worker for cloth sail simulation.
 * Runs ClothSolver + aerodynamic forces off the main thread.
 * Communicates via SharedArrayBuffer + Atomics.
 */

import { ClothSolver } from "./ClothSolver";
import { computeClothWindForce } from "./sail-aerodynamics";
import {
  CLOTH_IDLE,
  CLOTH_SOLVING,
  CLOTH_DONE,
  getControlView,
  getInputView,
  getPositionsA,
  getPositionsB,
  getReactionForces,
  INPUT_DT,
  INPUT_SUBSTEPS,
  INPUT_ITERATIONS,
  INPUT_CONSTRAINT_DAMPING,
  INPUT_CLOTH_MASS,
  INPUT_HOIST_AMOUNT,
  INPUT_WIND_X,
  INPUT_WIND_Y,
  INPUT_LIFT_SCALE,
  INPUT_DRAG_SCALE,
  INPUT_TACK_X,
  INPUT_TACK_Y,
  INPUT_TACK_Z,
  INPUT_CLEW_X,
  INPUT_CLEW_Y,
  INPUT_CLEW_Z,
  INPUT_HEAD_X,
  INPUT_HEAD_Y,
  INPUT_HEAD_Z,
  INPUT_CLEW_PINNED,
  REACTION_TACK_X,
  REACTION_TACK_Y,
  REACTION_HEAD_X,
  REACTION_HEAD_Y,
  REACTION_CLEW_X,
  REACTION_CLEW_Y,
  type ClothWorkerMessage,
} from "./cloth-worker-protocol";

// Gravity in ft/s² (downward in z)
const GRAVITY_Z = -32.174;

let solver: ClothSolver | null = null;
let control: Int32Array;
let input: Float64Array;
let posA: Float64Array;
let posB: Float64Array;
let reactions: Float64Array;
let vertexCount: number;
let indices: number[];
let tackIdx: number;
let clewIdx: number;
let headIdx: number;
let running = false;

self.onmessage = (e: MessageEvent<ClothWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    vertexCount = msg.vertexCount;
    indices = msg.indices;
    tackIdx = msg.tackIdx;
    clewIdx = msg.clewIdx;
    headIdx = msg.headIdx;

    // Reconstruct solver from snapshot
    solver = ClothSolver.fromSnapshot({
      vertexCount: msg.vertexCount,
      positions: msg.positions,
      prevPositions: msg.prevPositions,
      pinned: msg.pinned,
      pinTargets: msg.pinTargets,
      structA: msg.structA,
      structB: msg.structB,
      structRest: msg.structRest,
      shearA: msg.shearA,
      shearB: msg.shearB,
      shearRest: msg.shearRest,
      bendA: msg.bendA,
      bendB: msg.bendB,
      bendRest: msg.bendRest,
      damping: msg.damping,
      bendStiffness: msg.bendStiffness,
      constraintDamping: msg.constraintDamping,
    });

    // Set up SAB views
    control = getControlView(msg.sab);
    input = getInputView(msg.sab);
    posA = getPositionsA(msg.sab, vertexCount);
    posB = getPositionsB(msg.sab, vertexCount);
    reactions = getReactionForces(msg.sab, vertexCount);

    // Write initial positions to both buffers
    for (let i = 0; i < vertexCount; i++) {
      const i3 = i * 3;
      posA[i3] = solver.getPositionX(i);
      posA[i3 + 1] = solver.getPositionY(i);
      posA[i3 + 2] = solver.getZ(i);
      posB[i3] = posA[i3];
      posB[i3 + 1] = posA[i3 + 1];
      posB[i3 + 2] = posA[i3 + 2];
    }

    running = true;
    solveLoop();
  } else if (msg.type === "destroy") {
    running = false;
    solver = null;
  }
};

function solveLoop() {
  while (running && solver) {
    // Wait until main thread signals SOLVING
    const result = Atomics.wait(control, 0, CLOTH_IDLE);
    if (!running || !solver) break;
    if (result === "not-equal") {
      // State was already changed — check if it's SOLVING
      const state = Atomics.load(control, 0);
      if (state !== CLOTH_SOLVING) continue;
    }

    // Read inputs from SAB
    const dt = input[INPUT_DT];
    const substeps = input[INPUT_SUBSTEPS];
    const iterations = input[INPUT_ITERATIONS];
    const constraintDamping = input[INPUT_CONSTRAINT_DAMPING];
    const clothMass = input[INPUT_CLOTH_MASS];
    const hoistAmount = input[INPUT_HOIST_AMOUNT];
    const windX = input[INPUT_WIND_X];
    const windY = input[INPUT_WIND_Y];
    const liftScale = input[INPUT_LIFT_SCALE];
    const dragScale = input[INPUT_DRAG_SCALE];
    const clewPinned = input[INPUT_CLEW_PINNED] !== 0;

    // Update solver config
    solver.setConstraintDamping(constraintDamping);

    // Update pin targets
    solver.setPinTarget(
      tackIdx,
      input[INPUT_TACK_X],
      input[INPUT_TACK_Y],
      input[INPUT_TACK_Z],
    );
    solver.setPinTarget(
      clewIdx,
      input[INPUT_CLEW_X],
      input[INPUT_CLEW_Y],
      input[INPUT_CLEW_Z],
    );
    solver.setPinTarget(
      headIdx,
      input[INPUT_HEAD_X],
      input[INPUT_HEAD_Y],
      input[INPUT_HEAD_Z],
    );

    // Ensure pin state matches
    solver.setPinned(tackIdx, true);
    solver.setPinned(headIdx, true);
    solver.setPinned(clewIdx, clewPinned);

    // Apply forces and run solver
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
      sumTackRx += solver.getReactionForceX(tackIdx);
      sumTackRy += solver.getReactionForceY(tackIdx);
      sumHeadRx += solver.getReactionForceX(headIdx);
      sumHeadRy += solver.getReactionForceY(headIdx);
      sumClewRx += solver.getReactionForceX(clewIdx);
      sumClewRy += solver.getReactionForceY(clewIdx);
    }

    // Write reaction forces (averaged across substeps)
    reactions[REACTION_TACK_X] = sumTackRx;
    reactions[REACTION_TACK_Y] = sumTackRy;
    reactions[REACTION_HEAD_X] = sumHeadRx;
    reactions[REACTION_HEAD_Y] = sumHeadRy;
    reactions[REACTION_CLEW_X] = sumClewRx;
    reactions[REACTION_CLEW_Y] = sumClewRy;

    // Write positions to back buffer
    const swapFlag = Atomics.load(control, 1);
    const backBuffer = swapFlag === 0 ? posB : posA;
    for (let i = 0; i < vertexCount; i++) {
      const i3 = i * 3;
      backBuffer[i3] = solver.getPositionX(i);
      backBuffer[i3 + 1] = solver.getPositionY(i);
      backBuffer[i3 + 2] = solver.getZ(i);
    }

    // Flip swap flag
    Atomics.store(control, 1, swapFlag === 0 ? 1 : 0);

    // Signal done
    Atomics.store(control, 0, CLOTH_DONE);
    Atomics.notify(control, 0);
  }
}
