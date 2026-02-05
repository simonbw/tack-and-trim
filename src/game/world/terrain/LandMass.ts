import { V2d } from "../../../core/Vector";
import {
  checkSplineIntersection,
  checkSplineSelfIntersection,
  computeSplineBoundingBox,
  isSplineInsideSpline,
  sampleClosedSpline,
} from "../../../core/util/Spline";
import { DEFAULT_DEPTH, SAMPLES_PER_SEGMENT } from "./TerrainConstants";

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

/** Number of 32-bit values per contour in GPU buffer (12 values + 1 padding for 16-byte alignment = 52 bytes) */
export const FLOATS_PER_CONTOUR = 13;

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
 * Compute the signed area of a polygon defined by control points.
 * Uses the shoelace formula.
 *
 * In screen coordinates (Y increases downward):
 * - Positive area = clockwise winding
 * - Negative area = counter-clockwise winding
 *
 * @param points - Polygon vertices (closed loop assumed)
 * @returns Signed area (positive = CW, negative = CCW in screen coords)
 */
export function computeSignedArea(points: readonly V2d[]): number {
  if (points.length < 3) return 0;

  let area = 0;
  const n = points.length;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }

  return area / 2;
}

/**
 * Check if a contour has counter-clockwise winding (in screen coordinates).
 *
 * For wave physics, CCW winding means:
 * - The interior (land) is on the LEFT as you traverse the contour
 * - The exterior (water) is on the RIGHT
 *
 * @param contour - Terrain contour to check
 * @returns True if the contour has CCW winding
 */
export function isContourCCW(contour: TerrainContour): boolean {
  // In screen coordinates (Y down), negative signed area = CCW
  return computeSignedArea(contour.controlPoints) < 0;
}

/**
 * Ensure a contour has counter-clockwise winding.
 * Returns the contour unchanged if already CCW, or a new contour with reversed points.
 *
 * @param contour - Terrain contour to normalize
 * @returns Contour with CCW winding
 */
export function ensureContourCCW(contour: TerrainContour): TerrainContour {
  if (isContourCCW(contour)) {
    return contour;
  }

  // Reverse the control points to flip winding
  return {
    controlPoints: [...contour.controlPoints].reverse(),
    height: contour.height,
  };
}

/**
 * Normalize all contours in a terrain definition to have CCW winding.
 * This is important for consistent wave shadow computation.
 *
 * @param definition - Terrain definition to normalize
 * @returns New terrain definition with all contours in CCW winding
 */
export function normalizeTerrainWinding(
  definition: TerrainDefinition,
): TerrainDefinition {
  const normalizedContours = definition.contours.map((contour) =>
    ensureContourCCW(contour),
  );

  return {
    contours: normalizedContours,
    defaultDepth: definition.defaultDepth,
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
 * Pre-samples Catmull-Rom splines on the CPU at high resolution (SAMPLES_PER_SEGMENT
 * samples per control point segment). This produces smooth polygon vertices that
 * the GPU can iterate directly without needing to evaluate splines.
 *
 * Contours are reordered in DFS pre-order for efficient GPU traversal. Each contour
 * has a skipCount indicating how many contours are in its subtree, allowing the GPU
 * to skip entire subtrees when a point is outside a contour.
 *
 * IMPORTANT: The WGSL struct has u32 fields for pointStartIndex and pointCount,
 * so we need to use a DataView to write integers with correct bit patterns.
 */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  vertexData: Float32Array;
  contourData: ArrayBuffer;
  childrenData: Uint32Array;
  coastlineIndices: Uint32Array;
  contourCount: number;
  coastlineCount: number;
  maxDepth: number;
  defaultDepth: number;
} {
  const contours = definition.contours;

  if (contours.length === 0) {
    return {
      vertexData: new Float32Array(0),
      contourData: new ArrayBuffer(0),
      childrenData: new Uint32Array(0),
      coastlineIndices: new Uint32Array(0),
      contourCount: 0,
      coastlineCount: 0,
      maxDepth: 0,
      defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
    };
  }

  // Build containment tree
  const tree = buildContourTree(contours);

  // Compute DFS ordering and skip counts
  // dfsOrder[i] = original contour index at DFS position i
  // originalToDfs[originalIndex] = DFS position
  // skipCounts[dfsPosition] = number of descendants (subtree size)
  const dfsOrder: number[] = [];
  const originalToDfs = new Map<number, number>();
  const skipCounts: number[] = new Array(contours.length).fill(0);

  // DFS traversal to build ordering and compute skip counts
  function dfsVisit(originalIndex: number): number {
    const dfsIndex = dfsOrder.length;
    dfsOrder.push(originalIndex);
    originalToDfs.set(originalIndex, dfsIndex);

    // Visit children and accumulate subtree size
    const node = tree.nodes[originalIndex];
    let subtreeSize = 0;
    for (const childOriginalIndex of node.children) {
      subtreeSize += 1 + dfsVisit(childOriginalIndex);
    }

    // Store skip count at the correct DFS index (not push, since we're in post-order here)
    skipCounts[dfsIndex] = subtreeSize;
    return subtreeSize;
  }

  // Start DFS from root nodes (those with parentIndex === -1)
  for (let i = 0; i < tree.nodes.length; i++) {
    if (tree.nodes[i].parentIndex === -1) {
      dfsVisit(i);
    }
  }

  // Pre-sample all contours' splines into dense vertex arrays
  const sampledContours: V2d[][] = contours.map((contour) =>
    sampleClosedSpline(contour.controlPoints, SAMPLES_PER_SEGMENT),
  );

  // Count total vertices after sampling
  let totalVertices = 0;
  for (const vertices of sampledContours) {
    totalVertices += vertices.length;
  }

  const vertexData = new Float32Array(totalVertices * 2);

  // Use ArrayBuffer + DataView to write mixed u32/f32 data correctly
  // Layout per contour (52 bytes = 13 x 4 bytes):
  //   0-3:   pointStartIndex (u32) - refers to pre-sampled vertices
  //   4-7:   pointCount (u32) - refers to pre-sampled vertices
  //   8-11:  height (f32)
  //   12-15: parentIndex (i32, -1 if root) - in DFS indices
  //   16-19: depth (u32)
  //   20-23: childStartIndex (u32)
  //   24-27: childCount (u32)
  //   28-31: isCoastline (u32, 1 if height == 0)
  //   32-35: bboxMinX (f32)
  //   36-39: bboxMinY (f32)
  //   40-43: bboxMaxX (f32)
  //   44-47: bboxMaxY (f32)
  //   48-51: skipCount (u32) - number of contours in subtree
  const contourBuffer = new ArrayBuffer(
    contours.length * FLOATS_PER_CONTOUR * 4,
  );
  const contourView = new DataView(contourBuffer);

  // Build flat children index array in DFS order
  // childStartIndices[dfsIndex] = start index in children buffer
  const childStartIndices: number[] = [];
  const childrenFlat: number[] = [];
  for (let dfsIndex = 0; dfsIndex < dfsOrder.length; dfsIndex++) {
    const originalIndex = dfsOrder[dfsIndex];
    const node = tree.nodes[originalIndex];
    childStartIndices.push(childrenFlat.length);
    // Store children as DFS indices
    for (const childOriginalIndex of node.children) {
      childrenFlat.push(originalToDfs.get(childOriginalIndex)!);
    }
  }
  const childrenData = new Uint32Array(childrenFlat);

  // Collect coastline indices (height == 0 contours) in DFS order
  const coastlineIndicesList: number[] = [];
  for (let dfsIndex = 0; dfsIndex < dfsOrder.length; dfsIndex++) {
    const originalIndex = dfsOrder[dfsIndex];
    if (contours[originalIndex].height === 0) {
      coastlineIndicesList.push(dfsIndex);
    }
  }
  const coastlineIndices = new Uint32Array(coastlineIndicesList);

  // Write contour data in DFS order
  let vertexIndex = 0;
  for (let dfsIndex = 0; dfsIndex < dfsOrder.length; dfsIndex++) {
    const originalIndex = dfsOrder[dfsIndex];
    const contour = contours[originalIndex];
    const node = tree.nodes[originalIndex];
    const vertices = sampledContours[originalIndex];

    // Store contour metadata - byte offset for each contour
    const byteBase = dfsIndex * FLOATS_PER_CONTOUR * 4;

    // u32 fields (must use setUint32, not float)
    contourView.setUint32(byteBase + 0, vertexIndex, true); // pointStartIndex
    contourView.setUint32(byteBase + 4, vertices.length, true); // pointCount

    // f32 field
    contourView.setFloat32(byteBase + 8, contour.height, true);

    // Tree structure fields - parentIndex in DFS indices
    const parentDfsIndex =
      node.parentIndex === -1 ? -1 : originalToDfs.get(node.parentIndex)!;
    contourView.setInt32(byteBase + 12, parentDfsIndex, true); // parentIndex (signed)
    contourView.setUint32(byteBase + 16, node.depth, true); // depth
    contourView.setUint32(byteBase + 20, childStartIndices[dfsIndex], true); // childStartIndex
    contourView.setUint32(byteBase + 24, node.children.length, true); // childCount
    contourView.setUint32(byteBase + 28, contour.height === 0 ? 1 : 0, true); // isCoastline

    // Compute bounding box from pre-sampled vertices
    const bbox = computeSplineBoundingBox(
      contour.controlPoints,
      SAMPLES_PER_SEGMENT,
    );
    if (bbox) {
      contourView.setFloat32(byteBase + 32, bbox.minX, true); // bboxMinX
      contourView.setFloat32(byteBase + 36, bbox.minY, true); // bboxMinY
      contourView.setFloat32(byteBase + 40, bbox.maxX, true); // bboxMaxX
      contourView.setFloat32(byteBase + 44, bbox.maxY, true); // bboxMaxY
    }

    // Skip count for DFS traversal
    contourView.setUint32(byteBase + 48, skipCounts[dfsIndex], true); // skipCount

    // Store pre-sampled vertices
    for (const pt of vertices) {
      vertexData[vertexIndex * 2 + 0] = pt.x;
      vertexData[vertexIndex * 2 + 1] = pt.y;
      vertexIndex++;
    }
  }

  return {
    vertexData,
    contourData: contourBuffer,
    childrenData,
    coastlineIndices,
    contourCount: contours.length,
    coastlineCount: coastlineIndices.length,
    maxDepth: tree.maxDepth,
    defaultDepth: definition.defaultDepth ?? DEFAULT_DEPTH,
  };
}
