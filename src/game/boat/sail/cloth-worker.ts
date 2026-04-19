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
let vertexChordFrac: Float64Array;
// Per-vertex active flag (reused each frame, allocated once)
let vertexActive: Uint8Array;
let prevActive: Uint8Array;
// Per-vertex rest-shape world position for this frame (recomputed each solve).
let restShape: Float64Array;
// Previous frame's rest-shape positions. Used to give newly-active verts the
// boat's velocity (translation + rotation) via Verlet prev = prevRestShape,
// so they don't appear motionless against moving neighbors.
let prevRestShape: Float64Array;
let restShapeInitialized = false;
// Per-vertex activation blend weight [0,1]. 0 = pinned at rest shape, 1 = fully
// free. In the band just below the hoist threshold it ramps smoothly so rows
// ease into the simulation instead of snapping on.
let vertexBlend: Float64Array;
// Width of the activation band (in v units). Rows within this many v below
// the threshold are partially active.
const ACTIVATION_BAND = 0.1;

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
    vertexChordFrac = msg.vertexChordFrac;
    vertexActive = new Uint8Array(vertexCount);
    prevActive = new Uint8Array(vertexCount);
    restShape = new Float64Array(vertexCount * 3);
    prevRestShape = new Float64Array(vertexCount * 3);
    restShapeInitialized = false;
    vertexBlend = new Float64Array(vertexCount);

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

/** Compute rest-shape world position for every vertex into `out`. */
function computeRestShape(
  out: Float64Array,
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
  const chordX = clewX - tackX;
  const chordY = clewY - tackY;
  for (let i = 0; i < vertexCount; i++) {
    const u = vertexU[i];
    const v = vertexV[i];
    const cf = vertexChordFrac[i];
    const i3 = i * 3;
    out[i3] = tackX + v * (headX - tackX) + u * cf * chordX;
    out[i3 + 1] = tackY + v * (headY - tackY) + u * cf * chordY;
    out[i3 + 2] = tackZ + v * (headZ - tackZ);
  }
}

/** Smoothstep for activation band: returns the fraction active in [0,1]. */
function computeBlend(i: number, hoistAmount: number): number {
  const excess =
    furlMode === "v-cutoff"
      ? hoistAmount - vertexV[i]
      : vertexU[i] - (1 - hoistAmount);
  if (excess <= 0) return 0;
  if (excess >= ACTIVATION_BAND) return 1;
  const t = excess / ACTIVATION_BAND;
  return t * t * (3 - 2 * t);
}

/**
 * Compute per-vertex blend weights and set up pins/skipped state. Verts with
 * blend=0 are skipped and snapped to rest shape; blend in (0,1) are active
 * but soft-pinned toward rest shape post-solve; blend=1 are fully free.
 * Luff verts are hard-pinned to the mast/forestay whenever active at all
 * (blend>0) so the sail stays attached.
 */
function updateFurlState(
  solver: ClothSolver,
  hoistAmount: number,
  restShape: Float64Array,
  prevRestShape: Float64Array,
  clewPinned: boolean,
): void {
  // Compute blend weights and active flags
  for (let i = 0; i < vertexCount; i++) {
    const w = computeBlend(i, hoistAmount);
    vertexBlend[i] = w;
    vertexActive[i] = w > 0 ? 1 : 0;
  }

  // In u-wrap mode (jib), the luff is the furling axis itself — the sail
  // unrolls away from u=0 toward u=1. computeBlend would give every luff
  // vert (u=0) a blend of 0, leaving the luff permanently unpinned. Force
  // luff verts fully active so they get hard-pinned to the forestay whenever
  // any part of the sail is deployed.
  if (furlMode === "u-wrap" && hoistAmount > 0) {
    for (const li of luffVertices) {
      vertexBlend[li] = 1;
      vertexActive[li] = 1;
    }
  }

  // Clear all pin and skipped states — we'll set them fresh each frame
  for (let i = 0; i < vertexCount; i++) {
    solver.setPinned(i, false);
    solver.setSkipped(i, false);
  }

  // Luff verts: hard-pinned at mast/forestay when active; skipped otherwise.
  // Their pin targets come from the rest shape (which is exactly the luff
  // line at their v). Previous pos from prevRestShape so boat motion carries.
  const luffSet = new Set(luffVertices);
  for (const li of luffVertices) {
    const i3 = li * 3;
    if (vertexActive[li]) {
      solver.setPinned(li, true);
      solver.setPinTarget(
        li,
        restShape[i3],
        restShape[i3 + 1],
        restShape[i3 + 2],
      );
    }
  }

  // Non-luff skipped verts (blend=0): write rest-shape position with prev=
  // prevRestShape so the rendered position tracks boat motion, and any future
  // activation inherits the boat's velocity.
  for (let i = 0; i < vertexCount; i++) {
    if (luffSet.has(i)) continue;
    if (!vertexActive[i]) {
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

  // Clew pin (mainsail boom constraint). Only pinned when fully active —
  // soft pinning a hard-attached point would look weird.
  if (clewPinned && vertexBlend[clewIdx] >= 1) {
    solver.setPinned(clewIdx, true);
  }

  // On inactive→active transition (blend crossing 0→positive), seed position
  // to rest shape with prev=prevRestShape so the new vert inherits the boat's
  // velocity (world-space translation + rotation of the pin field).
  for (let i = 0; i < vertexCount; i++) {
    if (vertexActive[i] && !prevActive[i]) {
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
    prevActive[i] = vertexActive[i];
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

    const clewInputX = input[INPUT_CLEW_X];
    const clewInputY = input[INPUT_CLEW_Y];
    const clewInputZ = input[INPUT_CLEW_Z];

    // Update clew pin target (for mainsail boom constraint)
    solver.setPinTarget(clewIdx, clewInputX, clewInputY, clewInputZ);

    // Compute rest-shape positions for every vertex this frame. On very first
    // frame, seed prev = current so initial velocity is zero.
    computeRestShape(
      restShape,
      tackX,
      tackY,
      tackZ,
      clewInputX,
      clewInputY,
      clewInputZ,
      headX,
      headY,
      headZ,
    );
    if (!restShapeInitialized) {
      prevRestShape.set(restShape);
      restShapeInitialized = true;
    }

    // Set up blend weights, luff pins, skipped verts, activation seeding
    updateFurlState(solver, hoistAmount, restShape, prevRestShape, clewPinned);

    // Apply forces and run solver
    const vertexMass = clothMass / vertexCount;
    solver.clearForces();

    // Gravity — scaled by blend so partially-active verts ease in
    const gravZ = GRAVITY_Z * vertexMass;
    for (let i = 0; i < vertexCount; i++) {
      const w = vertexBlend[i];
      if (w > 0) {
        solver.applyForce(i, 0, 0, gravZ * w);
      }
    }

    // Aerodynamic forces — scaled by minimum blend weight across the triangle
    if (hoistAmount > 0 && (windX !== 0 || windY !== 0)) {
      const invVertexMass = 1 / vertexMass;
      for (let t = 0; t < indices.length; t += 3) {
        const i0 = indices[t];
        const i1 = indices[t + 1];
        const i2 = indices[t + 2];

        const w0 = vertexBlend[i0];
        const w1 = vertexBlend[i1];
        const w2 = vertexBlend[i2];
        const wTri = Math.min(w0, w1, w2);
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

    // Post-solve soft pin: partially-active verts (0 < blend < 1) get pulled
    // toward rest shape by (1 - blend). This blends smoothly from fully
    // pinned-at-rest (blend=0) to fully free (blend=1) as hoist progresses.
    for (let i = 0; i < vertexCount; i++) {
      const w = vertexBlend[i];
      if (w <= 0 || w >= 1) continue;
      const i3 = i * 3;
      solver.blendTowardTarget(
        i,
        restShape[i3],
        restShape[i3 + 1],
        restShape[i3 + 2],
        prevRestShape[i3],
        prevRestShape[i3 + 1],
        prevRestShape[i3 + 2],
        1 - w,
      );
    }

    // Store current rest shape for next frame's velocity estimation
    prevRestShape.set(restShape);

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
