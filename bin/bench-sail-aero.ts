#!/usr/bin/env tsx
/**
 * Microbenchmark for sail-aerodynamics.
 *
 * Measures the per-frame cost of running computeClothWindForce() over the
 * full triangle list of a sail mesh, for a range of mesh sizes. Pure
 * Node/tsx — no browser, no game loop, no cloth-solver step. Useful for
 * iterating on the aero kernel itself.
 *
 * Run:  npm run bench-sail-aero
 * Or:   tsx bin/bench-sail-aero.ts
 *
 * Optional flags:
 *   --runs=<N>      number of timed iterations per mesh   (default: 1000)
 *   --warmup=<N>    number of un-timed warmup iterations  (default: 200)
 *   --cols=<N>      override mesh columns (single run)
 *   --rows=<N>      override mesh rows    (single run)
 *
 * Each iteration loops over every triangle once — i.e., one tick's worth of
 * aero work. Results are reported as wall-clock per iteration plus
 * nanoseconds per triangle.
 */

import { performance } from "node:perf_hooks";
import { ClothSolver } from "../src/game/boat/sail/ClothSolver";
import {
  generateSailMesh,
  type SailMeshData,
} from "../src/game/boat/sail/SailMesh";
import { computeClothWindForce } from "../src/game/boat/sail/sail-aerodynamics";

interface MeshPreset {
  label: string;
  cols: number;
  rows: number;
}

const DEFAULT_PRESETS: MeshPreset[] = [
  { label: "small  (16x8)", cols: 16, rows: 8 },
  { label: "default (32x16)", cols: 32, rows: 16 },
  { label: "large  (48x24)", cols: 48, rows: 24 },
  { label: "xlarge (64x32)", cols: 64, rows: 32 },
];

interface Options {
  runs: number;
  warmup: number;
  presets: MeshPreset[];
}

function parseArgs(argv: string[]): Options {
  let runs = 1000;
  let warmup = 200;
  let cols: number | null = null;
  let rows: number | null = null;
  for (const arg of argv) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    switch (key) {
      case "runs":
        runs = parseInt(val, 10);
        break;
      case "warmup":
        warmup = parseInt(val, 10);
        break;
      case "cols":
        cols = parseInt(val, 10);
        break;
      case "rows":
        rows = parseInt(val, 10);
        break;
    }
  }
  const presets =
    cols !== null && rows !== null
      ? [{ label: `custom (${cols}x${rows})`, cols, rows }]
      : DEFAULT_PRESETS;
  return { runs, warmup, presets };
}

function buildSolver(
  cols: number,
  rows: number,
): {
  solver: ClothSolver;
  mesh: SailMeshData;
} {
  const mesh = generateSailMesh({
    footColumns: cols,
    luffRows: rows,
    taperFactor: 1.0,
    zFoot: 3,
    zHead: 20,
  });
  const solver = new ClothSolver(mesh, {
    damping: 1.0,
    constraintIterations: 10,
    bendStiffness: 0.3,
    constraintDamping: 0.1,
  });

  // Initialize with a slightly billowed sail shape so triangle normals are
  // realistic (non-degenerate, varied). Foot 12 ft, gentle camber.
  const wx = new Float64Array(mesh.vertexCount);
  const wy = new Float64Array(mesh.vertexCount);
  const wz = new Float64Array(mesh.vertexCount);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const u = mesh.restPositions[i * 2];
    const v = mesh.restPositions[i * 2 + 1];
    const z = mesh.zHeights[i];
    wx[i] = u * 12;
    wy[i] = 1.5 * Math.sin(Math.PI * u) * (1 - v * 0.5);
    wz[i] = z;
  }
  solver.initializePositions(wx, wy, wz);

  return { solver, mesh };
}

function quantile(sorted: number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[idx];
}

function runBench(label: string, cols: number, rows: number, opts: Options) {
  const { solver, mesh } = buildSolver(cols, rows);
  const triCount = mesh.indices.length / 3;
  const indices = mesh.indices;

  // Apparent wind sample matching what Sail.ts produces in flight: mostly
  // horizontal with a small vertical component from heave / heel.
  const windX = 7.5;
  const windY = 4.0;
  const windZ = 0.3;

  // Sink force outputs into accumulators to defeat dead-code elimination.
  let totalFx = 0;
  let totalFy = 0;
  let totalFz = 0;

  // Warmup
  for (let r = 0; r < opts.warmup; r++) {
    for (let t = 0; t < indices.length; t += 3) {
      const [fx, fy, fz] = computeClothWindForce(
        solver,
        indices[t],
        indices[t + 1],
        indices[t + 2],
        windX,
        windY,
        windZ,
        1.0,
        1.0,
      );
      totalFx += fx;
      totalFy += fy;
      totalFz += fz;
    }
  }

  // Timed runs
  const samples = new Float64Array(opts.runs);
  for (let r = 0; r < opts.runs; r++) {
    const t0 = performance.now();
    for (let t = 0; t < indices.length; t += 3) {
      const [fx, fy, fz] = computeClothWindForce(
        solver,
        indices[t],
        indices[t + 1],
        indices[t + 2],
        windX,
        windY,
        windZ,
        1.0,
        1.0,
      );
      totalFx += fx;
      totalFy += fy;
      totalFz += fz;
    }
    samples[r] = performance.now() - t0;
  }

  const sorted = Array.from(samples).sort((a, b) => a - b);
  const min = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const p99 = quantile(sorted, 0.99);
  const max = sorted[sorted.length - 1];
  const nsPerTri = (median * 1_000_000) / triCount;

  const trisFmt = triCount.toString().padStart(5);
  console.log(
    `  ${label.padEnd(18)}  ${trisFmt} tris  ` +
      `median ${median.toFixed(3)}ms  ` +
      `min ${min.toFixed(3)}ms  ` +
      `p99 ${p99.toFixed(3)}ms  ` +
      `max ${max.toFixed(3)}ms  ` +
      `(${nsPerTri.toFixed(0)} ns/tri)`,
  );

  return totalFx + totalFy + totalFz;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log("Sail aerodynamics microbenchmark");
  console.log("================================");
  console.log(`Node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(`Warmup: ${opts.warmup} iters,  Timed: ${opts.runs} iters`);
  console.log("");
  console.log(
    "Per-tick cost of computeClothWindForce over the full triangle list",
  );
  console.log(
    "(one row = one sail mesh, one iteration = one tick of aero work):",
  );
  console.log("");

  let checksum = 0;
  for (const p of opts.presets) {
    checksum += runBench(p.label, p.cols, p.rows, opts);
  }

  // Force the accumulator to be observed (defeat DCE).
  console.log("");
  console.log(`(force checksum: ${checksum.toExponential(3)})`);
}

main();
