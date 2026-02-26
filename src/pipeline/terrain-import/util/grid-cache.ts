import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { createHash } from "crypto";
import path from "path";
import { fromFile } from "geotiff";
import {
  bboxIntersects,
  metersToFeet,
  parseTileCoverageFromName,
  type BoundingBox,
} from "./geo-utils";
import type { ScalarGrid } from "../worker/marching-squares";

export interface TileMetadata {
  filePath: string;
  width: number;
  height: number;
  bbox: BoundingBox;
  lonStep: number;
  latStep: number;
  noDataValue: number | null;
}

export interface GridResult {
  grid: ScalarGrid;
  minFeet: number;
  maxFeet: number;
  lonStep: number;
  latStep: number;
}

export function listLocalTiles(
  tilesDir: string,
  targetBbox: BoundingBox,
): string[] {
  if (!existsSync(tilesDir)) {
    return [];
  }
  return readdirSync(tilesDir)
    .filter((name) => /\.tif$/i.test(name))
    .filter((name) => {
      const coverage = parseTileCoverageFromName(name);
      return coverage ? bboxIntersects(coverage, targetBbox) : false;
    })
    .map((name) => path.join(tilesDir, name))
    .sort();
}

export async function readTileMetadata(
  filePath: string,
): Promise<TileMetadata> {
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

export function gridCacheKey(bbox: BoundingBox, tilePaths: string[]): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(bbox));
  for (const p of tilePaths) {
    hash.update(path.basename(p));
  }
  return hash.digest("hex").slice(0, 16);
}

export function saveGridCache(
  cacheDir: string,
  key: string,
  result: GridResult,
): void {
  mkdirSync(cacheDir, { recursive: true });

  const { grid, minFeet, maxFeet, lonStep, latStep } = result;
  const metaPath = path.join(cacheDir, `grid-${key}.json`);
  const valuesPath = path.join(cacheDir, `grid-${key}.values.bin`);
  const maskPath = path.join(cacheDir, `grid-${key}.nodata.bin`);

  writeFileSync(
    metaPath,
    JSON.stringify({
      width: grid.width,
      height: grid.height,
      minFeet,
      maxFeet,
      lonStep,
      latStep,
    }),
  );
  writeFileSync(valuesPath, Buffer.from(grid.values.buffer));
  writeFileSync(maskPath, Buffer.from(grid.nodataMask!));
  console.log(`Cached grid to ${metaPath}`);
}

export function loadGridCache(
  cacheDir: string,
  key: string,
): GridResult | null {
  const metaPath = path.join(cacheDir, `grid-${key}.json`);
  const valuesPath = path.join(cacheDir, `grid-${key}.values.bin`);
  const maskPath = path.join(cacheDir, `grid-${key}.nodata.bin`);

  if (
    !existsSync(metaPath) ||
    !existsSync(valuesPath) ||
    !existsSync(maskPath)
  ) {
    return null;
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  const valuesBuf = readFileSync(valuesPath);
  const maskBuf = readFileSync(maskPath);

  const values = new Float64Array(
    valuesBuf.buffer,
    valuesBuf.byteOffset,
    valuesBuf.byteLength / 8,
  );
  const nodataMask = new Uint8Array(
    maskBuf.buffer,
    maskBuf.byteOffset,
    maskBuf.byteLength,
  );

  console.log(`Loaded cached grid from ${metaPath}`);
  return {
    grid: { width: meta.width, height: meta.height, values, nodataMask },
    minFeet: meta.minFeet,
    maxFeet: meta.maxFeet,
    lonStep: meta.lonStep,
    latStep: meta.latStep,
  };
}
