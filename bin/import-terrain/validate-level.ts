#!/usr/bin/env tsx
/**
 * Validate a .level.json file for contour correctness.
 *
 * Checks:
 * 1. No contours at different heights overlap (their polygons should not intersect)
 * 2. Height transitions in the containment tree must cross zero — a positive-height
 *    contour's parent must be non-negative, and a negative-height contour's parent
 *    must be non-positive
 *
 * This validation works directly on raw [x,y] tuples from the JSON to avoid the
 * memory overhead of creating V2d objects and spline-sampling (which would OOM
 * for large unsimplified terrain with hundreds of thousands of points).
 *
 * Usage:
 *   npx tsx bin/import-terrain/validate-level.ts <path-to-level.json>
 *   npx tsx bin/import-terrain/validate-level.ts --region <name>
 *
 * Can also be called programmatically via validateLevelFile().
 */

import { readFileSync } from "fs";
import path from "path";
import { DEFAULT_DEPTH } from "../../src/game/world/terrain/TerrainConstants";

// ---------------------------------------------------------------------------
// Lightweight contour representation (no V2d, no spline sampling)
// ---------------------------------------------------------------------------

interface LightContour {
  height: number;
  /** Flat array: [x0, y0, x1, y1, ...] */
  points: Float64Array;
  numPoints: number;
}

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBBox(c: LightContour): BBox {
  const pts = c.points;
  const n2 = c.numPoints * 2;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n2; i += 2) {
    const x = pts[i],
      y = pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function bboxOverlaps(a: BBox, b: BBox): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
  );
}

function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.maxX >= inner.maxX &&
    outer.minY <= inner.minY &&
    outer.maxY >= inner.maxY
  );
}

function segmentsIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number,
): boolean {
  const d1x = p2x - p1x;
  const d1y = p2y - p1y;
  const d2x = p4x - p3x;
  const d2y = p4y - p3y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false;

  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;

  const eps = 1e-9;
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps;
}

function findPolygonIntersection(
  a: LightContour,
  b: LightContour,
): { x: number; y: number } | null {
  const ptsA = a.points;
  const ptsB = b.points;
  const nA = a.numPoints;
  const nB = b.numPoints;

  for (let i = 0; i < nA; i++) {
    const i2 = (i + 1) % nA;
    const ax1 = ptsA[i * 2],
      ay1 = ptsA[i * 2 + 1];
    const ax2 = ptsA[i2 * 2],
      ay2 = ptsA[i2 * 2 + 1];

    for (let j = 0; j < nB; j++) {
      const j2 = (j + 1) % nB;
      if (
        segmentsIntersect(
          ax1,
          ay1,
          ax2,
          ay2,
          ptsB[j * 2],
          ptsB[j * 2 + 1],
          ptsB[j2 * 2],
          ptsB[j2 * 2 + 1],
        )
      ) {
        return { x: (ax1 + ax2) / 2, y: (ay1 + ay2) / 2 };
      }
    }
  }
  return null;
}

function pointInPolygon(
  px: number,
  py: number,
  poly: Float64Array,
  numPoints: number,
): boolean {
  if (numPoints < 3) return false;
  let inside = false;
  for (let i = 0, j = numPoints - 1; i < numPoints; j = i++) {
    const xi = poly[i * 2],
      yi = poly[i * 2 + 1];
    const xj = poly[j * 2],
      yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Ensure CCW winding. Returns the contour unchanged or with reversed points. */
function ensureCCW(c: LightContour): LightContour {
  const pts = c.points;
  const n = c.numPoints;
  // Signed area (2x)
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  if (area >= 0) return c; // already CCW

  // Reverse in-place
  const reversed = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const ri = n - 1 - i;
    reversed[i * 2] = pts[ri * 2];
    reversed[i * 2 + 1] = pts[ri * 2 + 1];
  }
  return { height: c.height, points: reversed, numPoints: n };
}

// ---------------------------------------------------------------------------
// Lightweight contour tree (mirrors buildContourTree from LandMass.ts)
// ---------------------------------------------------------------------------

interface TreeNode {
  parentIndex: number;
  children: number[];
  depth: number;
}

function buildLightContourTree(
  contours: LightContour[],
  bboxes: BBox[],
): { nodes: TreeNode[]; maxDepth: number } {
  const n = contours.length;
  if (n === 0) return { nodes: [], maxDepth: 0 };

  // Working tree nodes with mutable children lists
  interface WorkingNode {
    contourIndex: number;
    parentIndex: number;
    children: WorkingNode[];
  }

  const virtualRoot: WorkingNode = {
    contourIndex: -1,
    parentIndex: -1,
    children: [],
  };
  const nodeMap = new Map<number, WorkingNode>();

  function isInside(innerIdx: number, outerIdx: number): boolean {
    if (!bboxContains(bboxes[outerIdx], bboxes[innerIdx])) return false;
    const inner = contours[innerIdx];
    const outer = contours[outerIdx];
    return pointInPolygon(
      inner.points[0],
      inner.points[1],
      outer.points,
      outer.numPoints,
    );
  }

  function insertContour(parent: WorkingNode, newIndex: number): void {
    for (const child of parent.children) {
      if (isInside(newIndex, child.contourIndex)) {
        insertContour(child, newIndex);
        return;
      }
    }

    const newNode: WorkingNode = {
      contourIndex: newIndex,
      parentIndex: parent.contourIndex,
      children: [],
    };
    nodeMap.set(newIndex, newNode);

    const toReparent: WorkingNode[] = [];
    for (const child of parent.children) {
      if (isInside(child.contourIndex, newIndex)) {
        toReparent.push(child);
      }
    }
    for (const child of toReparent) {
      const idx = parent.children.indexOf(child);
      if (idx >= 0) parent.children.splice(idx, 1);
      newNode.children.push(child);
      child.parentIndex = newIndex;
    }
    parent.children.push(newNode);
  }

  for (let i = 0; i < n; i++) {
    insertContour(virtualRoot, i);
  }

  // Convert to final node array
  const nodes: TreeNode[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const w = nodeMap.get(i)!;
    nodes[i] = {
      parentIndex: w.parentIndex,
      children: w.children.map((c) => c.contourIndex),
      depth: 0,
    };
  }

  // BFS to compute depths
  let maxDepth = 0;
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (nodes[i].parentIndex === -1) queue.push(i);
  }
  while (queue.length > 0) {
    const idx = queue.shift()!;
    const node = nodes[idx];
    node.depth = node.parentIndex >= 0 ? nodes[node.parentIndex].depth + 1 : 0;
    maxDepth = Math.max(maxDepth, node.depth);
    for (const childIdx of node.children) {
      queue.push(childIdx);
    }
  }

  return { nodes, maxDepth };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError {
  type: "overlap" | "tree";
  message: string;
}

export interface ValidationResult {
  errors: ValidationError[];
  warnings: string[];
  contourCount: number;
  rootCount: number;
  maxDepth: number;
}

export function validateLevelFile(levelPath: string): ValidationResult {
  const json = readFileSync(levelPath, "utf-8");
  const data = JSON.parse(json);
  const defaultDepth: number = data.defaultDepth ?? DEFAULT_DEPTH;

  const rawContours: {
    height: number;
    controlPoints?: [number, number][];
    polygon?: [number, number][];
  }[] = data.contours ?? [];

  // Build lightweight contours from raw JSON (no V2d, no spline sampling)
  const contours: LightContour[] = rawContours.map((c) => {
    const pts = c.polygon ?? c.controlPoints ?? [];
    const n = pts.length;
    const points = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      points[i * 2] = pts[i][0];
      points[i * 2 + 1] = pts[i][1];
    }
    return ensureCCW({ height: c.height, points, numPoints: n });
  });

  const errors: ValidationError[] = [];
  const warnings: string[] = [];

  if (contours.length === 0) {
    return { errors, warnings, contourCount: 0, rootCount: 0, maxDepth: 0 };
  }

  const bboxes = contours.map(computeBBox);

  // -------------------------------------------------------------------------
  // Check 1: No contours at different heights overlap
  // -------------------------------------------------------------------------
  const byHeight = new Map<number, number[]>();
  for (let i = 0; i < contours.length; i++) {
    const h = contours[i].height;
    if (!byHeight.has(h)) byHeight.set(h, []);
    byHeight.get(h)!.push(i);
  }

  const heights = [...byHeight.keys()].sort((a, b) => a - b);
  let overlapCount = 0;
  const maxOverlapReports = 10;

  for (
    let hi = 0;
    hi < heights.length && overlapCount < maxOverlapReports;
    hi++
  ) {
    for (
      let hj = hi + 1;
      hj < heights.length && overlapCount < maxOverlapReports;
      hj++
    ) {
      const indicesA = byHeight.get(heights[hi])!;
      const indicesB = byHeight.get(heights[hj])!;

      for (const ia of indicesA) {
        if (overlapCount >= maxOverlapReports) break;
        for (const ib of indicesB) {
          if (overlapCount >= maxOverlapReports) break;
          if (!bboxOverlaps(bboxes[ia], bboxes[ib])) continue;

          const intersection = findPolygonIntersection(
            contours[ia],
            contours[ib],
          );
          if (intersection) {
            overlapCount++;
            errors.push({
              type: "overlap",
              message:
                `Contour ${ia} (h=${contours[ia].height}ft) and contour ${ib} (h=${contours[ib].height}ft) ` +
                `intersect near (${intersection.x.toFixed(0)}, ${intersection.y.toFixed(0)})`,
            });
          }
        }
      }
    }
  }

  if (overlapCount >= maxOverlapReports) {
    warnings.push(
      `Stopped checking after ${maxOverlapReports} overlap errors (there may be more)`,
    );
  }

  // -------------------------------------------------------------------------
  // Check 2: Containment tree — height transitions must cross zero.
  // -------------------------------------------------------------------------
  const tree = buildLightContourTree(contours, bboxes);

  let treeErrorCount = 0;
  const maxTreeErrors = 10;
  for (let i = 0; i < tree.nodes.length; i++) {
    const node = tree.nodes[i];
    const height = contours[i].height;
    const parentHeight =
      node.parentIndex >= 0 ? contours[node.parentIndex].height : defaultDepth;

    let bad = false;
    if (height > 0 && parentHeight < 0) bad = true;
    if (height < 0 && parentHeight > 0) bad = true;

    if (bad) {
      treeErrorCount++;
      if (treeErrorCount <= maxTreeErrors) {
        const parentDesc =
          node.parentIndex >= 0
            ? `contour ${node.parentIndex} (h=${parentHeight}ft)`
            : `ocean (h=${parentHeight}ft)`;
        errors.push({
          type: "tree",
          message:
            `Contour ${i} (h=${height}ft) has parent ${parentDesc}` +
            ` — height crosses zero without a h=0 contour between them`,
        });
      }
    }
  }
  if (treeErrorCount > maxTreeErrors) {
    warnings.push(
      `${treeErrorCount - maxTreeErrors} more tree nesting errors not shown`,
    );
  }

  const rootCount = tree.nodes.filter((n) => n.parentIndex === -1).length;

  return {
    errors,
    warnings,
    contourCount: contours.length,
    rootCount,
    maxDepth: tree.maxDepth,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  let levelPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--region") {
      // Resolve from region config
      const { resolveRegion, loadRegionConfig } = require("./lib/region");
      const slug = resolveRegion(args);
      const config = loadRegionConfig(slug);
      levelPath = path.resolve(config.output);
      break;
    } else if (args[i] === "-h" || args[i] === "--help") {
      console.log(`Usage:
  npx tsx bin/import-terrain/validate-level.ts <path-to-level.json>
  npx tsx bin/import-terrain/validate-level.ts --region <name>`);
      process.exit(0);
    } else if (!args[i].startsWith("-")) {
      levelPath = path.resolve(args[i]);
    }
  }

  if (!levelPath) {
    console.error("No level file specified. Use --help for usage.");
    process.exit(1);
  }

  console.log(`Validating: ${levelPath}`);
  const t0 = performance.now();
  const result = validateLevelFile(levelPath);
  const elapsed = performance.now() - t0;

  console.log(
    `  ${result.contourCount} contours, ${result.rootCount} roots, max depth ${result.maxDepth}  (${elapsed.toFixed(0)}ms)`,
  );

  for (const w of result.warnings) {
    console.log(`  WARNING: ${w}`);
  }

  if (result.errors.length === 0) {
    console.log("  PASS: No errors found");
  } else {
    console.log(`  FAIL: ${result.errors.length} error(s):`);
    for (const e of result.errors) {
      console.log(`    [${e.type}] ${e.message}`);
    }
    process.exit(1);
  }
}

// Only run CLI when executed directly, not when imported
const isDirectExecution =
  process.argv[1] &&
  require.resolve(process.argv[1]) === require.resolve(__filename);
if (isDirectExecution) {
  main();
}
