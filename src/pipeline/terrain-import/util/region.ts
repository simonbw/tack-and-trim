import { readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import type { BoundingBox } from "./geo-utils";

export interface RegionConfig {
  name: string;
  datasetPath: string;
  bbox: BoundingBox;
  interval: number;
  simplify: number;
  scale: number;
  minPerimeter: number;
  minPoints: number;
  flipY: boolean;
  output: string;
}

const ASSETS_ROOT = path.resolve(__dirname, "../../../../assets/terrain");

export function regionDir(slug: string): string {
  return path.join(ASSETS_ROOT, slug);
}

export function tilesDir(slug: string): string {
  return path.join(ASSETS_ROOT, slug, "tiles");
}

export function gridCacheDir(slug: string): string {
  return path.join(ASSETS_ROOT, slug, "cache");
}

export function loadRegionConfig(slug: string): RegionConfig {
  const configPath = path.join(regionDir(slug), "region.json");
  if (!existsSync(configPath)) {
    throw new Error(`No region.json found at ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

export function listRegions(): string[] {
  if (!existsSync(ASSETS_ROOT)) {
    return [];
  }
  return readdirSync(ASSETS_ROOT, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(path.join(ASSETS_ROOT, entry.name, "region.json")),
    )
    .map((entry) => entry.name)
    .sort();
}

async function promptForRegion(regions: string[]): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Multiple regions available. Specify --region <name>: ${regions.join(", ")}`,
    );
  }

  console.log("Available regions:");
  for (let i = 0; i < regions.length; i++) {
    console.log(`  ${i + 1}. ${regions[i]}`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      const answer = (
        await rl.question(`Select a region [1-${regions.length}] or name: `)
      ).trim();

      if (answer.length === 0) {
        continue;
      }

      const byIndex = Number.parseInt(answer, 10);
      if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= regions.length) {
        return regions[byIndex - 1];
      }

      if (regions.includes(answer)) {
        return answer;
      }

      console.log(
        `Invalid selection "${answer}". Choose 1-${regions.length} or one of: ${regions.join(", ")}`,
      );
    }
  } finally {
    rl.close();
  }
}

export async function resolveRegion(argv: string[]): Promise<string> {
  let slug: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--region") {
      slug = argv[++i];
    } else if (argv[i] === "-h" || argv[i] === "--help") {
      const regions = listRegions();
      console.log(`Usage: <script> --region <name>

Available regions: ${regions.length > 0 ? regions.join(", ") : "(none)"}

Region configs are stored in assets/terrain/<name>/region.json`);
      process.exit(0);
    }
  }

  if (slug) {
    const dir = regionDir(slug);
    if (!existsSync(path.join(dir, "region.json"))) {
      throw new Error(
        `Unknown region "${slug}". Available: ${listRegions().join(", ")}`,
      );
    }
    return slug;
  }

  const regions = listRegions();
  if (regions.length === 1) {
    console.log(`Auto-selected region: ${regions[0]}`);
    return regions[0];
  }

  if (regions.length === 0) {
    throw new Error(
      "No regions found. Create assets/terrain/<name>/region.json first.",
    );
  }

  return promptForRegion(regions);
}
