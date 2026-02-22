#!/usr/bin/env tsx

import { existsSync, mkdirSync, createWriteStream } from "fs";
import path from "path";
import { fromFile } from "geotiff";
import { validateLevelFile } from "./validate-level";
import { latLonToFeet, metersToFeet, bboxCenter } from "./lib/geo-utils";
import { resolveRegion, loadRegionConfig, gridCacheDir } from "./lib/region";
import type { ScalarGrid } from "./lib/marching-squares";
import { buildClosedRings } from "./lib/marching-squares";
import { ContourWorkerPool } from "./lib/worker-pool";
import { ringPerimeter, signedArea, type Point } from "./lib/simplify";
import { createSegmentIndex } from "./lib/segment-index";
import { constrainedSimplifyClosedRing } from "./lib/constrained-simplify";
import { DEFAULT_DEPTH } from "../../src/game/world/terrain/TerrainConstants";

interface TerrainContourJson {
  height: number;
  polygon: [number, number][];
}

/** Collected ring in feet coordinates, before simplification. */
interface RawRing {
  height: number;
  points: Point[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}

function quantizeLevels(min: number, max: number, interval: number): number[] {
  const levels: number[] = [];
  const start = Math.floor(min / interval) * interval;
  const end = Math.ceil(max / interval) * interval;

  for (let level = start; level <= end + interval * 0.1; level += interval) {
    levels.push(Number(level.toFixed(6)));
  }

  return levels;
}

/**
 * Load the merged GeoTIFF and convert to a ScalarGrid in feet.
 * Also fills nodata cells: single-row gaps are interpolated from neighbors,
 * remaining nodata is filled with DEFAULT_DEPTH.
 */
async function loadMergedGrid(mergedPath: string): Promise<{
  grid: ScalarGrid;
  minFeet: number;
  maxFeet: number;
  lonStep: number;
  latStep: number;
}> {
  const tiff = await fromFile(mergedPath);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  const lonStep = (maxLon - minLon) / width;
  const latStep = (maxLat - minLat) / height;

  const noDataRaw = image.getGDALNoData();
  const noDataValue =
    noDataRaw === null || noDataRaw === undefined ? null : Number(noDataRaw);

  const raster = (await image.readRasters({
    samples: [0],
    interleave: true,
  })) as Float32Array | Float64Array | Int16Array | Int32Array;

  // Convert to feet and build nodata mask
  const values = new Float64Array(width * height);
  const nodataMask = new Uint8Array(width * height);

  for (let i = 0; i < values.length; i++) {
    const v = Number(raster[i]);
    if (
      !Number.isFinite(v) ||
      (noDataValue !== null && Math.abs(v - noDataValue) < 1e-6)
    ) {
      nodataMask[i] = 1;
      values[i] = 0;
    } else {
      values[i] = metersToFeet(v);
      nodataMask[i] = 0;
    }
  }

  // Interpolate single-row nodata gaps (tile-seam artifacts)
  let seamFills = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (nodataMask[i] === 0) continue;
      const above = (y - 1) * width + x;
      const below = (y + 1) * width + x;
      if (nodataMask[above] === 0 && nodataMask[below] === 0) {
        values[i] = (values[above] + values[below]) / 2;
        nodataMask[i] = 0;
        seamFills++;
      }
    }
  }
  if (seamFills > 0) {
    console.log(
      `Interpolated ${seamFills.toLocaleString()} tile-seam nodata cells`,
    );
  }

  // Fill remaining nodata with DEFAULT_DEPTH
  let depthFills = 0;
  for (let i = 0; i < values.length; i++) {
    if (nodataMask[i] !== 0) {
      values[i] = DEFAULT_DEPTH;
      nodataMask[i] = 0;
      depthFills++;
    }
  }
  if (depthFills > 0) {
    console.log(
      `Filled ${depthFills.toLocaleString()} remaining nodata cells with ${DEFAULT_DEPTH}ft`,
    );
  }

  // Pad grid with a 1-cell border of DEFAULT_DEPTH so contours that reach the
  // original grid boundary can continue through the padding and close properly.
  const padW = width + 2;
  const padH = height + 2;
  const padded = new Float64Array(padW * padH);
  padded.fill(DEFAULT_DEPTH);
  for (let y = 0; y < height; y++) {
    const srcOff = y * width;
    const dstOff = (y + 1) * padW + 1;
    padded.set(values.subarray(srcOff, srcOff + width), dstOff);
  }

  // Compute elevation range (from original data, not padding)
  let minFeet = Infinity;
  let maxFeet = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < minFeet) minFeet = values[i];
    if (values[i] > maxFeet) maxFeet = values[i];
  }

  return {
    grid: { width: padW, height: padH, values: padded },
    minFeet,
    maxFeet,
    lonStep,
    latStep,
  };
}

// ---------------------------------------------------------------------------
// Containment tree (point-in-polygon based, same algorithm as validate-level)
// ---------------------------------------------------------------------------

function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

interface ContourNode {
  ringIndex: number;
  children: ContourNode[];
}

function buildContainmentTree(rings: RawRing[]): ContourNode[] {
  const virtualChildren: ContourNode[] = [];

  function bboxContains(
    outer: RawRing["bbox"],
    inner: RawRing["bbox"],
  ): boolean {
    return (
      outer.minX <= inner.minX &&
      outer.maxX >= inner.maxX &&
      outer.minY <= inner.minY &&
      outer.maxY >= inner.maxY
    );
  }

  function isInside(innerIdx: number, outerIdx: number): boolean {
    if (!bboxContains(rings[outerIdx].bbox, rings[innerIdx].bbox)) return false;
    const innerPt = rings[innerIdx].points[0];
    return pointInPolygon(innerPt[0], innerPt[1], rings[outerIdx].points);
  }

  function insertContour(parent: ContourNode | null, newIndex: number): void {
    const children = parent ? parent.children : virtualChildren;

    for (const child of children) {
      if (isInside(newIndex, child.ringIndex)) {
        insertContour(child, newIndex);
        return;
      }
    }

    const newNode: ContourNode = { ringIndex: newIndex, children: [] };

    const toReparent: ContourNode[] = [];
    for (const child of children) {
      if (isInside(child.ringIndex, newIndex)) {
        toReparent.push(child);
      }
    }
    for (const child of toReparent) {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      newNode.children.push(child);
    }
    children.push(newNode);
  }

  for (let i = 0; i < rings.length; i++) {
    insertContour(null, i);
  }

  return virtualChildren;
}

/** BFS order from tree roots (outside-in). */
function bfsOrder(roots: ContourNode[]): number[] {
  const order: number[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const node = queue.shift()!;
    order.push(node.ringIndex);
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return order;
}

async function main(): Promise<void> {
  const slug = resolveRegion(process.argv.slice(2));
  const config = loadRegionConfig(slug);
  const bbox = config.bbox;
  const cache = gridCacheDir(slug);

  const mergedPath = path.join(cache, "merged.tif");
  if (!existsSync(mergedPath)) {
    throw new Error(
      `No merged grid found at ${mergedPath}. Run build-grid step first.`,
    );
  }

  let timer = performance.now();
  const { grid, minFeet, maxFeet, lonStep, latStep } =
    await loadMergedGrid(mergedPath);
  console.log(`Load grid: ${(performance.now() - timer).toFixed(0)}ms`);

  console.log(`Region: ${config.name}`);
  console.log(
    `Grid: ${grid.width}x${grid.height}, elevation range ${minFeet.toFixed(1)}ft to ${maxFeet.toFixed(1)}ft`,
  );
  console.log(
    `Settings: interval ${config.interval}ft, simplify ${config.simplify}ft, scale ${config.scale}, minPerimeter ${config.minPerimeter}ft, minPoints ${config.minPoints}`,
  );

  // Skip contours at or below defaultDepth — the game treats that as uniform deep ocean
  const clampedMin = Math.max(minFeet, DEFAULT_DEPTH + config.interval);
  const levels = quantizeLevels(clampedMin, maxFeet, config.interval);
  const center = bboxCenter(bbox);

  // Geo conversion parameters (extracted from what was previously SimplifyConfig)
  const bboxMinLon = bbox.minLon - lonStep; // adjust for 1-cell padding
  const bboxMaxLat = bbox.maxLat + latStep; // adjust for 1-cell padding

  timer = performance.now();
  const pool = ContourWorkerPool.create(grid);
  console.log(
    `Worker pool: ${pool.workerCount} workers  (${(performance.now() - timer).toFixed(0)}ms)`,
  );

  timer = performance.now();
  const blocks = await pool.buildBlockIndex();
  console.log(
    `Block index: ${blocks.blockCols}x${blocks.blockRows} blocks  (${(performance.now() - timer).toFixed(0)}ms)`,
  );

  // =========================================================================
  // Phase 1: March all levels with workers, convert to feet, pre-filter
  // =========================================================================

  const allRings: RawRing[] = [];
  let totalMarchMs = 0;
  let totalRingsMs = 0;
  let totalRawRings = 0;

  for (let li = 0; li < levels.length; li++) {
    const levelFeet = levels[li];

    timer = performance.now();
    const segments = await pool.marchContours(levelFeet);
    const marchMs = performance.now() - timer;
    totalMarchMs += marchMs;

    timer = performance.now();
    const rings = buildClosedRings(segments);
    let ringCount = 0;
    let keptCount = 0;

    for (const ringCoords of rings) {
      ringCount++;
      const numPoints = ringCoords.length / 2;

      // Convert grid coords → feet
      const feetPoints: Point[] = new Array(numPoints);
      let bMinX = Infinity,
        bMinY = Infinity,
        bMaxX = -Infinity,
        bMaxY = -Infinity;

      for (let i = 0; i < numPoints; i++) {
        const gx = ringCoords[i * 2];
        const gy = ringCoords[i * 2 + 1];
        const lon = bboxMinLon + gx * lonStep;
        const lat = bboxMaxLat - gy * latStep;
        const [xFeet, yFeet] = latLonToFeet(lat, lon, center.lat, center.lon);
        const fx = xFeet;
        const fy = config.flipY ? -yFeet : yFeet;
        feetPoints[i] = [fx, fy];
        if (fx < bMinX) bMinX = fx;
        if (fx > bMaxX) bMaxX = fx;
        if (fy < bMinY) bMinY = fy;
        if (fy > bMaxY) bMaxY = fy;
      }

      // Pre-filter: discard tiny rings before simplification
      const perimeter = ringPerimeter(feetPoints);
      if (perimeter < config.minPerimeter) continue;
      if (feetPoints.length < config.minPoints) continue;

      allRings.push({
        height: levelFeet,
        points: feetPoints,
        bbox: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY },
      });
      keptCount++;
    }

    const ringsMs = performance.now() - timer;
    totalRingsMs += ringsMs;
    totalRawRings += ringCount;

    console.log(
      `[${li + 1}/${levels.length}] ${levelFeet}ft: ${ringCount} rings → ${keptCount} kept  (march ${marchMs.toFixed(0)}ms, convert ${ringsMs.toFixed(0)}ms)`,
    );
  }

  await pool.shutdown();

  console.log(
    `\nPhase 1: ${totalRawRings} raw rings → ${allRings.length} pre-filtered  (march ${totalMarchMs.toFixed(0)}ms, convert ${totalRingsMs.toFixed(0)}ms)`,
  );

  // =========================================================================
  // Phase 2: Containment tree → BFS order → constrained simplification
  // =========================================================================

  timer = performance.now();
  const treeRoots = buildContainmentTree(allRings);
  const order = bfsOrder(treeRoots);
  const treeMs = performance.now() - timer;
  console.log(
    `Containment tree: ${treeRoots.length} roots, BFS order computed  (${treeMs.toFixed(0)}ms)`,
  );

  // Global bbox for segment index
  let gMinX = Infinity,
    gMinY = Infinity,
    gMaxX = -Infinity,
    gMaxY = -Infinity;
  for (const ring of allRings) {
    if (ring.bbox.minX < gMinX) gMinX = ring.bbox.minX;
    if (ring.bbox.minY < gMinY) gMinY = ring.bbox.minY;
    if (ring.bbox.maxX > gMaxX) gMaxX = ring.bbox.maxX;
    if (ring.bbox.maxY > gMaxY) gMaxY = ring.bbox.maxY;
  }

  // Cell size: target ~8 segments per cell, minimum 50ft
  let totalPoints = 0;
  for (const ring of allRings) totalPoints += ring.points.length;
  const area = (gMaxX - gMinX) * (gMaxY - gMinY);
  const cellSize = Math.max(Math.sqrt(area / (totalPoints / 8)), 50);

  const segIndex = createSegmentIndex(gMinX, gMinY, gMaxX, gMaxY, cellSize);

  // Pre-populate the index with all unsimplified rings so that outer contour
  // simplification is constrained against inner contours (and vice versa).
  for (let i = 0; i < allRings.length; i++) {
    segIndex.addContourSegments(i, allRings[i].points);
  }

  timer = performance.now();
  const contours: TerrainContourJson[] = [];
  let constrainedKept = 0;

  for (const ringIdx of order) {
    const ring = allRings[ringIdx];

    const simplified = constrainedSimplifyClosedRing(
      ring.points,
      config.simplify,
      ringIdx,
      segIndex,
    );

    if (simplified.length < config.minPoints) continue;

    // Replace unsimplified segments with finalized simplified ones
    segIndex.removeContourSegments(ringIdx);
    segIndex.addContourSegments(ringIdx, simplified);

    // Scale to game units, ensure CCW winding
    const scaled: Point[] = simplified.map(([x, y]) => [
      x / config.scale,
      y / config.scale,
    ]);
    if (signedArea(scaled) < 0) scaled.reverse();

    contours.push({
      height: Number(ring.height.toFixed(3)),
      polygon: scaled.map(
        ([x, y]) =>
          [Number(x.toFixed(3)), Number(y.toFixed(3))] as [number, number],
      ),
    });
    constrainedKept++;
  }

  const simplifyMs = performance.now() - timer;
  const finalPoints = contours.reduce((sum, c) => sum + c.polygon.length, 0);
  console.log(
    `Phase 2: ${allRings.length} → ${constrainedKept} contours (${finalPoints.toLocaleString()} pts)  (simplify ${simplifyMs.toFixed(0)}ms)`,
  );

  contours.sort((a, b) => a.height - b.height);

  const outputPath = path.resolve(config.output);
  mkdirSync(path.dirname(outputPath), { recursive: true });

  // Stream JSON to avoid "Invalid string length" for large contour sets
  timer = performance.now();
  const out = createWriteStream(outputPath, "utf-8");
  out.write(
    `{\n  "version": 1,\n  "defaultDepth": ${DEFAULT_DEPTH},\n  "contours": [\n`,
  );
  for (let i = 0; i < contours.length; i++) {
    const line = `    ${JSON.stringify(contours[i])}`;
    out.write(i < contours.length - 1 ? `${line},\n` : `${line}\n`);
  }
  out.write("  ]\n}\n");
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve());
    out.on("error", reject);
  });

  console.log(
    `Wrote ${contours.length} contours (${finalPoints.toLocaleString()} pts) to ${outputPath}  (write ${(performance.now() - timer).toFixed(0)}ms)`,
  );

  // Validate the output
  console.log("\nValidating output...");
  const validation = validateLevelFile(outputPath);
  console.log(
    `  ${validation.contourCount} contours, ${validation.rootCount} roots, max depth ${validation.maxDepth}`,
  );
  for (const w of validation.warnings) {
    console.log(`  WARNING: ${w}`);
  }
  if (validation.errors.length === 0) {
    console.log("  PASS: No errors found");
  } else {
    console.log(`  FAIL: ${validation.errors.length} error(s):`);
    for (const e of validation.errors) {
      console.log(`    [${e.type}] ${e.message}`);
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
