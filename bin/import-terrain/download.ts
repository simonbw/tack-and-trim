/**
 * Download CUDEM GeoTIFF topobathy tiles from NOAA for a given region.
 *
 * Usage:
 *   tsx bin/import-terrain/download.ts --region san-juan-islands
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { REGIONS, getTileUrl } from "./lib/geo-utils";

const CACHE_DIR = path.resolve(__dirname, "../../data/terrain-cache");

function downloadFile(url: string, destPath: string): void {
  execFileSync("curl", ["-#", "-L", "-o", destPath, url], {
    stdio: "inherit",
  });
  if (!fs.existsSync(destPath)) {
    throw new Error(`Download failed: ${destPath} not created`);
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option("region", {
      type: "string",
      describe: `Region name (${Object.keys(REGIONS).join(", ")})`,
    })
    .check((argv) => {
      if (!argv.region) {
        throw new Error("--region is required");
      }
      if (!REGIONS[argv.region]) {
        throw new Error(
          `Unknown region "${argv.region}". Available: ${Object.keys(REGIONS).join(", ")}`,
        );
      }
      return true;
    })
    .parse();

  const regionName = argv.region!;
  const region = REGIONS[regionName];

  console.log(`Downloading tiles for region: ${regionName}`);
  console.log(
    `  Bounding box: ${region.bbox.south}°N to ${region.bbox.north}°N, ${Math.abs(region.bbox.west)}°W to ${Math.abs(region.bbox.east)}°W`,
  );
  console.log(`  Tiles: ${region.tiles.length}`);

  // Ensure cache directory exists
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;

  for (const tile of region.tiles) {
    const destPath = path.join(CACHE_DIR, tile.filename);

    if (fs.existsSync(destPath)) {
      console.log(`  [skip] ${tile.filename} (already cached)`);
      skipped++;
      continue;
    }

    const url = getTileUrl(tile);
    console.log(`  [download] ${tile.filename}`);
    console.log(`    from: ${url}`);

    downloadFile(url, destPath);
    downloaded++;
    console.log(`    saved to: ${destPath}`);
  }

  console.log(
    `\nDone. Downloaded: ${downloaded}, Skipped: ${skipped}, Total: ${region.tiles.length}`,
  );
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
