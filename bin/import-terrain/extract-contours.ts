#!/usr/bin/env tsx

import { mkdirSync, createWriteStream } from "fs";
import path from "path";
import { bboxCenter } from "./lib/geo-utils";
import {
  resolveRegion,
  loadRegionConfig,
  tilesDir,
  gridCacheDir,
} from "./lib/region";
import { listLocalTiles, gridCacheKey, loadGridCache } from "./lib/grid-cache";
import { buildClosedRings } from "./lib/marching-squares";
import { ContourWorkerPool } from "./lib/worker-pool";
import { DEFAULT_DEPTH } from "../../src/game/world/terrain/TerrainConstants";

interface TerrainContourJson {
  height: number;
  controlPoints: [number, number][];
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

async function main(): Promise<void> {
  const slug = resolveRegion(process.argv.slice(2));
  const config = loadRegionConfig(slug);
  const bbox = config.bbox;
  const tiles = tilesDir(slug);
  const cache = gridCacheDir(slug);

  const localTilePaths = listLocalTiles(tiles, bbox);
  if (localTilePaths.length === 0) {
    throw new Error(
      `No matching GeoTIFF files in ${tiles}. Run download step first.`,
    );
  }

  const cacheKey = gridCacheKey(bbox, localTilePaths);
  const gridResult = loadGridCache(cache, cacheKey);

  if (!gridResult) {
    throw new Error(
      `No cached grid found in ${cache}. Run build-grid step first.`,
    );
  }

  const { grid, minFeet, maxFeet, lonStep, latStep } = gridResult;

  console.log(`Region: ${config.name}`);
  console.log(
    `Grid: ${grid.width}x${grid.height}, elevation range ${minFeet.toFixed(1)}ft to ${maxFeet.toFixed(1)}ft`,
  );

  // Skip contours at or below defaultDepth — the game treats that as uniform deep ocean
  const clampedMin = Math.max(minFeet, DEFAULT_DEPTH + config.interval);
  const levels = quantizeLevels(clampedMin, maxFeet, config.interval);
  const center = bboxCenter(bbox);

  let timer = performance.now();
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

    console.log(
      `[${li + 1}/${levels.length}] ${levelFeet}ft: ${ringCount} rings → ${levelContours.length} kept  (march ${marchMs.toFixed(0)}ms, rings+simplify ${ringsSimplifyMs.toFixed(0)}ms)`,
    );
  }

  console.log(
    `\nTotals: ${totalRings} rings → ${contours.length} contours  (march ${totalMarchMs.toFixed(0)}ms, rings+simplify ${totalRingsSimplifyMs.toFixed(0)}ms)`,
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
    `Wrote ${contours.length} contours to ${outputPath}  (write ${(performance.now() - timer).toFixed(0)}ms)`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
