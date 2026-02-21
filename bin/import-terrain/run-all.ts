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
];

for (const step of steps) {
  const scriptPath = path.join(binDir, step.script);
  console.log(`\n=== ${step.name} ===\n`);
  execSync(`tsx ${scriptPath} --region ${slug}`, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

console.log("\nDone.");
