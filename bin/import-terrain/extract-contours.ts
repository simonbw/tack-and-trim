#!/usr/bin/env tsx

import { existsSync, mkdirSync, createWriteStream } from "fs";
import path from "path";
import { fromFile } from "geotiff";
import { validateLevelFile } from "./validate-level";
import { metersToFeet, bboxCenter } from "./lib/geo-utils";
import { resolveRegion, loadRegionConfig, gridCacheDir } from "./lib/region";
import type { ScalarGrid } from "./lib/marching-squares";
import { buildClosedRings } from "./lib/marching-squares";
import { ContourWorkerPool } from "./lib/worker-pool";
import { DEFAULT_DEPTH } from "../../src/game/world/terrain/TerrainConstants";

interface TerrainContourJson {
  height: number;
  polygon: [number, number][];
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

  // Compute elevation range
  let minFeet = Infinity;
  let maxFeet = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < minFeet) minFeet = values[i];
    if (values[i] > maxFeet) maxFeet = values[i];
  }

  return {
    grid: { width, height, values },
    minFeet,
    maxFeet,
    lonStep,
    latStep,
  };
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

  await pool.setSimplifyConfig({
    centerLat: center.lat,
    centerLon: center.lon,
    bboxMinLon: bbox.minLon,
    bboxMaxLat: bbox.maxLat,
    lonStep,
    latStep,
    simplifyFeet: config.simplify,
    minPerimeterFeet: config.minPerimeter,
    minPoints: config.minPoints,
    scale: config.scale,
    flipY: config.flipY,
  });

  const contours: TerrainContourJson[] = [];
  let totalMarchMs = 0;
  let totalRingsSimplifyMs = 0;
  let totalRings = 0;

  for (let li = 0; li < levels.length; li++) {
    const levelFeet = levels[li];

    timer = performance.now();
    const segments = await pool.marchContours(levelFeet);
    const marchMs = performance.now() - timer;
    totalMarchMs += marchMs;

    // Ring assembly and simplification overlap: the generator yields rings
    // one at a time, and workers pull them as they become available.
    timer = performance.now();
    const rings = buildClosedRings(segments);
    const { contours: levelContours, ringCount } = await pool.simplifyRings(
      rings,
      levelFeet,
    );
    contours.push(...levelContours);
    const ringsSimplifyMs = performance.now() - timer;
    totalRingsSimplifyMs += ringsSimplifyMs;
    totalRings += ringCount;

    const levelPoints = levelContours.reduce(
      (sum, c) => sum + c.polygon.length,
      0,
    );
    console.log(
      `[${li + 1}/${levels.length}] ${levelFeet}ft: ${ringCount} rings → ${levelContours.length} kept (${levelPoints.toLocaleString()} pts)  (march ${marchMs.toFixed(0)}ms, rings+simplify ${ringsSimplifyMs.toFixed(0)}ms)`,
    );
  }

  const totalPoints = contours.reduce((sum, c) => sum + c.polygon.length, 0);
  console.log(
    `\nTotals: ${totalRings} rings → ${contours.length} contours (${totalPoints.toLocaleString()} pts)  (march ${totalMarchMs.toFixed(0)}ms, rings+simplify ${totalRingsSimplifyMs.toFixed(0)}ms)`,
  );

  await pool.shutdown();

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
    `Wrote ${contours.length} contours (${totalPoints.toLocaleString()} pts) to ${outputPath}  (write ${(performance.now() - timer).toFixed(0)}ms)`,
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
