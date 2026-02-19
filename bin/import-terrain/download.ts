#!/usr/bin/env tsx

import { mkdirSync, existsSync, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import path from "path";
import {
  bboxIntersects,
  parseTileCoverageFromName,
  REGION_PRESETS,
  resolveBbox,
} from "./lib/geo-utils";

const BASE_URL =
  "https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/";

interface DownloadArgs {
  region?: string;
  bbox?: string;
  datasetPath?: string;
  outDir: string;
}

function printHelp(): void {
  console.log(`Usage: tsx bin/import-terrain/download.ts [options]

Options:
  --region <name>         Region preset (${Object.keys(REGION_PRESETS).join(", ")})
  --bbox <minLat,minLon,maxLat,maxLon>
                          Custom bbox if region is not provided
  --dataset-path <path>   Dataset subfolder (default from region, else wash_juandefuca/)
  --out-dir <dir>         Cache root directory (default: data/terrain-cache)
  -h, --help              Show help
`);
}

function parseArgs(argv: string[]): DownloadArgs {
  const args: DownloadArgs = { outDir: "data/terrain-cache" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--region") {
      args.region = argv[++i];
    } else if (arg === "--bbox") {
      args.bbox = argv[++i];
    } else if (arg === "--dataset-path") {
      args.datasetPath = argv[++i];
    } else if (arg === "--out-dir") {
      args.outDir = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function normalizeDatasetPath(datasetPath: string): string {
  const normalized = datasetPath.trim().replace(/^\/+/, "");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

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
    throw new Error(`Failed to list dataset directory ${url}: HTTP ${res.status}`);
  }

  const html = await res.text();
  const links = parseDirectoryLinks(html);

  return links
    .filter((href) => /\.tif$/i.test(href))
    .map((href) => new URL(href, url).toString());
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }

  const fileStream = createWriteStream(destinationPath);
  await pipeline(Readable.fromWeb(res.body as any), fileStream);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { bbox, region } = resolveBbox(args.region, args.bbox);

  const datasetPath = normalizeDatasetPath(
    args.datasetPath ?? region?.datasetPath ?? "wash_juandefuca/",
  );

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
      "No matching tiles found for the target bbox. Try a different --dataset-path or broader bbox.",
    );
  }

  const cacheDir = path.resolve(args.outDir, datasetPath.replace(/\/+$/, ""));
  mkdirSync(cacheDir, { recursive: true });

  console.log(`Found ${selectedTiffUrls.length} matching tiles`);

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < selectedTiffUrls.length; i++) {
    const tiffUrl = selectedTiffUrls[i];
    const filename = path.basename(new URL(tiffUrl).pathname);
    const destinationPath = path.join(cacheDir, filename);

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
  console.log(`Cache: ${cacheDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
