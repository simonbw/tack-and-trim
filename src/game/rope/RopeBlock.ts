/**
 * Thin adapter that exposes a block/winch interface on top of a
 * `RopeNetwork` node. Replaces the old `Pulley` entity for the new
 * capstan-network ropes (Sheet in Phase 2, Anchor in Phase 4).
 *
 * Unlike `Pulley`, this class owns no physics constraint — the rope's
 * capstan solver handles everything. A `RopeBlock` is just a named
 * reference to a specific network node, with a convenience API for
 * winches (ratchet, trim-rate injection, working-length query).
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import type { Body } from "../../core/physics/body/Body";
import { V3, V3d, type CompatibleVector3 } from "../../core/Vector3";
import type { RopeNetwork } from "./RopeNetwork";

export type RopeBlockMode = "free" | "ratchet";

export interface RopeBlockConfig {
  /** "block" = free-sliding (mu carries the friction), "winch" = ratchet-capable. */
  mode?: "block" | "winch";
  /** Coulomb friction coefficient at this node. Default 0 (frictionless). */
  frictionCoefficient?: number;
  /**
   * Maximum force a winch can apply while trimming (engine-force units).
   * Effective trim rate tapers to zero as working-side tension approaches
   * this value. Ignored for blocks. Default Infinity (unlimited — legacy
   * behavior, not recommended).
   */
  winchMaxForce?: number;
}

export class RopeBlock extends BaseEntity {
  readonly type: "block" | "winch";

  private readonly network: RopeNetwork;
  private readonly nodeIdx: number;
  /** The hull-or-whatever body the node is anchored to. */
  private readonly anchorBody: Body;

  constructor(
    network: RopeNetwork,
    body: Body,
    localAnchor: CompatibleVector3,
    config: RopeBlockConfig = {},
  ) {
    super();
    this.network = network;
    this.anchorBody = body;
    this.type = config.mode ?? "block";

    // Find the node on this network that matches (body, localAnchor).
    // Construction-time convenience: callers build the network first, then
    // layer RopeBlock instances over specific nodes by world anchor match.
    this.nodeIdx = findNodeIndex(network, body, V3(localAnchor));
    if (this.nodeIdx < 0) {
      throw new Error(
        "RopeBlock: no matching node found on the provided RopeNetwork.",
      );
    }

    // Apply friction and set initial winch state.
    const node = network.getNode(this.nodeIdx);
    node.mu = config.frictionCoefficient ?? 0;
    if (this.type === "winch") {
      // Default winches start in ratchet mode (matches old Pulley behavior).
      network.setWinchRatchet(this.nodeIdx, 1);
      if (config.winchMaxForce != null) {
        node.winchMaxForce = config.winchMaxForce;
      }
    }
  }

  /** Current world-space position of the node's anchor. */
  getWorldPosition(): V3d {
    return this.anchorBody.toWorldFrame3D(
      this.network.getNode(this.nodeIdx).localAnchor,
    );
  }

  /** Index of this block's node within its RopeNetwork. */
  getNodeIndex(): number {
    return this.nodeIdx;
  }

  /**
   * Material length of rope on the "working" side of this node — the sum
   * of section lengths from node 0 to this node.
   */
  getWorkingLength(): number {
    return this.network.getMaterialLengthAt(this.nodeIdx);
  }

  /**
   * Rearrange section lengths so the working side equals `targetLength`.
   * Only the section immediately adjacent to this node on the working
   * side changes (other sections are preserved).
   */
  setWorkingLength(targetLength: number): void {
    this.network.setWorkingLengthAt(this.nodeIdx, targetLength);
  }

  /**
   * Set winch ratchet mode.
   *  - "ratchet": rope can only flow working → tail (trim), not the reverse.
   *  - "free": rope can flow either way based on tension balance.
   */
  setMode(mode: RopeBlockMode): void {
    if (this.type !== "winch") return;
    this.network.setWinchRatchet(this.nodeIdx, mode === "ratchet" ? 1 : 0);
  }

  /**
   * Inject a trim-direction flow rate (ft/s). Positive = working side shrinks.
   * The rate persists across ticks until changed — call with 0 to stop
   * trimming. Sheet.adjust / Anchor.raise set this every tick from player
   * input, so the persistence is invisible in practice.
   */
  applyTrimRate(rate: number): void {
    if (this.type !== "winch") return;
    this.network.setWinchFlowRate(this.nodeIdx, rate);
  }
}

/** Locate a node on the network whose (body, localAnchor) matches within ε. */
function findNodeIndex(
  network: RopeNetwork,
  body: Body,
  localAnchor: V3d,
): number {
  const eps2 = 1e-6;
  for (let i = 0; i < network.getNodeCount(); i++) {
    const node = network.getNode(i);
    if (node.body !== body) continue;
    const la = node.localAnchor;
    const dx = la[0] - localAnchor[0];
    const dy = la[1] - localAnchor[1];
    const dz = la[2] - localAnchor[2];
    if (dx * dx + dy * dy + dz * dz < eps2) return i;
  }
  return -1;
}
