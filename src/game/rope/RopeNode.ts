/**
 * Entity-level rope node: a body + local anchor plus the solver fields.
 *
 * Each node's `worldPos` is refreshed from the body's world transform at
 * the start of every tick; the capstan solver then reads `worldPos` and
 * the friction/winch fields directly via the CapstanNode interface.
 */

import type { Body } from "../../core/physics/body/Body";
import { V3, V3d, type CompatibleVector3 } from "../../core/Vector3";
import type { CapstanNode } from "./capstan";

/**
 * A rope node anchored to a rigid body.
 *
 * Implements `CapstanNode` directly so the solver can consume an array of
 * these without adaptation. The `worldPos` V3d is reused tick-to-tick to
 * avoid allocation.
 */
export interface RopeNodeRef extends CapstanNode {
  readonly body: Body;
  readonly localAnchor: V3d;
  /** Scratch V3d that `refreshWorldPos` writes into. */
  readonly worldPos: V3d;
}

export interface RopeNodeConfig {
  body: Body;
  localAnchor: CompatibleVector3;
  kind: CapstanNode["kind"];
  mu?: number;
}

/** Create a new node with worldPos pre-populated from the body's current pose. */
export function makeRopeNode(config: RopeNodeConfig): RopeNodeRef {
  const localAnchor = V3(config.localAnchor);
  const worldPos = config.body.toWorldFrame3D(localAnchor);
  const node: RopeNodeRef = {
    body: config.body,
    localAnchor,
    kind: config.kind,
    mu: config.mu ?? 0,
    worldPos,
  };
  return node;
}

/** Refresh a node's `worldPos` from its body's current transform. */
export function refreshWorldPos(node: RopeNodeRef): void {
  node.body.toWorldFrame3D(node.localAnchor, node.worldPos);
}
