#!/usr/bin/env tsx

import { mkdirSync, existsSync, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import {
  bboxIntersects,
  normalizeDatasetPath,
  parseTileCoverageFromName,
  type BoundingBox,
} from "./util/geo-utils";
import {
  resolveRegion,
  loadRegionConfig,
  tilesDir,
  resolveDataSource,
  type DataSourceConfig,
} from "./util/region";

const CUDEM_BASE_URL =
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

async function downloadTiles(
  tiffUrls: string[],
  outDir: string,
): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  console.log(`Found ${tiffUrls.length} matching tiles`);

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < tiffUrls.length; i++) {
    const tiffUrl = tiffUrls[i];
    const filename = path.basename(new URL(tiffUrl).pathname);
    const destinationPath = path.join(outDir, filename);

    if (existsSync(destinationPath)) {
      skipped++;
      console.log(`[${i + 1}/${tiffUrls.length}] skip ${filename}`);
      continue;
    }

    console.log(`[${i + 1}/${tiffUrls.length}] download ${filename}`);
    await downloadFile(tiffUrl, destinationPath);
    downloaded++;
  }

  console.log(`Done. Downloaded: ${downloaded}, skipped: ${skipped}`);
  console.log(`Tiles: ${outDir}`);
}

// --- CUDEM (NOAA ocean coastline tiles) ---

async function listCudemTiffUrls(datasetPath: string): Promise<string[]> {
  const url = new URL(datasetPath, CUDEM_BASE_URL).toString();
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

async function downloadCudem(
  source: Extract<DataSourceConfig, { type: "cudem" }>,
  bbox: BoundingBox,
  outDir: string,
): Promise<void> {
  const datasetPath = normalizeDatasetPath(source.datasetPath);
  console.log(`Dataset: ${datasetPath}`);

  const allTiffUrls = await listCudemTiffUrls(datasetPath);
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

  await downloadTiles(selectedTiffUrls, outDir);
}

// --- USACE S3 (e.g. Lake Superior DEM) ---

async function downloadUsaceS3(
  source: Extract<DataSourceConfig, { type: "usace-s3" }>,
  _bbox: BoundingBox,
  outDir: string,
): Promise<void> {
  const urlListUrl = new URL(source.urlList, source.baseUrl).toString();
  console.log(`Fetching URL list: ${urlListUrl}`);

  const res = await fetch(urlListUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch URL list ${urlListUrl}: HTTP ${res.status}`,
    );
  }

  const text = await res.text();
  const allUrls = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const tifUrls = allUrls.filter(
    (url) => /\.tif$/i.test(url) && url.includes(`/${source.statePrefix}`),
  );

  if (tifUrls.length === 0) {
    throw new Error(
      `No .tif files found matching prefix "${source.statePrefix}" in URL list`,
    );
  }

  console.log(
    `Found ${tifUrls.length} tiles for prefix "${source.statePrefix}" (from ${allUrls.length} total entries)`,
  );

  await downloadTiles(tifUrls, outDir);
}

// --- EMODnet WCS (European bathymetry) ---

const EMODNET_WCS_BASE = "https://ows.emodnet-bathymetry.eu/wcs";

async function downloadEmodnetWcs(
  source: Extract<DataSourceConfig, { type: "emodnet-wcs" }>,
  bbox: BoundingBox,
  outDir: string,
): Promise<void> {
  const filename = `${source.coverageId}.tif`;
  const destinationPath = path.join(outDir, filename);

  mkdirSync(outDir, { recursive: true });

  if (existsSync(destinationPath)) {
    console.log(`Already downloaded: ${filename}`);
    console.log(`Tiles: ${outDir}`);
    return;
  }

  const params = new URLSearchParams({
    SERVICE: "WCS",
    VERSION: "2.0.1",
    REQUEST: "GetCoverage",
    COVERAGEID: source.coverageId,
    FORMAT: "image/tiff",
  });
  const url =
    `${EMODNET_WCS_BASE}?${params}` +
    `&SUBSET=Lat(${bbox.minLat},${bbox.maxLat})` +
    `&SUBSET=Long(${bbox.minLon},${bbox.maxLon})`;

  console.log(`Requesting WCS coverage: ${source.coverageId}`);
  await downloadFile(url, destinationPath);
  console.log(`Downloaded: ${filename}`);
  console.log(`Tiles: ${outDir}`);
}

// --- Main ---

async function main(): Promise<void> {
  const slug = await resolveRegion(process.argv.slice(2));
  const config = loadRegionConfig(slug);
  const bbox = config.bbox;
  const source = resolveDataSource(config);
  const outDir = tilesDir(slug);

  console.log(`Region: ${config.name}`);
  console.log(
    `BBOX: ${bbox.minLat.toFixed(4)},${bbox.minLon.toFixed(4)} → ${bbox.maxLat.toFixed(4)},${bbox.maxLon.toFixed(4)}`,
  );

  switch (source.type) {
    case "cudem":
      await downloadCudem(source, bbox, outDir);
      break;
    case "usace-s3":
      await downloadUsaceS3(source, bbox, outDir);
      break;
    case "emodnet-wcs":
      await downloadEmodnetWcs(source, bbox, outDir);
      break;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
