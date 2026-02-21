#!/usr/bin/env tsx

import path from "path";
import { fromFile } from "geotiff";
import { metersToFeet, type BoundingBox } from "./lib/geo-utils";
import {
  resolveRegion,
  loadRegionConfig,
  tilesDir,
  gridCacheDir,
} from "./lib/region";
import {
  listLocalTiles,
  readTileMetadata,
  gridCacheKey,
  saveGridCache,
  loadGridCache,
  type TileMetadata,
  type GridResult,
} from "./lib/grid-cache";
import type { ScalarGrid } from "./lib/marching-squares";

function intersect(a: BoundingBox, b: BoundingBox): BoundingBox | null {
  const minLat = Math.max(a.minLat, b.minLat);
  const minLon = Math.max(a.minLon, b.minLon);
  const maxLat = Math.min(a.maxLat, b.maxLat);
  const maxLon = Math.min(a.maxLon, b.maxLon);
  if (minLat >= maxLat || minLon >= maxLon) {
    return null;
  }
  return { minLat, minLon, maxLat, maxLon };
}

function levelRange(
  values: Float64Array,
  nodataMask: Uint8Array,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < values.length; i++) {
    if (nodataMask[i] !== 0) {
      continue;
    }
    const value = values[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error("No valid elevation values found in selected area");
  }

  return { min, max };
}

async function buildGrid(
  targetBbox: BoundingBox,
  tiles: TileMetadata[],
): Promise<GridResult> {
  if (tiles.length === 0) {
    throw new Error("No local tiles found to process");
  }

  const lonStep = tiles[0].lonStep;
  const latStep = tiles[0].latStep;

  for (const tile of tiles) {
    if (
      Math.abs(tile.lonStep - lonStep) > 1e-10 ||
      Math.abs(tile.latStep - latStep) > 1e-10
    ) {
      throw new Error("Tile resolution mismatch between downloaded tiles");
    }
  }

  const gridMinLon = targetBbox.minLon;
  const gridMaxLat = targetBbox.maxLat;
  const width = Math.max(
    2,
    Math.ceil((targetBbox.maxLon - targetBbox.minLon) / lonStep) + 2,
  );
  const height = Math.max(
    2,
    Math.ceil((targetBbox.maxLat - targetBbox.minLat) / latStep) + 2,
  );

  const sums = new Float64Array(width * height);
  const counts = new Uint32Array(width * height);

  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t];
    const overlap = intersect(tile.bbox, targetBbox);
    if (!overlap) {
      continue;
    }

    const tiff = await fromFile(tile.filePath);
    const image = await tiff.getImage();

    const left = Math.max(
      0,
      Math.floor((overlap.minLon - tile.bbox.minLon) / tile.lonStep),
    );
    const right = Math.min(
      tile.width,
      Math.ceil((overlap.maxLon - tile.bbox.minLon) / tile.lonStep),
    );
    const top = Math.max(
      0,
      Math.floor((tile.bbox.maxLat - overlap.maxLat) / tile.latStep),
    );
    const bottom = Math.min(
      tile.height,
      Math.ceil((tile.bbox.maxLat - overlap.minLat) / tile.latStep),
    );

    if (left >= right || top >= bottom) {
      continue;
    }

    console.log(
      `[${t + 1}/${tiles.length}] sampling ${path.basename(tile.filePath)} (${right - left}x${bottom - top})`,
    );

    const raster = (await image.readRasters({
      samples: [0],
      interleave: true,
      window: [left, top, right, bottom],
    })) as Float32Array | Float64Array | Int16Array | Int32Array;

    const windowWidth = right - left;
    const noData = tile.noDataValue;

    for (let y = 0; y < bottom - top; y++) {
      for (let x = 0; x < windowWidth; x++) {
        const srcIdx = y * windowWidth + x;
        const value = Number(raster[srcIdx]);
        if (!Number.isFinite(value)) {
          continue;
        }
        if (noData !== null && Math.abs(value - noData) < 1e-6) {
          continue;
        }

        const pixelX = left + x;
        const pixelY = top + y;
        const lon = tile.bbox.minLon + (pixelX + 0.5) * tile.lonStep;
        const lat = tile.bbox.maxLat - (pixelY + 0.5) * tile.latStep;

        const gx = Math.round((lon - gridMinLon) / lonStep);
        const gy = Math.round((gridMaxLat - lat) / latStep);

        if (gx < 0 || gy < 0 || gx >= width || gy >= height) {
          continue;
        }

        const dstIdx = gy * width + gx;
        sums[dstIdx] += metersToFeet(value);
        counts[dstIdx]++;
      }
    }
  }

  const values = new Float64Array(width * height);
  const nodataMask = new Uint8Array(width * height);

  for (let i = 0; i < values.length; i++) {
    if (counts[i] === 0) {
      nodataMask[i] = 1;
      values[i] = 0;
    } else {
      values[i] = sums[i] / counts[i];
      nodataMask[i] = 0;
    }
  }

  const { min, max } = levelRange(values, nodataMask);

  return {
    grid: { width, height, values, nodataMask },
    minFeet: min,
    maxFeet: max,
    lonStep,
    latStep,
  };
}

async function main(): Promise<void> {
  const slug = resolveRegion(process.argv.slice(2));
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

  const cacheKey = gridCacheKey(bbox, localTilePaths);
  const cached = loadGridCache(cache, cacheKey);

  if (cached) {
    console.log(
      `Grid: ${cached.grid.width}x${cached.grid.height}, elevation range ${cached.minFeet.toFixed(1)}ft to ${cached.maxFeet.toFixed(1)}ft`,
    );
    console.log("Grid cache is up to date, nothing to do.");
    return;
  }

  let t0 = performance.now();
  const tileMetas: TileMetadata[] = [];
  for (const tilePath of localTilePaths) {
    tileMetas.push(await readTileMetadata(tilePath));
  }
  console.log(`Read tile metadata: ${(performance.now() - t0).toFixed(0)}ms`);

  t0 = performance.now();
  const gridResult = await buildGrid(bbox, tileMetas);
  console.log(`Build grid: ${(performance.now() - t0).toFixed(0)}ms`);

  t0 = performance.now();
  saveGridCache(cache, cacheKey, gridResult);
  console.log(`Save cache: ${(performance.now() - t0).toFixed(0)}ms`);

  console.log(
    `Grid: ${gridResult.grid.width}x${gridResult.grid.height}, elevation range ${gridResult.minFeet.toFixed(1)}ft to ${gridResult.maxFeet.toFixed(1)}ft`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
