import { V2d } from "../../../core/Vector";
import {
  checkSplineIntersection,
  checkSplineSelfIntersection,
  isSplineInsideSpline,
} from "../../../core/util/Spline";
import { DEFAULT_DEPTH } from "./TerrainConstants";

/**
 * A single terrain contour - a closed spline at a specific height.
 * Contours define elevation levels. The system determines nesting from geometry,
 * allowing flexible configurations like two islands sharing one shelf.
 */
export interface TerrainContour {
  /** Catmull-Rom control points defining the contour (closed loop) */
  readonly controlPoints: readonly V2d[];

  /** Height of this contour in feet (negative = underwater, positive = above water) */
  readonly height: number;
}

/**
 * Collection of contours defining terrain for a level.
 * Height is determined by which contours a point is inside/outside of.
 */
export interface TerrainDefinition {
  contours: TerrainContour[];
  /** Deep ocean baseline depth in feet (default: -50) */
  defaultDepth?: number;
}

/** Number of 32-bit values per contour in GPU buffer (7 values + 2 padding for 16-byte alignment = 36 bytes) */
export const FLOATS_PER_CONTOUR = 9;

/**
 * A node in the contour containment tree.
 * The tree represents parent-child relationships based on geometric containment.
 */
export interface ContourTreeNode {
  /** Index into the contours array */
  contourIndex: number;
  /** Index of parent node (-1 if this is a root) */
  parentIndex: number;
  /** Depth in the tree (0 = root/directly in ocean) */
  depth: number;
  /** Indices of child nodes (contours directly contained by this one) */
  children: number[];
}

/**
 * Tree structure representing contour containment hierarchy.
 * Used for efficient height calculation - find deepest containing contour,
 * then blend with children using inverse-distance weighting.
 */
export interface ContourTree {
  /** Nodes indexed by contour index */
  nodes: ContourTreeNode[];
  /** Flat array of all child indices for GPU upload */
  childrenFlat: number[];
  /** Maximum depth in the tree */
  maxDepth: number;
}

/**
 * Create a terrain contour.
 * Only control points and height are required.
 */
export function createContour(
  controlPoints: V2d[],
  height: number,
): TerrainContour {
  return {
    controlPoints,
    height,
  };
}

/**
 * Working node structure used during tree construction.
 * Has mutable children array for incremental insertion.
 */
interface WorkingTreeNode {
  contourIndex: number; // -1 for virtual root
  parentIndex: number;
  children: WorkingTreeNode[];
}

/**
 * Build a containment tree from terrain contours using incremental insertion.
 *
 * The tree represents parent-child relationships based on geometric containment:
 * - A contour is a child of another if it's completely inside it
 * - A contour's parent is the smallest contour that contains it
 * - Root contours have no parent (they're directly in the ocean)
 *
 * Algorithm: For each contour, insert it into the tree by:
 * 1. Finding which existing node contains it (recurse into that subtree)
 * 2. If no child contains it, add it as a direct child of current node
 * 3. Reparent any existing children that the new contour contains
 *
 * This avoids the need for size comparisons - containment alone determines hierarchy.
 *
 * @param contours - Array of terrain contours
 * @returns ContourTree with nodes and flattened children array
 */
export function buildContourTree(contours: TerrainContour[]): ContourTree {
  const n = contours.length;

  if (n === 0) {
    return { nodes: [], childrenFlat: [], maxDepth: 0 };
  }

  // Virtual root node (represents "ocean" - contains all root-level contours)
  const virtualRoot: WorkingTreeNode = {
    contourIndex: -1,
    parentIndex: -1,
    children: [],
  };

  // Map from contour index to working node for quick lookup
  const nodeMap = new Map<number, WorkingTreeNode>();

  /**
   * Recursively insert a new contour into the tree.
   * @param parent - Current node being examined
   * @param newIndex - Index of the contour to insert
   */
  function insertContour(parent: WorkingTreeNode, newIndex: number): void {
    const newContour = contours[newIndex];

    // Check if any existing child contains the new contour
    for (const child of parent.children) {
      const childContour = contours[child.contourIndex];
      if (
        isSplineInsideSpline(
          newContour.controlPoints,
          childContour.controlPoints,
        )
      ) {
        // New contour is inside this child - recurse deeper
        insertContour(child, newIndex);
        return;
      }
    }

    // No child contains newContour, so it becomes a direct child of parent
    // But first, check if newContour contains any existing children (reparent them)
    const newNode: WorkingTreeNode = {
      contourIndex: newIndex,
      parentIndex: parent.contourIndex,
      children: [],
    };
    nodeMap.set(newIndex, newNode);

    // Find children that should be reparented to the new node
    const childrenToReparent: WorkingTreeNode[] = [];
    for (const child of parent.children) {
      const childContour = contours[child.contourIndex];
      if (
        isSplineInsideSpline(
          childContour.controlPoints,
          newContour.controlPoints,
        )
      ) {
        childrenToReparent.push(child);
      }
    }

    // Reparent contained children to newNode
    for (const child of childrenToReparent) {
      // Remove from parent's children
      const idx = parent.children.indexOf(child);
      if (idx >= 0) {
        parent.children.splice(idx, 1);
      }
      // Add to new node's children
      newNode.children.push(child);
      child.parentIndex = newIndex;
    }

    // Add newNode as child of parent
    parent.children.push(newNode);
  }

  // Insert all contours one by one
  for (let i = 0; i < n; i++) {
    insertContour(virtualRoot, i);
  }

  // Convert working tree to final ContourTreeNode array
  const nodes: ContourTreeNode[] = contours.map((_, i) => ({
    contourIndex: i,
    parentIndex: -1,
    depth: 0,
    children: [],
  }));

  // Copy parent/child relationships from working tree
  for (let i = 0; i < n; i++) {
    const workingNode = nodeMap.get(i)!;
    nodes[i].parentIndex = workingNode.parentIndex;
    nodes[i].children = workingNode.children.map((c) => c.contourIndex);
  }

  // Compute depths via BFS from roots
  const roots = nodes.filter((node) => node.parentIndex === -1);
  let maxDepth = 0;

  const queue: number[] = roots.map((n) => n.contourIndex);
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const node = nodes[idx];
    const depth = node.parentIndex >= 0 ? nodes[node.parentIndex].depth + 1 : 0;
    node.depth = depth;
    maxDepth = Math.max(maxDepth, depth);

    for (const childIdx of node.children) {
      queue.push(childIdx);
    }
  }

  // Build flat children array for GPU
  const childrenFlat: number[] = [];
  for (const node of nodes) {
    for (const childIdx of node.children) {
      childrenFlat.push(childIdx);
    }
  }

  return { nodes, childrenFlat, maxDepth };
}

// Track which terrain definitions have been validated to avoid duplicate warnings
const validatedDefinitions = new WeakSet<TerrainDefinition>();

/**
 * Validate terrain definition and log warnings for potential issues.
 * Checks for:
 * - Self-intersecting contours (spline segments that cross themselves)
 * - Contours that intersect each other
 *
 * Only validates each definition once to avoid log spam.
 */
export function validateTerrainDefinition(definition: TerrainDefinition): void {
  // Skip if already validated
  if (validatedDefinitions.has(definition)) return;
  validatedDefinitions.add(definition);

  const contours = definition.contours;
  if (contours.length === 0) return;

  // Check each contour for self-intersection
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    if (contour.controlPoints.length < 3) {
      console.warn(
        `Terrain contour ${i} at height ${contour.height} has only ${contour.controlPoints.length} control points`,
      );
      continue;
    }

    const selfIntersections = checkSplineSelfIntersection(
      contour.controlPoints,
    );
    if (selfIntersections.length > 0) {
      const first = selfIntersections[0];
      console.warn(
        `Terrain contour ${i} at height ${contour.height} self-intersects. ` +
          `Found ${selfIntersections.length} intersection(s). ` +
          `First at (${first.point.x.toFixed(0)}, ${first.point.y.toFixed(0)}) ` +
          `between segments ${first.segmentA} and ${first.segmentB}.`,
      );
    }
  }

  // Check all pairs of contours for intersection
  for (let i = 0; i < contours.length; i++) {
    for (let j = i + 1; j < contours.length; j++) {
      const contourA = contours[i];
      const contourB = contours[j];

      if (
        contourA.controlPoints.length < 3 ||
        contourB.controlPoints.length < 3
      ) {
        continue;
      }

      const intersections = checkSplineIntersection(
        contourA.controlPoints,
        contourB.controlPoints,
      );

      if (intersections.length > 0) {
        const first = intersections[0];
        console.warn(
          `Terrain contours ${i} (height ${contourA.height}) and ${j} (height ${contourB.height}) intersect. ` +
            `Found ${intersections.length} intersection(s). ` +
            `First at (${first.point.x.toFixed(0)}, ${first.point.y.toFixed(0)}).`,
        );
      }
    }
  }
}

/**
 * Build GPU data arrays from terrain definition.
 * Returns flat arrays ready for upload to GPU buffers.
 *
 * Includes tree structure data for hierarchical height computation.
 *
 * IMPORTANT: The WGSL struct has u32 fields for pointStartIndex and pointCount,
 * so we need to use a DataView to write integers with correct bit patterns.
 */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  controlPointsData: Float32Array;
  contourData: ArrayBuffer;
  childrenData: Uint32Array;
  contourCount: number;
  maxDepth: number;
  defaultDepth: number;
} {
  const contours = definition.contours;

  // Build containment tree
  const tree = buildContourTree(contours);

  // Count total control points
  let totalPoints = 0;
  for (const contour of contours) {
    totalPoints += contour.controlPoints.length;
  }

  const controlPointsData = new Float32Array(totalPoints * 2);

  // Use ArrayBuffer + DataView to write mixed u32/f32 data correctly
  // Layout per contour (36 bytes = 9 x 4 bytes):
  //   0-3:   pointStartIndex (u32)
  //   4-7:   pointCount (u32)
  //   8-11:  height (f32)
  //   12-15: parentIndex (i32, -1 if root)
  //   16-19: depth (u32)
  //   20-23: childStartIndex (u32)
  //   24-27: childCount (u32)
  //   28-35: padding (for 16-byte struct alignment)
  const contourBuffer = new ArrayBuffer(
    contours.length * FLOATS_PER_CONTOUR * 4,
  );
  const contourView = new DataView(contourBuffer);

  // Build flat children index array and track start indices
  const childStartIndices: number[] = [];
  let childIndex = 0;
  for (const node of tree.nodes) {
    childStartIndices.push(childIndex);
    childIndex += node.children.length;
  }

  // Create children buffer
  const childrenData = new Uint32Array(tree.childrenFlat);

  let pointIndex = 0;
  for (let i = 0; i < contours.length; i++) {
    const contour = contours[i];
    const node = tree.nodes[i];

    // Store contour metadata - byte offset for each contour
    const byteBase = i * FLOATS_PER_CONTOUR * 4;

    // u32 fields (must use setUint32, not float)
    contourView.setUint32(byteBase + 0, pointIndex, true); // pointStartIndex
    contourView.setUint32(byteBase + 4, contour.controlPoints.length, true); // pointCount

    // f32 field
    contourView.setFloat32(byteBase + 8, contour.height, true);

    // Tree structure fields
    contourView.setInt32(byteBase + 12, node.parentIndex, true); // parentIndex (signed)
    contourView.setUint32(byteBase + 16, node.depth, true); // depth
    contourView.setUint32(byteBase + 20, childStartIndices[i], true); // childStartIndex
    contourView.setUint32(byteBase + 24, node.children.length, true); // childCount
    // byteBase + 28 and +32 are padding (left as 0)

    // Store control points
    for (const pt of contour.controlPoints) {
      controlPointsData[pointIndex * 2 + 0] = pt.x;
      controlPointsData[pointIndex * 2 + 1] = pt.y;
      pointIndex++;
    }
  }

  return {
    controlPointsData,
    contourData: contourBuffer,
    childrenData,
    contourCount: contours.length,
    maxDepth: tree.maxDepth,
    defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
  };
}
