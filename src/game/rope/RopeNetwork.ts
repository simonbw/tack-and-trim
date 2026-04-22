/**
 * Capstan-network rope entity.
 *
 * Owns an ordered list of nodes (endpoints, blocks, winches) and the
 * scalar-length sections between them. Each tick, refreshes each node's
 * world position from its body, runs the pure capstan solver, and applies
 * the resulting tensions as forces at node anchors.
 *
 * Rendering is handled separately in Phase 3 by `RopeRender`; this entity
 * exposes enough state for that module (and for material-v computation)
 * via read-only accessors. Phase 2 provides a naive straight-chord sampler
 * so callers can render the rope while the full render layer is still
 * under construction.
 *
 * Hull interaction is intentionally absent from the physics: obstacles
 * and deck contact are render-only concerns.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { GameEventMap } from "../../core/entity/Entity";
import type { Body } from "../../core/physics/body/Body";
import { profiler } from "../../core/util/Profiler";
import { V3d, type CompatibleVector3 } from "../../core/Vector3";
import {
  type CapstanConfig,
  type CapstanNode,
  type CapstanSection,
  DEFAULT_CAPSTAN_CONFIG,
  computeNodeForce,
  solveNetwork,
} from "./capstan";
import { makeRopeNode, refreshWorldPos, type RopeNodeRef } from "./RopeNode";
import { makeRopeSection } from "./RopeSection";
import { RopeTail } from "./RopeTail";

/** Input spec for a node when constructing a RopeNetwork. */
export interface RopeNetworkNodeSpec {
  body: Body;
  localAnchor: CompatibleVector3;
  kind: CapstanNode["kind"];
  /** Friction coefficient. Only meaningful for interior nodes. Default 0. */
  mu?: number;
}

export interface RopeNetworkConfig {
  /** Total rope length (ft). Seeded at startup; winch flow conserves it. */
  totalLength: number;
  /** Tail length at spawn when the last node is `kind: "free"`. Default 4. */
  tailLength?: number;
  /** Number of Verlet particles in the decorative tail. Default 7. */
  tailParticleCount?: number;
  /** Solver configuration. Defaults to `DEFAULT_CAPSTAN_CONFIG`. */
  solver?: Partial<CapstanConfig>;
}

// Scratch force vector reused by the tick loop to avoid per-tick allocation.
const SCRATCH_FORCE: [number, number, number] = [0, 0, 0];

export class RopeNetwork extends BaseEntity {
  private readonly nodes: RopeNodeRef[];
  private readonly sections: CapstanSection[];
  private readonly solverConfig: CapstanConfig;
  private readonly tail: RopeTail | null;
  private readonly totalRopeLength: number;

  constructor(nodeSpecs: RopeNetworkNodeSpec[], config: RopeNetworkConfig) {
    super();
    if (nodeSpecs.length < 2) {
      throw new Error("RopeNetwork requires at least 2 nodes.");
    }

    this.nodes = nodeSpecs.map((s) =>
      makeRopeNode({
        body: s.body,
        localAnchor: s.localAnchor,
        kind: s.kind,
        mu: s.mu ?? 0,
      }),
    );

    // Seed section rest-lengths. Strategy: working-side sections start
    // near-taut (chord + ~5% slack) so they render as subtle arcs rather
    // than huge V-shapes. The last section absorbs all remaining rope as
    // the "tail coil" — the part of the rope that sits loose near the
    // final anchor point (cockpit for sheets, bow locker for anchor rodes).
    const chords = this.nodes
      .slice(0, -1)
      .map((_, i) => chordBetween(this.nodes[i], this.nodes[i + 1]));
    const chordSum = chords.reduce((a, b) => a + b, 0);
    this.totalRopeLength = Math.max(config.totalLength, chordSum);

    const workingSlack = 0.05;
    const sections: CapstanSection[] = [];
    let assigned = 0;
    for (let i = 0; i < chords.length; i++) {
      let length: number;
      if (i === chords.length - 1) {
        // Last section soaks up all remaining material.
        length = Math.max(chords[i], this.totalRopeLength - assigned);
      } else {
        length = chords[i] * (1 + workingSlack);
      }
      assigned += length;
      sections.push(makeRopeSection(length));
    }
    this.sections = sections;

    this.solverConfig = { ...DEFAULT_CAPSTAN_CONFIG, ...config.solver };

    // Free-end tail: if the last node is kind "free", spawn a decorative
    // Verlet chain there.
    const lastNode = this.nodes[this.nodes.length - 1];
    if (lastNode.kind === "free") {
      this.tail = new RopeTail(lastNode, {
        length: config.tailLength ?? 4,
        count: config.tailParticleCount ?? 7,
      });
      this.addChild(this.tail);
    } else {
      this.tail = null;
    }
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    profiler.start("rope.network.tick");
    // 1. Refresh every node's world position from its body.
    for (const node of this.nodes) {
      refreshWorldPos(node);
    }

    // 2. Run the solver in place on sections.
    solveNetwork(this.nodes, this.sections, dt, this.solverConfig);

    // 3. Apply tension forces to each node's body.
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      const body = node.body;
      if (body.motion !== "dynamic") continue;
      computeNodeForce(this.nodes, this.sections, i, SCRATCH_FORCE);
      if (
        SCRATCH_FORCE[0] === 0 &&
        SCRATCH_FORCE[1] === 0 &&
        SCRATCH_FORCE[2] === 0
      ) {
        continue;
      }
      body.applyForce3D(
        SCRATCH_FORCE[0],
        SCRATCH_FORCE[1],
        SCRATCH_FORCE[2],
        node.localAnchor[0],
        node.localAnchor[1],
        node.localAnchor[2],
      );
    }
    profiler.end("rope.network.tick");
  }

  // ─── Queries ─────────────────────────────────────────────────────

  getNodeCount(): number {
    return this.nodes.length;
  }

  getNode(i: number): RopeNodeRef {
    return this.nodes[i];
  }

  getSectionCount(): number {
    return this.sections.length;
  }

  getSection(i: number): CapstanSection {
    return this.sections[i];
  }

  /** Total rope length set at construction. Conserved by solver flow. */
  getTotalLength(): number {
    return this.totalRopeLength;
  }

  /**
   * Cumulative material length from node 0 up to the given node.
   * Node 0 → 0; node k-1 → total rope length. Used for computing
   * working length and render material-v coordinates.
   */
  getMaterialLengthAt(nodeIdx: number): number {
    let sum = 0;
    for (let i = 0; i < nodeIdx && i < this.sections.length; i++) {
      sum += this.sections[i].length;
    }
    return sum;
  }

  /** Tension in a specific section (engine-force units). */
  getSectionTension(sectionIdx: number): number {
    return this.sections[sectionIdx].tension;
  }

  /**
   * Peak tension in the sections adjacent to the given (typically winch)
   * node. Used by the sound system to detect shock loads.
   */
  getPeakTensionAt(nodeIdx: number): number {
    let peak = 0;
    if (nodeIdx > 0) {
      peak = Math.max(peak, this.sections[nodeIdx - 1].tension);
    }
    if (nodeIdx < this.sections.length) {
      peak = Math.max(peak, this.sections[nodeIdx].tension);
    }
    return peak;
  }

  getTail(): RopeTail | null {
    return this.tail;
  }

  // ─── Winch / block control (invoked by RopeBlock adapter) ────────

  /**
   * Move length between the two sections adjacent to the given winch node
   * so that the sum of sections strictly before the node equals the target.
   * Used by `RopeBlock.setWorkingLength` for initial positioning.
   */
  /**
   * Shift length between the winch's two adjacent sections so the section
   * immediately upstream of the winch gets the requested new length. The
   * rest of the working chain re-equilibrates naturally via capstan flow
   * over the next few ticks.
   */
  setWorkingLengthAt(winchNodeIdx: number, targetWorkingLength: number): void {
    const sL = this.sections[winchNodeIdx - 1];
    const sR = this.sections[winchNodeIdx];
    if (!sL || !sR) return;

    const leftPrefix = this.getMaterialLengthAt(winchNodeIdx - 1);
    const targetSL = targetWorkingLength - leftPrefix;
    const totalAdjacent = sL.length + sR.length;
    const clampedSL = Math.max(0, Math.min(totalAdjacent, targetSL));
    const delta = sL.length - clampedSL;
    sL.length = clampedSL;
    sR.length += delta;
  }

  setWinchRatchet(winchNodeIdx: number, sign: 0 | 1 | -1): void {
    const node = this.nodes[winchNodeIdx];
    if (node && node.kind === "winch") {
      node.ratchetSign = sign;
    }
  }

  setWinchFlowRate(winchNodeIdx: number, rate: number): void {
    const node = this.nodes[winchNodeIdx];
    if (node && node.kind === "winch") {
      node.flowRateIn = rate;
    }
  }

  clearWinchFlowRate(winchNodeIdx: number): void {
    const node = this.nodes[winchNodeIdx];
    if (node && node.kind === "winch") {
      node.flowRateIn = 0;
    }
  }

  // ─── Rendering (Phase 2 stub) ────────────────────────────────────

  /**
   * Naive straight-chord sampler: returns one point per node + tail particle.
   * Phase 3 replaces this with `RopeRender.computeRenderSamples` producing
   * catenary + oscillator + deck-clamp curves. Here to keep Sheet/Anchor's
   * public API alive during the migration.
   */
  getPointsWithZ(): { points: [number, number][]; z: number[] } {
    const points: [number, number][] = [];
    const z: number[] = [];
    for (const node of this.nodes) {
      points.push([node.worldPos[0], node.worldPos[1]]);
      z.push(node.worldPos[2]);
    }
    if (this.tail) {
      const tailPos = this.tail.getPositions();
      // First tail particle is pinned to the last node; skip it to avoid dup.
      for (let i = 1; i < tailPos.length; i++) {
        points.push([tailPos[i][0], tailPos[i][1]]);
        z.push(tailPos[i][2]);
      }
    }
    return { points, z };
  }
}

function chordBetween(a: RopeNodeRef, b: RopeNodeRef): number {
  const dx = b.worldPos[0] - a.worldPos[0];
  const dy = b.worldPos[1] - a.worldPos[1];
  const dz = b.worldPos[2] - a.worldPos[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
