#!/usr/bin/env tsx

import { mkdirSync, existsSync, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import {
  bboxIntersects,
  normalizeDatasetPath,
  parseTileCoverageFromName,
} from "./lib/geo-utils";
import { resolveRegion, loadRegionConfig, tilesDir } from "./lib/region";

const BASE_URL =
  "https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/";

function parseDirectoryLinks(html: string): string[] {
  const links: string[] = [];
  const re = /href="([^"]+)"/gi;
  let match = re.exec(html);

  while (match) {
    const href = match[1];
    if (!href.startsWith("?") && href !== "../") {
      links.push(href);
    }
    match = re.exec(html);
  }

  return links;
}

async function listTiffUrls(datasetPath: string): Promise<string[]> {
  const url = new URL(datasetPath, BASE_URL).toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to list dataset directory ${url}: HTTP ${res.status}`,
    );
  }

  const html = await res.text();
  const links = parseDirectoryLinks(html);

  return links
    .filter((href) => /\.tif$/i.test(href))
    .map((href) => new URL(href, url).toString());
}

async function downloadFile(
  url: string,
  destinationPath: string,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }

  const fileStream = createWriteStream(destinationPath);
  await pipeline(Readable.fromWeb(res.body as any), fileStream);
}

async function main(): Promise<void> {
  const slug = resolveRegion(process.argv.slice(2));
  const config = loadRegionConfig(slug);
  const bbox = config.bbox;
  const datasetPath = normalizeDatasetPath(config.datasetPath);
  const outDir = tilesDir(slug);

  console.log(`Region: ${config.name}`);
  console.log(`Dataset: ${datasetPath}`);
  console.log(
    `BBOX: ${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)} → ${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}`,
  );

  const allTiffUrls = await listTiffUrls(datasetPath);
  if (allTiffUrls.length === 0) {
    throw new Error(`No GeoTIFF files found in dataset path: ${datasetPath}`);
  }

  const selectedTiffUrls = allTiffUrls.filter((tiffUrl) => {
    const filename = path.basename(new URL(tiffUrl).pathname);
    const coverage = parseTileCoverageFromName(filename);
    if (!coverage) {
      return false;
    }
    return bboxIntersects(coverage, bbox);
  });

  if (selectedTiffUrls.length === 0) {
    throw new Error(
      "No matching tiles found for the target bbox. Check the datasetPath in region.json.",
    );
  }

  mkdirSync(outDir, { recursive: true });

  console.log(`Found ${selectedTiffUrls.length} matching tiles`);

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < selectedTiffUrls.length; i++) {
    const tiffUrl = selectedTiffUrls[i];
    const filename = path.basename(new URL(tiffUrl).pathname);
    const destinationPath = path.join(outDir, filename);

    if (existsSync(destinationPath)) {
      skipped++;
      console.log(`[${i + 1}/${selectedTiffUrls.length}] skip ${filename}`);
      continue;
    }

    console.log(`[${i + 1}/${selectedTiffUrls.length}] download ${filename}`);
    await downloadFile(tiffUrl, destinationPath);
    downloaded++;
  }

  console.log(`Done. Downloaded: ${downloaded}, skipped: ${skipped}`);
  console.log(`Tiles: ${outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
