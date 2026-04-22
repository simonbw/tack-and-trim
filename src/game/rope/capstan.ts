/**
 * Pure capstan-network rope solver.
 *
 * A rope is modeled as an ordered list of nodes (endpoints, blocks, winches)
 * with scalar-length sections between them. Each interior node may have a
 * Coulomb friction coefficient μ; the capstan equation bounds the ratio of
 * tensions on either side to [e^{-μθ}, e^{+μθ}] where θ is the bend angle.
 * When the tension ratio exceeds the bound, length flows between adjacent
 * sections at a rate proportional to the excess.
 *
 * This module is deliberately free of entity and physics-engine imports:
 * callers pass in world positions (already resolved via `toWorldFrame3D`)
 * and receive updated section lengths + tensions. The caller is responsible
 * for applying tensions as forces on bodies.
 *
 * Sign conventions:
 *  - Node index 0 is the "far" endpoint (sail clew, anchor body).
 *  - Last node is the "tail" endpoint (free end or hull tie-off).
 *  - Section i connects nodes i and i+1.
 *  - Flow > 0 at node i means length moves from section i-1 (working side)
 *    to section i (tail side). This is the "trim in" direction at a winch.
 */

import type { ReadonlyV3d } from "../../core/Vector3";

/**
 * A node in the rope network. `worldPos` must be filled by the caller each
 * tick (typically from `body.toWorldFrame3D(localAnchor)` into a reusable
 * V3d). The solver only reads `worldPos` and the friction / winch fields.
 */
export interface CapstanNode {
  worldPos: ReadonlyV3d;
  /** Coulomb friction coefficient at this node. 0 = frictionless. */
  mu: number;
  kind: "endpoint" | "block" | "winch" | "free";
  /**
   * Winch ratchet. Ignored unless `kind === "winch"`.
   *  0 = free (rope can slide either way)
   * +1 = ratchet (flow must be ≥ 0 — working side can shrink but not grow)
   * -1 = reverse ratchet (flow must be ≤ 0 — only ease). Rarely used.
   */
  ratchetSign?: 0 | 1 | -1;
  /**
   * Externally-applied length-flow rate at this winch (ft/s). Positive =
   * trim (length flows working → tail). Pulley/winch adapters translate
   * their `applyForce(magnitude, maxSpeed)` into a value here.
   */
  flowRateIn?: number;
  /**
   * Maximum force the winch can apply to pull rope through (engine-force
   * units). The effective trim rate tapers to zero as working-side tension
   * approaches this limit — without it, a player cranking against a taut
   * sheet keeps driving length out, spiking tension unbounded and creating
   * runaway torque on the hull via the mast↔block lever arm.
   */
  winchMaxForce?: number;
}

/**
 * A section between nodes i and i+1. Mutated in place by the solver.
 */
export interface CapstanSection {
  /** Rest length of the rope in this section (ft). Updated by flow. */
  length: number;
  /** Output: straight-line distance between the two adjacent node worldPos. */
  chord: number;
  /** Previous tick's chord, for chord-rate damping. NaN = uninitialized. */
  prevChord: number;
  /** Output: current tension (engine-force units). */
  tension: number;
  /** Output: cumulative signed length flow this tick (ft). For render v-offset. */
  flow: number;
}

export interface CapstanConfig {
  /** Axial stiffness (force per ft of strain). Higher = stiffer rope. */
  kAxial: number;
  /**
   * Damping coefficient for chord-rate-of-change (force per ft/s).
   * A stiff spring without this oscillates indefinitely; add damping
   * to absorb energy and settle transient tension spikes.
   */
  cDamping: number;
  /**
   * Upper bound on tension (engine-force units) applied via section forces.
   * During trim transients where the length shrinks faster than the far
   * body can move in, strain-based tension can spike arbitrarily high;
   * capping prevents runaway torque on attached bodies.
   */
  maxTension: number;
  /**
   * Length-flow rate coefficient. Capstan-bound excess (in tension units)
   * is multiplied by this and `dt` to produce flow in ft per tick.
   * Larger = snappier capstan response, smaller = more damped.
   */
  flowRateCoef: number;
  /** Jacobi sweeps per tick. 3–6 is a sweet spot for small topologies. */
  iterations: number;
  /** Chord lengths below this are considered degenerate (zero tension). */
  degenerateChord: number;
}

export const DEFAULT_CAPSTAN_CONFIG: CapstanConfig = {
  kAxial: 2000,
  cDamping: 200,
  maxTension: 3000,
  flowRateCoef: 0.005,
  iterations: 4,
  degenerateChord: 1e-4,
};

/** Allocate a fresh section with zero length (caller seeds from chord). */
export function makeSection(length: number = 0): CapstanSection {
  // prevChord = NaN signals "uninitialized" — first solveNetwork() call
  // seeds it from the current chord so we don't apply spurious damping
  // based on a zero previous value.
  return { length, chord: 0, prevChord: NaN, tension: 0, flow: 0 };
}

/**
 * Advance the rope network by one tick.
 *
 * Reads node worldPos (assumed fresh this tick), writes section chord,
 * tension, length (via flow), and flow accumulator.
 */
export function solveNetwork(
  nodes: readonly CapstanNode[],
  sections: CapstanSection[],
  dt: number,
  config: CapstanConfig = DEFAULT_CAPSTAN_CONFIG,
): void {
  const k = nodes.length;
  if (k < 2 || sections.length !== k - 1) return;

  // 1. Chord distances (fixed for the whole tick — node worldPos doesn't
  //    change during solve; body integration happens later). Also seed
  //    prevChord on first use so the initial tick doesn't see a spurious
  //    huge chord-rate from NaN/zero.
  for (let i = 0; i < sections.length; i++) {
    const a = nodes[i].worldPos;
    const b = nodes[i + 1].worldPos;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    sections[i].chord = Math.sqrt(dx * dx + dy * dy + dz * dz);
    sections[i].flow = 0;
    if (!isFinite(sections[i].prevChord)) {
      sections[i].prevChord = sections[i].chord;
    }
  }

  // 2. Jacobi sweeps: (a) recompute tensions, (b) capstan redistribution at
  //    interior nodes, (c) winch-driven flow injection.
  for (let iter = 0; iter < config.iterations; iter++) {
    recomputeTensions(sections, config, dt);

    // Capstan sweep at each interior node (friction-bounded tension jump).
    for (let i = 1; i < k - 1; i++) {
      const node = nodes[i];
      const sL = sections[i - 1];
      const sR = sections[i];
      if (
        sL.chord < config.degenerateChord ||
        sR.chord < config.degenerateChord
      ) {
        continue;
      }

      const theta = bendAngle(nodes, i, sL.chord, sR.chord);
      const maxRatio = Math.exp(node.mu * theta);

      // Add a small floor so a slack side (T=0) doesn't cause infinite ratio.
      const TLref = sL.tension + 1e-3;
      const TRref = sR.tension + 1e-3;

      let flow = 0;
      if (TRref > TLref * maxRatio) {
        const excess = TRref - TLref * maxRatio;
        flow = config.flowRateCoef * excess * dt;
      } else if (TLref > TRref * maxRatio) {
        const excess = TLref - TRref * maxRatio;
        flow = -config.flowRateCoef * excess * dt;
      }

      // A winch's ratchet clamps natural capstan flow too, not just the
      // player-injected flow rate. Without this, the capstan happily lets
      // rope slide through an "engaged" winch whenever the working side
      // is under load — effectively disabling the ratchet.
      if (node.kind === "winch") {
        const ratchet = node.ratchetSign ?? 0;
        if (ratchet === 1 && flow < 0) flow = 0;
        else if (ratchet === -1 && flow > 0) flow = 0;
      }

      flow = clampFlow(flow, sL.length, sR.length);
      sL.length -= flow;
      sR.length += flow;
      sL.flow += flow;
    }

    // Winch-driven flow injection. Positive flowRateIn = trim (L → R).
    // Ratchet is enforced after clamping sign, before clamping availability.
    //
    // Strength cap: the effective rate is scaled down as working-side
    // tension approaches `winchMaxForce`. This models the fact that hand
    // winches can only exert a bounded force; cranking harder against a
    // taut sheet doesn't pull in more rope, it just stops moving. Without
    // this, tension spikes to the kAxial cap on its own and the mast↔block
    // lever arm turns it into a huge yaw torque on the hull.
    for (let i = 1; i < k - 1; i++) {
      const node = nodes[i];
      if (node.kind !== "winch") continue;
      const rate = node.flowRateIn ?? 0;
      if (rate === 0) continue;
      const sL = sections[i - 1];
      const sR = sections[i];

      const maxForce = node.winchMaxForce ?? Infinity;
      let rateScale = 1;
      if (isFinite(maxForce) && maxForce > 0) {
        // Trimming pulls from L → R; tension that resists trim is the
        // working-side (L) tension.
        const workingT = sL.tension;
        rateScale = Math.max(0, 1 - workingT / maxForce);
      }

      let flow = rate * rateScale * dt;
      const ratchet = node.ratchetSign ?? 0;
      if (ratchet === 1 && flow < 0) flow = 0;
      else if (ratchet === -1 && flow > 0) flow = 0;

      flow = clampFlow(flow, sL.length, sR.length);
      sL.length -= flow;
      sR.length += flow;
      sL.flow += flow;
    }
  }

  // 3. Final tension pass so callers see values consistent with final lengths.
  recomputeTensions(sections, config, dt);

  // Clamp non-negative lengths and roll prevChord forward for next tick.
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].length < 0) sections[i].length = 0;
    sections[i].prevChord = sections[i].chord;
  }
}

/**
 * Tension = max(0, min(maxTension, kAxial * strain + cDamping * chord_rate)).
 *
 * The damping term (chord_rate = d/dt (chord)) turns the pure spring into a
 * Kelvin–Voigt element: relative motion between the endpoints dissipates
 * energy, so transient oscillations settle instead of ringing indefinitely.
 * Without it, stiff rope + inertial endpoints form an undamped oscillator
 * that pumps energy back into whatever's driving it (the winch, the boom).
 *
 * Degenerate sections (chord ≈ 0) always get zero tension.
 */
function recomputeTensions(
  sections: CapstanSection[],
  config: CapstanConfig,
  dt: number,
): void {
  const k = config.kAxial;
  const c = config.cDamping;
  const maxT = config.maxTension;
  const invDt = dt > 0 ? 1 / dt : 0;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s.chord < config.degenerateChord) {
      s.tension = 0;
      continue;
    }
    const strain = s.chord - s.length;
    const elastic = strain > 0 ? k * strain : 0;
    const chordRate = (s.chord - s.prevChord) * invDt;
    const damping = c * chordRate;
    let t = elastic + damping;
    if (t < 0) t = 0;
    else if (t > maxT) t = maxT;
    s.tension = t;
  }
}

/**
 * Bend angle θ at an interior node.
 *
 * θ = 0 when rope runs straight through, π when it folds back.
 * Computed as π − angle between the two outgoing direction vectors.
 */
function bendAngle(
  nodes: readonly CapstanNode[],
  i: number,
  chordL: number,
  chordR: number,
): number {
  const pN = nodes[i].worldPos;
  const pL = nodes[i - 1].worldPos;
  const pR = nodes[i + 1].worldPos;
  const invL = 1 / chordL;
  const invR = 1 / chordR;
  const dLx = (pL[0] - pN[0]) * invL;
  const dLy = (pL[1] - pN[1]) * invL;
  const dLz = (pL[2] - pN[2]) * invL;
  const dRx = (pR[0] - pN[0]) * invR;
  const dRy = (pR[1] - pN[1]) * invR;
  const dRz = (pR[2] - pN[2]) * invR;
  let cos = dLx * dRx + dLy * dRy + dLz * dRz;
  if (cos > 1) cos = 1;
  else if (cos < -1) cos = -1;
  return Math.PI - Math.acos(cos);
}

/**
 * Bound a proposed flow by the amount of length available on each side.
 * A flow greater than half the source section's length would drain it
 * entirely in one step; halving prevents a single tick from starving a
 * section before subsequent iterations can re-equilibrate.
 */
function clampFlow(flow: number, leftLen: number, rightLen: number): number {
  const maxOut = leftLen * 0.5;
  const maxIn = rightLen * 0.5;
  if (flow > maxOut) return maxOut;
  if (flow < -maxIn) return -maxIn;
  return flow;
}

/**
 * Compute the net force a node should apply at its anchor, given the
 * tensions in its adjacent sections.
 *
 * Returns a vector pointing in the direction of the net pull. Endpoints
 * (first/last node) have only one neighbor, so only one section contributes.
 *
 * Writes into `outForce` (length 3) and returns it for convenience.
 */
export function computeNodeForce(
  nodes: readonly CapstanNode[],
  sections: readonly CapstanSection[],
  nodeIdx: number,
  outForce: [number, number, number] | Float32Array,
): void {
  outForce[0] = 0;
  outForce[1] = 0;
  outForce[2] = 0;
  const k = nodes.length;
  const pN = nodes[nodeIdx].worldPos;

  if (nodeIdx > 0) {
    const sL = sections[nodeIdx - 1];
    if (sL.chord > 1e-6 && sL.tension > 0) {
      const pL = nodes[nodeIdx - 1].worldPos;
      const scale = sL.tension / sL.chord;
      outForce[0] += (pL[0] - pN[0]) * scale;
      outForce[1] += (pL[1] - pN[1]) * scale;
      outForce[2] += (pL[2] - pN[2]) * scale;
    }
  }
  if (nodeIdx < k - 1) {
    const sR = sections[nodeIdx];
    if (sR.chord > 1e-6 && sR.tension > 0) {
      const pR = nodes[nodeIdx + 1].worldPos;
      const scale = sR.tension / sR.chord;
      outForce[0] += (pR[0] - pN[0]) * scale;
      outForce[1] += (pR[1] - pN[1]) * scale;
      outForce[2] += (pR[2] - pN[2]) * scale;
    }
  }
}
