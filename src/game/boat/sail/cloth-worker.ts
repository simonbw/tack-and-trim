/**
 * Web Worker for cloth sail simulation.
 * Runs ClothSolver + aerodynamic forces off the main thread.
 * Communicates via SharedArrayBuffer + Atomics.
 *
 * Supports two furl modes:
 * - "v-cutoff": mainsail in-boom roller — vertices above v threshold are excluded
 * - "u-wrap": jib forestay roller — vertices below u threshold are pinned to forestay
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
  REACTION_TACK_Z,
  REACTION_HEAD_X,
  REACTION_HEAD_Y,
  REACTION_HEAD_Z,
  REACTION_CLEW_X,
  REACTION_CLEW_Y,
  REACTION_CLEW_Z,
  type ClothWorkerMessage,
  type FurlMode,
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

// Furling data
let furlMode: FurlMode;
let luffVertices: number[];
let vertexU: Float64Array;
let vertexV: Float64Array;
// Per-vertex active flag (reused each frame, allocated once)
let vertexActive: Uint8Array;
// Previous frame's active flags — used to detect skipped→active transitions
let prevVertexActive: Uint8Array;

self.onmessage = (e: MessageEvent<ClothWorkerMessage>) => {
  const msg = e.data;

  if (msg.type === "init") {
    vertexCount = msg.vertexCount;
    indices = msg.indices;
    tackIdx = msg.tackIdx;
    clewIdx = msg.clewIdx;
    headIdx = msg.headIdx;

    // Store furling data
    furlMode = msg.furlMode;
    luffVertices = msg.luffVertices;
    vertexU = msg.vertexU;
    vertexV = msg.vertexV;
    vertexActive = new Uint8Array(vertexCount);
    prevVertexActive = new Uint8Array(vertexCount);

    // Reconstruct solver from snapshot
    solver = ClothSolver.fromSnapshot({
      vertexCount: msg.vertexCount,
      positions: msg.positions,
      prevPositions: msg.prevPositions,
      pinned: msg.pinned,
      pinTargets: msg.pinTargets,
      skipped: msg.skipped,
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

/**
 * Compute active vertex flags and set up pins/skipped state based on furl mode.
 *
 * v-cutoff (mainsail): active if v <= hoistAmount. Inactive vertices are skipped.
 *   All active luff vertices are pinned to the mast (lerp tack→head by v).
 *
 * u-wrap (jib): active if u >= (1 - hoistAmount). Inactive vertices are pinned
 *   to the forestay (lerp tack→head by v). Cross-boundary constraints are kept.
 */
function updateFurlState(
  solver: ClothSolver,
  hoistAmount: number,
  tackX: number,
  tackY: number,
  tackZ: number,
  headX: number,
  headY: number,
  headZ: number,
  clewPinned: boolean,
): void {
  // Compute per-vertex active flags
  if (furlMode === "v-cutoff") {
    for (let i = 0; i < vertexCount; i++) {
      vertexActive[i] = vertexV[i] <= hoistAmount ? 1 : 0;
    }
  } else {
    // u-wrap
    const wrapThreshold = 1 - hoistAmount;
    for (let i = 0; i < vertexCount; i++) {
      vertexActive[i] = vertexU[i] >= wrapThreshold ? 1 : 0;
    }
  }

  // Reset vertices that just transitioned from skipped to active (v-cutoff only).
  // Skipped vertices don't get their positions updated, so they drift as the boat
  // moves. Without this reset they enter the Verlet integrator at stale positions,
  // causing explosive constraint corrections.
  if (furlMode === "v-cutoff") {
    for (let i = 0; i < vertexCount; i++) {
      if (vertexActive[i] && !prevVertexActive[i]) {
        const v = vertexV[i];
        solver.resetVertex(
          i,
          tackX + v * (headX - tackX),
          tackY + v * (headY - tackY),
          tackZ + v * (headZ - tackZ),
        );
      }
    }
  }

  // Save active state for next frame's transition detection
  prevVertexActive.set(vertexActive);

  // Clear all pin and skip states — we'll set them fresh each frame
  for (let i = 0; i < vertexCount; i++) {
    solver.setPinned(i, false);
    solver.setSkipped(i, false);
  }

  // Pin all active luff vertices to the mast/forestay (lerp tack→head by v)
  for (const li of luffVertices) {
    if (!vertexActive[li] && furlMode === "v-cutoff") continue;
    const v = vertexV[li];
    solver.setPinned(li, true);
    solver.setPinTarget(
      li,
      tackX + v * (headX - tackX),
      tackY + v * (headY - tackY),
      tackZ + v * (headZ - tackZ),
    );
  }

  if (furlMode === "v-cutoff") {
    // Skip all inactive vertices — they're inside the boom
    for (let i = 0; i < vertexCount; i++) {
      if (!vertexActive[i]) {
        solver.setSkipped(i, true);
      }
    }
  } else {
    // u-wrap: pin wrapped (inactive) vertices to forestay at their v-height
    for (let i = 0; i < vertexCount; i++) {
      if (!vertexActive[i]) {
        const v = vertexV[i];
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

  // Clew pin (mainsail boom constraint)
  if (clewPinned && vertexActive[clewIdx]) {
    solver.setPinned(clewIdx, true);
  }
}

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

    const tackX = input[INPUT_TACK_X];
    const tackY = input[INPUT_TACK_Y];
    const tackZ = input[INPUT_TACK_Z];
    const headX = input[INPUT_HEAD_X];
    const headY = input[INPUT_HEAD_Y];
    const headZ = input[INPUT_HEAD_Z];

    // Update solver config
    solver.setConstraintDamping(constraintDamping);

    // Update clew pin target (for mainsail boom constraint)
    solver.setPinTarget(
      clewIdx,
      input[INPUT_CLEW_X],
      input[INPUT_CLEW_Y],
      input[INPUT_CLEW_Z],
    );

    // Set up furl state: active flags, luff pins, skipped vertices
    updateFurlState(
      solver,
      hoistAmount,
      tackX,
      tackY,
      tackZ,
      headX,
      headY,
      headZ,
      clewPinned,
    );

    // Apply forces and run solver
    const vertexMass = clothMass / vertexCount;
    solver.clearForces();

    // Gravity — only for active, non-skipped vertices
    const gravZ = GRAVITY_Z * vertexMass;
    for (let i = 0; i < vertexCount; i++) {
      if (vertexActive[i]) {
        solver.applyForce(i, 0, 0, gravZ);
      }
    }

    // Aerodynamic forces — only on active triangles (all 3 vertices active)
    if (hoistAmount > 0 && (windX !== 0 || windY !== 0)) {
      const invVertexMass = 1 / vertexMass;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

        // Skip triangle if any vertex is inactive
        if (!vertexActive[i0] || !vertexActive[i1] || !vertexActive[i2])
          continue;

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

    // Accumulate 3D reaction forces from all luff pins and clew
    let sumLuffRx = 0,
      sumLuffRy = 0,
      sumLuffRz = 0;
    let sumClewRx = 0,
      sumClewRy = 0,
      sumClewRz = 0;

    for (let s = 0; s < substeps; s++) {
      solver.update(subDt, subIter);

      // Sum reaction forces from all active luff vertices
      for (const li of luffVertices) {
        if (vertexActive[li]) {
          sumLuffRx += solver.getReactionForceX(li);
          sumLuffRy += solver.getReactionForceY(li);
          sumLuffRz += solver.getReactionForceZ(li);
        }
      }

      sumClewRx += solver.getReactionForceX(clewIdx);
      sumClewRy += solver.getReactionForceY(clewIdx);
      sumClewRz += solver.getReactionForceZ(clewIdx);
    }

    // Write 3D reaction forces — luff sum goes into TACK+HEAD slots
    reactions[REACTION_TACK_X] = 0;
    reactions[REACTION_TACK_Y] = 0;
    reactions[REACTION_TACK_Z] = 0;
    reactions[REACTION_HEAD_X] = sumLuffRx;
    reactions[REACTION_HEAD_Y] = sumLuffRy;
    reactions[REACTION_HEAD_Z] = sumLuffRz;
    reactions[REACTION_CLEW_X] = sumClewRx;
    reactions[REACTION_CLEW_Y] = sumClewRy;
    reactions[REACTION_CLEW_Z] = sumClewRz;

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
