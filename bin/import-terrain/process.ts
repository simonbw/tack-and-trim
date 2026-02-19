/**
 * Process cached GeoTIFF topobathy data into a .terrain.json file.
 *
 * Usage:
 *   tsx bin/import-terrain/process.ts \
 *     --region san-juan-islands \
 *     --interval 20 \
 *     --simplify 50 \
 *     --scale 1 \
 *     --min-perimeter 500 \
 *     --output resources/terrain/san-juan-islands.terrain.json
 */

import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { fromArrayBuffer, GeoTIFF } from "geotiff";
import {
  LatLonBBox,
  REGIONS,
  latLonToFeet,
  metersToFeet,
} from "./lib/geo-utils";
import { extractContours } from "./lib/marching-squares";
import { simplifyPolygon } from "./lib/simplify";

const CACHE_DIR = path.resolve(__dirname, "../../data/terrain-cache");

interface ProcessedGrid {
  /** Elevation values in feet, row-major */
  data: Float32Array;
  /** Number of columns */
  width: number;
  /** Number of rows */
  height: number;
  /** X coordinate (feet) of the grid origin (top-left) */
  originX: number;
  /** Y coordinate (feet) of the grid origin (top-left) */
  originY: number;
  /** Width of each cell in feet */
  cellWidth: number;
  /** Height of each cell in feet (negative because Y increases upward) */
  cellHeight: number;
}

/**
 * Load a GeoTIFF tile and return its raster data and geographic info.
 */
async function loadTile(
  filePath: string,
): Promise<{
  data: Float32Array;
  bbox: number[];
  width: number;
  height: number;
}> {
  const buffer = fs.readFileSync(filePath);
  const tiff: GeoTIFF = await fromArrayBuffer(buffer.buffer as ArrayBuffer);
  const image = await tiff.getImage();

  const width = image.getWidth();
  const height = image.getHeight();
  const bbox = image.getBoundingBox(); // [west, south, east, north]

  const rasters = await image.readRasters();
  const data = new Float32Array(rasters[0] as Float32Array);

  return { data, bbox, width, height };
}

/**
 * Merge multiple tiles into a single grid covering the target bounding box.
 * Returns elevation data in feet, cropped to the bbox, with the coordinate
 * system origin at the center of the bbox.
 */
async function loadAndMergeGrid(
  tileFiles: string[],
  targetBbox: LatLonBBox,
  downsample: number = 1,
): Promise<ProcessedGrid> {
  // Compute the center of the target bbox for our coordinate system
  const centerLat = (targetBbox.south + targetBbox.north) / 2;
  const centerLon = (targetBbox.west + targetBbox.east) / 2;

  // Load all tiles to determine resolution
  console.log(`  Loading ${tileFiles.length} tiles...`);
  const tiles = [];
  for (const file of tileFiles) {
    const filePath = path.join(CACHE_DIR, file);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Tile not found: ${filePath}. Run download first.`);
    }
    console.log(`    ${file}`);
    tiles.push(await loadTile(filePath));
  }

  // Use the resolution of the first tile, applying downsample factor
  const firstTile = tiles[0];
  const tileBbox = firstTile.bbox; // [west, south, east, north]
  const rawResLon =
    (tileBbox[2] - tileBbox[0]) / firstTile.width; // degrees per pixel
  const rawResLat =
    (tileBbox[3] - tileBbox[1]) / firstTile.height;

  const resLon = rawResLon * downsample;
  const resLat = rawResLat * downsample;

  // Compute output grid dimensions for the target bbox
  const outWidth = Math.ceil(
    (targetBbox.east - targetBbox.west) / resLon,
  );
  const outHeight = Math.ceil(
    (targetBbox.north - targetBbox.south) / resLat,
  );

  console.log(`  Output grid: ${outWidth} × ${outHeight} pixels (downsample: ${downsample}x)`);
  console.log(`  Resolution: ~${(resLon * 111000).toFixed(1)}m × ${(resLat * 111000).toFixed(1)}m`);

  // Create output grid filled with NaN (no data)
  const outData = new Float32Array(outWidth * outHeight);
  outData.fill(NaN);

  // Place each tile's data into the output grid.
  // For each output pixel, sample from the source tile at the corresponding location.
  for (const tile of tiles) {
    const tb = tile.bbox; // [west, south, east, north]
    const tileResLon = (tb[2] - tb[0]) / tile.width;
    const tileResLat = (tb[3] - tb[1]) / tile.height;

    for (let outRow = 0; outRow < outHeight; outRow++) {
      for (let outCol = 0; outCol < outWidth; outCol++) {
        // Already filled by a previous tile?
        if (!isNaN(outData[outRow * outWidth + outCol])) continue;

        // Geographic position of this output pixel center
        const lon = targetBbox.west + (outCol + 0.5) * resLon;
        const lat = targetBbox.north - (outRow + 0.5) * resLat;

        // Map to source tile pixel
        const srcCol = Math.floor((lon - tb[0]) / tileResLon);
        const srcRow = Math.floor((tb[3] - lat) / tileResLat);

        if (
          srcCol < 0 || srcCol >= tile.width ||
          srcRow < 0 || srcRow >= tile.height
        ) {
          continue;
        }

        const elevation = tile.data[srcRow * tile.width + srcCol];
        // Skip nodata values (typically very large negative numbers)
        if (elevation > -1000 && elevation < 10000) {
          outData[outRow * outWidth + outCol] = elevation;
        }
      }
    }
  }

  // Convert elevations from meters to feet
  for (let i = 0; i < outData.length; i++) {
    if (!isNaN(outData[i])) {
      outData[i] = metersToFeet(outData[i]);
    }
  }

  // Compute grid extents in feet relative to bbox center
  const [westFeet, southFeet] = latLonToFeet(
    targetBbox.south,
    targetBbox.west,
    centerLat,
    centerLon,
  );
  const [eastFeet, northFeet] = latLonToFeet(
    targetBbox.north,
    targetBbox.east,
    centerLat,
    centerLon,
  );

  const cellWidth = (eastFeet - westFeet) / outWidth;
  // cellHeight is negative because grid row 0 = north, but game Y increases upward
  const cellHeight = (southFeet - northFeet) / outHeight;

  return {
    data: outData,
    width: outWidth,
    height: outHeight,
    originX: westFeet,
    originY: northFeet, // top of grid = north = positive Y
    cellWidth,
    cellHeight,
  };
}

function computePerimeter(points: [number, number][]): number {
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }
  return perimeter;
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("region", {
      type: "string",
      describe: `Region name (${Object.keys(REGIONS).join(", ")})`,
      demandOption: true,
    })
    .option("interval", {
      type: "number",
      describe: "Contour height interval in feet",
      default: 20,
    })
    .option("simplify", {
      type: "number",
      describe: "RDP simplification tolerance in feet",
      default: 50,
    })
    .option("scale", {
      type: "number",
      describe: "Scale factor (real feet per game foot, >1 shrinks)",
      default: 1,
    })
    .option("min-perimeter", {
      type: "number",
      describe: "Minimum contour perimeter in feet",
      default: 500,
    })
    .option("min-points", {
      type: "number",
      describe: "Minimum points per contour after simplification",
      default: 4,
    })
    .option("downsample", {
      type: "number",
      describe: "Downsample factor for source grid (e.g. 10 = use every 10th pixel)",
      default: 10,
    })
    .option("min-height", {
      type: "number",
      describe: "Minimum contour height in feet (skip deeper contours)",
      default: -200,
    })
    .option("max-height", {
      type: "number",
      describe: "Maximum contour height in feet",
    })
    .option("default-depth", {
      type: "number",
      describe: "Deep ocean baseline depth in feet",
      default: -50,
    })
    .option("output", {
      type: "string",
      describe: "Output .terrain.json file path",
      demandOption: true,
    })
    .parse();

  const regionName = argv.region;
  const region = REGIONS[regionName];
  if (!region) {
    console.error(
      `Unknown region "${regionName}". Available: ${Object.keys(REGIONS).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(`Processing region: ${regionName}`);
  console.log(`  Interval: ${argv.interval}ft`);
  console.log(`  Simplify tolerance: ${argv.simplify}ft`);
  console.log(`  Scale: ${argv.scale}`);
  console.log(`  Downsample: ${argv.downsample}x`);
  console.log(`  Min perimeter: ${argv.minPerimeter}ft`);
  console.log(`  Min points: ${argv.minPoints}`);

  // Step 1: Load and merge tiles
  const tileFiles = region.tiles.map((t) => t.filename);
  const grid = await loadAndMergeGrid(tileFiles, region.bbox, argv.downsample);

  // Fill NaN values with a depth below any contour we'd extract
  const fillValue = metersToFeet(-500);
  for (let i = 0; i < grid.data.length; i++) {
    if (isNaN(grid.data[i])) {
      grid.data[i] = fillValue;
    }
  }

  // Step 2: Determine contour heights
  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i];
    if (v > fillValue + 1) {
      // skip fill values
      if (v < minElev) minElev = v;
      if (v > maxElev) maxElev = v;
    }
  }

  console.log(
    `  Elevation range: ${minElev.toFixed(0)}ft to ${maxElev.toFixed(0)}ft`,
  );

  const interval = argv.interval;
  const minHeight = argv.minHeight ?? Math.ceil(minElev / interval) * interval;
  const maxHeight = argv.maxHeight ?? Math.floor(maxElev / interval) * interval;
  const startHeight = Math.max(
    Math.ceil(minElev / interval) * interval,
    Math.ceil(minHeight / interval) * interval,
  );
  const endHeight = Math.min(
    Math.floor(maxElev / interval) * interval,
    Math.floor(maxHeight / interval) * interval,
  );
  const heights: number[] = [];
  for (let h = startHeight; h <= endHeight; h += interval) {
    heights.push(h);
  }

  console.log(
    `  Contour heights: ${heights.length} levels (${startHeight}ft to ${endHeight}ft)`,
  );

  // Step 3: Extract contours at each height
  type Contour = { height: number; controlPoints: [number, number][] };
  const allContours: Contour[] = [];

  for (const height of heights) {
    const rawContours = extractContours(
      grid.data,
      grid.width,
      grid.height,
      height,
      grid.originX,
      grid.originY,
      grid.cellWidth,
      grid.cellHeight,
    );

    for (const points of rawContours) {
      // Step 4: Simplify
      const simplified = simplifyPolygon(points, argv.simplify);

      // Step 5: Filter
      if (simplified.length < argv.minPoints) continue;

      const perimeter = computePerimeter(simplified);
      if (perimeter < argv.minPerimeter) continue;

      allContours.push({ height, controlPoints: simplified });
    }
  }

  console.log(`  Contours after filtering: ${allContours.length}`);

  // Step 6: Apply scale
  const scale = argv.scale;
  if (scale !== 1) {
    for (const contour of allContours) {
      for (const pt of contour.controlPoints) {
        pt[0] /= scale;
        pt[1] /= scale;
      }
    }
    console.log(`  Applied scale factor: ${scale}`);
  }

  // Round control point coordinates to reduce file size
  for (const contour of allContours) {
    for (const pt of contour.controlPoints) {
      pt[0] = Math.round(pt[0]);
      pt[1] = Math.round(pt[1]);
    }
  }

  // Step 7: Build output
  const output = {
    version: 1,
    defaultDepth: argv.defaultDepth,
    contours: allContours.map((c) => ({
      height: c.height,
      controlPoints: c.controlPoints,
    })),
  };

  // Write output
  const outputPath = path.resolve(argv.output);
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  const fileSizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);
  console.log(`\nOutput written to: ${outputPath}`);
  console.log(`  File size: ${fileSizeKB} KB`);
  console.log(`  Contours: ${output.contours.length}`);

  // Summary by height
  const byHeight = new Map<number, number>();
  for (const c of output.contours) {
    byHeight.set(c.height, (byHeight.get(c.height) ?? 0) + 1);
  }
  const sortedHeights = Array.from(byHeight.entries()).sort((a, b) => a[0] - b[0]);
  console.log("  Contours per height:");
  for (const [h, count] of sortedHeights) {
    console.log(`    ${h}ft: ${count}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
