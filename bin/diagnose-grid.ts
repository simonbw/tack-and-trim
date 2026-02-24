#!/usr/bin/env tsx
/**
 * Examine grid data around the crossing points to understand why
 * 0ft and 200ft contours intersect.
 */
import { fromFile } from "geotiff";
import path from "path";
import { readFileSync } from "fs";

const METERS_TO_FEET = 3.28084;
const EARTH_RADIUS_FT = 20_902_231;

async function main() {
  // Load the level file to get crossing contour vertices
  const levelPath =
    "/Users/simon/projects/tack-and-trim/assets/terrain/san-juan-islands/san-juan-islands.level.json";
  const data = JSON.parse(readFileSync(levelPath, "utf-8"));
  const contours = data.contours;

  // Load region config
  const regionPath =
    "/Users/simon/projects/tack-and-trim/assets/terrain/san-juan-islands/region.json";
  const config = JSON.parse(readFileSync(regionPath, "utf-8"));
  const bbox = config.bbox;
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLon = (bbox.minLon + bbox.maxLon) / 2;

  // Load the merged grid
  const mergedPath =
    "/Users/simon/projects/tack-and-trim/assets/terrain/san-juan-islands/cache/merged.tif";
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
  })) as Float32Array;

  console.log(`Grid: ${width}x${height}`);
  console.log(`BBox: lon ${minLon} to ${maxLon}, lat ${minLat} to ${maxLat}`);
  console.log(`Steps: lonStep=${lonStep}, latStep=${latStep}`);
  console.log(`NoData value: ${noDataValue}`);

  // Convert feet coords back to grid coords
  function feetToGrid(
    xFeet: number,
    yFeet: number,
  ): { gx: number; gy: number; lat: number; lon: number } {
    // With flipY=true: yFeet = -(latToFeet(lat - centerLat))
    // So lat = centerLat + yFeet_raw / EARTH_RADIUS_FT * (180/PI)
    // But flipY means yFeet = -yRaw, so yRaw = -yFeet
    const yRaw = -yFeet;
    const lat = centerLat + (yRaw / EARTH_RADIUS_FT) * (180 / Math.PI);
    const cosLat = Math.cos((((lat + centerLat) / 2) * Math.PI) / 180);
    const lon =
      centerLon + (xFeet / (EARTH_RADIUS_FT * cosLat)) * (180 / Math.PI);

    const gx = (lon - minLon) / lonStep;
    const gy = (maxLat - lat) / latStep;
    return { gx, gy, lat, lon };
  }

  function getElevFt(x: number, y: number): { ft: number; isNodata: boolean } {
    if (x < 0 || x >= width || y < 0 || y >= height)
      return { ft: NaN, isNodata: true };
    const v = Number(raster[y * width + x]);
    const isNodata =
      !Number.isFinite(v) ||
      (noDataValue !== null && Math.abs(v - noDataValue) < 1e-6);
    return { ft: isNodata ? -200 : v * METERS_TO_FEET, isNodata };
  }

  // Examine the crossing area
  const crossingPt = { xFeet: 60257, yFeet: -38162 };
  const { gx, gy, lat, lon } = feetToGrid(crossingPt.xFeet, crossingPt.yFeet);
  console.log(
    `\nCrossing point (${crossingPt.xFeet}, ${crossingPt.yFeet})ft → grid (${gx.toFixed(1)}, ${gy.toFixed(1)}), lat/lon (${lat.toFixed(5)}, ${lon.toFixed(5)})`,
  );

  // Show grid data in the area
  const cx = Math.round(gx);
  const cy = Math.round(gy);
  const radius = 5;
  console.log(
    `\nGrid data around (${cx}, ${cy}) [values in feet, * = nodata]:`,
  );

  // Print header
  let header = "     ";
  for (let x = cx - radius; x <= cx + radius; x++) {
    header += `  ${x.toString().padStart(6)}`;
  }
  console.log(header);

  for (let y = cy - radius; y <= cy + radius; y++) {
    let row = `${y.toString().padStart(5)}`;
    for (let x = cx - radius; x <= cx + radius; x++) {
      const { ft, isNodata } = getElevFt(x, y);
      if (isNodata) {
        row += "       *";
      } else {
        row += `  ${ft.toFixed(0).padStart(6)}`;
      }
    }
    console.log(row);
  }

  // Check for cells near the crossing that are saddle points between 0 and 200ft
  console.log(
    `\nCells near crossing that have saddle values between 0 and 200ft:`,
  );
  for (let y = cy - 10; y <= cy + 10; y++) {
    for (let x = cx - 10; x <= cx + 10; x++) {
      const tl = getElevFt(x, y);
      const tr = getElevFt(x + 1, y);
      const bl = getElevFt(x, y + 1);
      const br = getElevFt(x + 1, y + 1);

      if (tl.isNodata || tr.isNodata || bl.isNodata || br.isNodata) continue;

      const vTL = tl.ft,
        vTR = tr.ft,
        vBL = bl.ft,
        vBR = br.ft;

      // Check if this cell has a crossing at both 0ft and 200ft
      const mask0 =
        (vTL >= 0 ? 8 : 0) |
        (vTR >= 0 ? 4 : 0) |
        (vBR >= 0 ? 2 : 0) |
        (vBL >= 0 ? 1 : 0);
      const mask200 =
        (vTL >= 200 ? 8 : 0) |
        (vTR >= 200 ? 4 : 0) |
        (vBR >= 200 ? 2 : 0) |
        (vBL >= 200 ? 1 : 0);

      if (mask0 === 0 || mask0 === 15) continue; // no 0ft crossing
      if (mask200 === 0 || mask200 === 15) continue; // no 200ft crossing

      // Both levels cross this cell. Check for saddle (mask 5 or 10)
      const isSaddle0 = mask0 === 5 || mask0 === 10;
      const isSaddle200 = mask200 === 5 || mask200 === 10;

      if (isSaddle0 || isSaddle200) {
        const denom = vTL - vTR + vBR - vBL;
        const cv =
          Math.abs(denom) < 1e-12
            ? (vTL + vTR + vBR + vBL) * 0.25
            : (vTL * vBR - vTR * vBL) / denom;
        if (cv >= 0 && cv < 200) {
          console.log(
            `  Cell (${x},${y}): TL=${vTL.toFixed(0)} TR=${vTR.toFixed(0)} BL=${vBL.toFixed(0)} BR=${vBR.toFixed(0)} | mask0=${mask0} mask200=${mask200} cv=${cv.toFixed(1)} | DIFFERENT SADDLE RESOLUTION`,
          );
        }
      }
    }
  }

  // Now look at the actual contour vertices near the crossing to see where they cross
  console.log(
    `\nContour 6 (0ft) vertices near crossing (60000-63000, -38500 to -36500):`,
  );
  const c6 = contours[6]; // now index 6 instead of 8
  let count = 0;
  for (let i = 0; i < c6.polygon.length && count < 30; i++) {
    const [x, y] = c6.polygon[i];
    if (x >= 60000 && x <= 63000 && y >= -38500 && y <= -36500) {
      console.log(`  [${i}] (${x.toFixed(1)}, ${y.toFixed(1)})`);
      count++;
    }
  }

  console.log(`\nContour 534 (200ft) vertices near crossing:`);
  const c534 = contours[534];
  count = 0;
  for (let i = 0; i < c534.polygon.length && count < 30; i++) {
    const [x, y] = c534.polygon[i];
    if (x >= 60000 && x <= 63000 && y >= -38500 && y <= -36500) {
      console.log(`  [${i}] (${x.toFixed(1)}, ${y.toFixed(1)})`);
      count++;
    }
  }

  // Check how many near-duplicate 200ft contours there are
  console.log(`\n200ft contour similarity analysis:`);
  const h200 = contours.filter((c: any) => c.height === 200);
  console.log(`Total 200ft contours: ${h200.length}`);

  // Find clusters of similar 200ft contours
  for (let i = 0; i < h200.length; i++) {
    const ci = h200[i];
    for (let j = i + 1; j < h200.length; j++) {
      const cj = h200[j];
      // Compare first points
      const dx = ci.polygon[0][0] - cj.polygon[0][0];
      const dy = ci.polygon[0][1] - cj.polygon[0][1];
      if (
        Math.abs(ci.polygon.length - cj.polygon.length) < 20 &&
        Math.hypot(dx, dy) < 200
      ) {
        const ciIdx = contours.indexOf(ci);
        const cjIdx = contours.indexOf(cj);
        console.log(
          `  Near-duplicate: contour ${ciIdx} (${ci.polygon.length} pts) and ${cjIdx} (${cj.polygon.length} pts), first pts distance ${Math.hypot(dx, dy).toFixed(0)}ft`,
        );
      }
    }
  }
}

main().catch(console.error);
