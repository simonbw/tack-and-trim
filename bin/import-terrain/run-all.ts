#!/usr/bin/env tsx

import { execSync } from "child_process";
import path from "path";
import { loadRegionConfig, resolveRegion } from "./lib/region";

const slug = resolveRegion(process.argv.slice(2));
const regionConfig = loadRegionConfig(slug);
const binDir = __dirname;
const levelPath = path.resolve(regionConfig.output);

const steps = [
  { name: "download", script: "download.ts" },
  { name: "build-grid", script: "build-grid.ts" },
  { name: "extract-contours", script: "extract-contours.ts" },
  {
    name: "build-wavemesh",
    script: "../build-wavemesh.ts",
    args: `--level ${levelPath}`,
  },
];

for (const step of steps) {
  const scriptPath = path.join(binDir, step.script);
  console.log(`\n=== ${step.name} ===\n`);
  const args = "args" in step ? ` ${step.args}` : ` --region ${slug}`;
  execSync(`tsx ${scriptPath}${args}`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

console.log("\nDone.");
