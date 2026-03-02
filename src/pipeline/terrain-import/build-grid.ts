#!/usr/bin/env tsx

/**
 * Step 2: Merge downloaded GeoTIFF tiles into a single elevation raster.
 *
 * Uses GDAL's gdalwarp to merge and clip tiles to the region bounding box.
 * The output is a single GeoTIFF in the region's cache directory, which
 * extract-contours.ts reads directly.
 *
 * Requires: gdal (brew install gdal)
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import path from "path";
import {
  resolveRegion,
  loadRegionConfig,
  tilesDir,
  gridCacheDir,
} from "./util/region";
import { listLocalTiles } from "./util/grid-cache";

async function main(): Promise<void> {
  const slug = await resolveRegion(process.argv.slice(2));
  const config = loadRegionConfig(slug);
  const bbox = config.bbox;
  const tiles = tilesDir(slug);
  const cache = gridCacheDir(slug);

  console.log(`Region: ${config.name}`);
  console.log(
    `BBOX: ${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)} → ${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}`,
  );

  const localTilePaths = listLocalTiles(tiles, bbox);
  if (localTilePaths.length === 0) {
    throw new Error(
      `No matching GeoTIFF files in ${tiles}. Run download step first.`,
    );
  }

  const outputPath = path.join(cache, "merged.tif");
  const force = process.argv.includes("--force");

  if (!force && existsSync(outputPath)) {
    console.log(`Merged grid already exists: ${outputPath}`);
    console.log("Use --force to rebuild.");
    return;
  }

  // Ensure cache directory exists
  execSync(`mkdir -p "${cache}"`);

  console.log(`Merging ${localTilePaths.length} tiles with gdalwarp...`);

  const t0 = performance.now();
  const tileArgs = localTilePaths.map((p) => `"${p}"`).join(" ");
  const cmd = [
    "gdalwarp",
    "-t_srs EPSG:4326",
    `-te ${bbox.minLon} ${bbox.minLat} ${bbox.maxLon} ${bbox.maxLat}`,
    "-overwrite",
    tileArgs,
    `"${outputPath}"`,
  ].join(" ");

  execSync(cmd, { stdio: "inherit" });

  const elapsed = performance.now() - t0;
  console.log(`Merged grid: ${outputPath}  (${elapsed.toFixed(0)}ms)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
