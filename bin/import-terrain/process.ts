#!/usr/bin/env tsx

import { mkdirSync, readdirSync, writeFileSync } from "fs";
import path from "path";
import { fromFile } from "geotiff";
import {
  bboxCenter,
  bboxIntersects,
  latLonToFeet,
  metersToFeet,
  parseTileCoverageFromName,
  REGION_PRESETS,
  resolveBbox,
  type BoundingBox,
} from "./lib/geo-utils";
import { extractContours, type ScalarGrid } from "./lib/marching-squares";
import { ringPerimeter, simplifyClosedRing, type Point } from "./lib/simplify";

interface ProcessArgs {
  region?: string;
  bbox?: string;
  datasetPath?: string;
  cacheDir: string;
  intervalFeet: number;
  simplifyFeet: number;
  scale: number;
  minPerimeterFeet: number;
  minPoints: number;
  defaultDepth: number;
  outputPath: string;
  flipY: boolean;
}

interface TileMetadata {
  filePath: string;
  width: number;
  height: number;
  bbox: BoundingBox;
  lonStep: number;
  latStep: number;
  noDataValue: number | null;
}

interface TerrainContourJson {
  height: number;
  controlPoints: [number, number][];
}

function printHelp(): void {
  console.log(`Usage: tsx bin/import-terrain/process.ts [options]

Options:
  --region <name>         Region preset (${Object.keys(REGION_PRESETS).join(", ")})
  --bbox <minLat,minLon,maxLat,maxLon>
                          Custom bbox if region is not provided
  --dataset-path <path>   Dataset subfolder (default from region, else wash_juandefuca/)
  --cache-dir <dir>       Download cache root (default: data/terrain-cache)
  --interval <feet>       Contour interval (default: 20)
  --simplify <feet>       RDP tolerance (default: 50)
  --scale <number>        Real-feet per game-foot (default: 1)
  --min-perimeter <feet>  Minimum perimeter to keep (default: 500)
  --min-points <count>    Minimum point count after simplify (default: 4)
  --default-depth <feet>  File default depth (default: -50)
  --output <path>         Output .terrain.json path (required)
  --flip-y                Flip Y axis for output coordinates (default: false)
  -h, --help              Show help
`);
}

function parseArgs(argv: string[]): ProcessArgs {
  const args: ProcessArgs = {
    cacheDir: "data/terrain-cache",
    intervalFeet: 20,
    simplifyFeet: 50,
    scale: 1,
    minPerimeterFeet: 500,
    minPoints: 4,
    defaultDepth: -50,
    outputPath: "",
    flipY: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--region") {
      args.region = argv[++i];
    } else if (arg === "--bbox") {
      args.bbox = argv[++i];
    } else if (arg === "--dataset-path") {
      args.datasetPath = argv[++i];
    } else if (arg === "--cache-dir") {
      args.cacheDir = argv[++i];
    } else if (arg === "--interval") {
      args.intervalFeet = Number(argv[++i]);
    } else if (arg === "--simplify") {
      args.simplifyFeet = Number(argv[++i]);
    } else if (arg === "--scale") {
      args.scale = Number(argv[++i]);
    } else if (arg === "--min-perimeter") {
      args.minPerimeterFeet = Number(argv[++i]);
    } else if (arg === "--min-points") {
      args.minPoints = Number(argv[++i]);
    } else if (arg === "--default-depth") {
      args.defaultDepth = Number(argv[++i]);
    } else if (arg === "--output") {
      args.outputPath = argv[++i];
    } else if (arg === "--flip-y") {
      args.flipY = true;
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.outputPath) {
    throw new Error("Missing required argument: --output <path>");
  }

  if (!Number.isFinite(args.intervalFeet) || args.intervalFeet <= 0) {
    throw new Error("--interval must be > 0");
  }
  if (!Number.isFinite(args.simplifyFeet) || args.simplifyFeet < 0) {
    throw new Error("--simplify must be >= 0");
  }
  if (!Number.isFinite(args.scale) || args.scale <= 0) {
    throw new Error("--scale must be > 0");
  }
  if (!Number.isFinite(args.minPerimeterFeet) || args.minPerimeterFeet < 0) {
    throw new Error("--min-perimeter must be >= 0");
  }
  if (!Number.isFinite(args.minPoints) || args.minPoints < 3) {
    throw new Error("--min-points must be >= 3");
  }

  return args;
}

function normalizeDatasetPath(datasetPath: string): string {
  const normalized = datasetPath.trim().replace(/^\/+/, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

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

function signedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area * 0.5;
}

function listLocalTiles(cacheDatasetDir: string, targetBbox: BoundingBox): string[] {
  const files = readdirSync(cacheDatasetDir)
    .filter((name) => /\.tif$/i.test(name))
    .filter((name) => {
      const coverage = parseTileCoverageFromName(name);
      return coverage ? bboxIntersects(coverage, targetBbox) : false;
    })
    .map((name) => path.join(cacheDatasetDir, name));

  return files.sort();
}

async function readTileMetadata(filePath: string): Promise<TileMetadata> {
  const tiff = await fromFile(filePath);
  const image = await tiff.getImage();

  const [minLon, minLat, maxLon, maxLat] = image.getBoundingBox();
  const width = image.getWidth();
  const height = image.getHeight();

  const lonStep = (maxLon - minLon) / width;
  const latStep = (maxLat - minLat) / height;

  const noDataRaw = image.getGDALNoData();
  const noDataValue =
    noDataRaw === null || noDataRaw === undefined ? null : Number(noDataRaw);

  return {
    filePath,
    width,
    height,
    bbox: { minLat, minLon, maxLat, maxLon },
    lonStep,
    latStep,
    noDataValue: Number.isFinite(noDataValue) ? noDataValue : null,
  };
}

function levelRange(values: Float64Array, nodataMask: Uint8Array): {
  min: number;
  max: number;
} {
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

function quantizeLevels(min: number, max: number, interval: number): number[] {
  const levels: number[] = [];
  const start = Math.floor(min / interval) * interval;
  const end = Math.ceil(max / interval) * interval;

  for (let level = start; level <= end + interval * 0.1; level += interval) {
    levels.push(Number(level.toFixed(6)));
  }

  return levels;
}

function toTerrainContour(
  ring: Point[],
  center: { lat: number; lon: number },
  levelFeet: number,
  latLonForPoint: (gridX: number, gridY: number) => { lat: number; lon: number },
  simplifyFeet: number,
  minPerimeterFeet: number,
  minPoints: number,
  scale: number,
  flipY: boolean,
): TerrainContourJson | null {
  const feetPoints: Point[] = ring.map(([gx, gy]) => {
    const { lat, lon } = latLonForPoint(gx, gy);
    const [xFeet, yFeet] = latLonToFeet(lat, lon, center.lat, center.lon);

    return [xFeet, flipY ? -yFeet : yFeet];
  });

  const simplified = simplifyClosedRing(feetPoints, simplifyFeet);
  if (simplified.length < minPoints) {
    return null;
  }

  const perimeter = ringPerimeter(simplified);
  if (perimeter < minPerimeterFeet) {
    return null;
  }

  const scaled: Point[] = simplified.map(([x, y]) => [x / scale, y / scale]);
  if (signedArea(scaled) < 0) {
    scaled.reverse();
  }

  return {
    height: Number(levelFeet.toFixed(3)),
    controlPoints: scaled.map(
      ([x, y]) => [Number(x.toFixed(3)), Number(y.toFixed(3))] as [number, number],
    ),
  };
}

async function buildGrid(
  targetBbox: BoundingBox,
  tiles: TileMetadata[],
): Promise<{ grid: ScalarGrid; minFeet: number; maxFeet: number; lonStep: number; latStep: number }> {
  if (tiles.length === 0) {
    throw new Error("No local tiles found to process");
  }

  const lonStep = tiles[0].lonStep;
  const latStep = tiles[0].latStep;

  for (const tile of tiles) {
    if (Math.abs(tile.lonStep - lonStep) > 1e-10 || Math.abs(tile.latStep - latStep) > 1e-10) {
      throw new Error("Tile resolution mismatch between downloaded tiles");
    }
  }

  const gridMinLon = targetBbox.minLon;
  const gridMaxLat = targetBbox.maxLat;
  const width = Math.max(2, Math.ceil((targetBbox.maxLon - targetBbox.minLon) / lonStep) + 2);
  const height = Math.max(2, Math.ceil((targetBbox.maxLat - targetBbox.minLat) / latStep) + 2);

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
  const args = parseArgs(process.argv.slice(2));
  const { bbox, region } = resolveBbox(args.region, args.bbox);

  const datasetPath = normalizeDatasetPath(
    args.datasetPath ?? region?.datasetPath ?? "wash_juandefuca/",
  );

  const cacheDatasetDir = path.resolve(
    args.cacheDir,
    datasetPath.replace(/\/+$/, ""),
  );

  console.log(`Dataset: ${datasetPath}`);
  console.log(
    `BBOX: ${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)} → ${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}`,
  );

  const localTilePaths = listLocalTiles(cacheDatasetDir, bbox);
  if (localTilePaths.length === 0) {
    throw new Error(
      `No matching GeoTIFF files in cache path: ${cacheDatasetDir}. Run download step first.`,
    );
  }

  const tiles: TileMetadata[] = [];
  for (const tilePath of localTilePaths) {
    tiles.push(await readTileMetadata(tilePath));
  }

  const { grid, minFeet, maxFeet, lonStep, latStep } = await buildGrid(bbox, tiles);

  console.log(
    `Grid: ${grid.width}x${grid.height}, elevation range ${minFeet.toFixed(1)}ft to ${maxFeet.toFixed(1)}ft`,
  );

  const levels = quantizeLevels(minFeet, maxFeet, args.intervalFeet);
  const center = bboxCenter(bbox);

  const latLonForPoint = (gridX: number, gridY: number) => ({
    lon: bbox.minLon + gridX * lonStep,
    lat: bbox.maxLat - gridY * latStep,
  });

  const contours: TerrainContourJson[] = [];

  for (const levelFeet of levels) {
    const rings = extractContours(grid, levelFeet);
    for (const ring of rings) {
      const contour = toTerrainContour(
        ring,
        center,
        levelFeet,
        latLonForPoint,
        args.simplifyFeet,
        args.minPerimeterFeet,
        args.minPoints,
        args.scale,
        args.flipY,
      );
      if (contour) {
        contours.push(contour);
      }
    }
  }

  contours.sort((a, b) => a.height - b.height);

  const output = {
    version: 1,
    defaultDepth: args.defaultDepth,
    contours,
  };

  const outputPath = path.resolve(args.outputPath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf-8");

  console.log(`Wrote ${contours.length} contours to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
