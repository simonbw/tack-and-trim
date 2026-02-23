#!/usr/bin/env tsx

import { execSync } from "child_process";
import path from "path";
import { resolveRegion } from "./lib/region";

const slug = resolveRegion(process.argv.slice(2));
const binDir = __dirname;

const steps = [
  { name: "download", script: "download.ts" },
  { name: "build-grid", script: "build-grid.ts" },
  { name: "extract-contours", script: "extract-contours.ts" },
  { name: "build-wavemesh", script: "../build-wavemesh.ts", noRegionArg: true },
];

for (const step of steps) {
  const scriptPath = path.join(binDir, step.script);
  console.log(`\n=== ${step.name} ===\n`);
  const regionArg =
    "noRegionArg" in step && step.noRegionArg ? "" : ` --region ${slug}`;
  execSync(`tsx ${scriptPath}${regionArg}`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

console.log("\nDone.");
