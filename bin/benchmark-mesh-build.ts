#!/usr/bin/env tsx
/**
 * CLI benchmark for wavefront mesh builders.
 *
 * Usage:
 *   npx tsx bin/benchmark-mesh-build.ts              # 5 iterations, all builders
 *   npx tsx bin/benchmark-mesh-build.ts -n 10
 *   npx tsx bin/benchmark-mesh-build.ts -b cpu-lagrangian   # single builder
 *   npx tsx bin/benchmark-mesh-build.ts -w 1         # benchmark second wave source
 *
 * Loads the default level terrain data and runs each builder on the main thread,
 * reporting timing statistics.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseLevelFile,
  levelFileToTerrainDefinition,
  levelFileToWaveConfig,
} from "../src/editor/io/LevelFileFormat";
import {
  buildTerrainGPUData,
  normalizeTerrainWinding,
} from "../src/game/world/terrain/LandMass";
import { buildCpuLagrangianMesh } from "../src/game/wave-physics/mesh-building/builders/cpu-lagrangian";
import type {
  MeshBuildBounds,
  MeshBuilderType,
  TerrainDataForWorker,
  WavefrontMeshData,
} from "../src/game/wave-physics/mesh-building/MeshBuildTypes";
import type { WaveSource } from "../src/game/world/water/WaveSource";

// ---------------------------------------------------------------------------
// Builder registry
// ---------------------------------------------------------------------------

type BuilderFn = (
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainDataForWorker,
  tideHeight: number,
) => WavefrontMeshData;

const builders: Record<MeshBuilderType, BuilderFn> = {
  "cpu-lagrangian": buildCpuLagrangianMesh,
};

const allBuilderTypes: MeshBuilderType[] = ["cpu-lagrangian"];

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let iterations = 5;
let waveIndex = 0;
let levelPath = path.resolve(
  __dirname,
  "../resources/levels/default.level.json",
);
let selectedBuilders: MeshBuilderType[] | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--iterations" || args[i] === "-n") {
    iterations = parseInt(args[++i], 10);
  } else if (args[i] === "--wave" || args[i] === "-w") {
    waveIndex = parseInt(args[++i], 10);
  } else if (args[i] === "--level" || args[i] === "-l") {
    levelPath = path.resolve(args[++i]);
  } else if (args[i] === "--builder" || args[i] === "-b") {
    const name = args[++i] as MeshBuilderType;
    if (!builders[name]) {
      console.error(
        `Unknown builder: ${name}. Available: ${allBuilderTypes.join(", ")}`,
      );
      process.exit(1);
    }
    if (!selectedBuilders) selectedBuilders = [];
    selectedBuilders.push(name);
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: npx tsx bin/benchmark-mesh-build.ts [options]

Options:
  -n, --iterations <N>     Number of iterations (default: 5)
  -w, --wave <index>       Wave source index to benchmark (default: 0)
  -b, --builder <name>     Builder to benchmark (repeatable; default: all)
                           Options: ${allBuilderTypes.join(", ")}
  -l, --level <path>       Level file path (default: resources/levels/default.level.json)
  -h, --help               Show this help
`);
    process.exit(0);
  }
}

const builderTypes = selectedBuilders ?? allBuilderTypes;

// ---------------------------------------------------------------------------
// Load level data
// ---------------------------------------------------------------------------

console.log(`Loading level: ${levelPath}`);
const levelJson = fs.readFileSync(levelPath, "utf-8");
const levelFile = parseLevelFile(levelJson);
const terrainDef = normalizeTerrainWinding(
  levelFileToTerrainDefinition(levelFile),
);
const waveConfig = levelFileToWaveConfig(levelFile);

if (waveIndex >= waveConfig.sources.length) {
  console.error(
    `Wave index ${waveIndex} out of range (${waveConfig.sources.length} sources available)`,
  );
  process.exit(1);
}

const waveSource = waveConfig.sources[waveIndex];

// Build terrain GPU data (same as what the game does)
const terrainGPUData = buildTerrainGPUData(terrainDef);

const terrain: TerrainDataForWorker = {
  vertexData: terrainGPUData.vertexData,
  contourData: terrainGPUData.contourData,
  childrenData: terrainGPUData.childrenData,
  contourCount: terrainGPUData.contourCount,
  defaultDepth: terrainDef.defaultDepth ?? terrainGPUData.defaultDepth,
};

const tideHeight = 0;

// Compute coastline bounds (same logic as CoastlineManager)
let bounds: MeshBuildBounds | null = null;
for (const contour of terrainDef.contours) {
  if (contour.height === 0) {
    for (const pt of contour.sampledPolygon) {
      if (!bounds) {
        bounds = { minX: pt.x, maxX: pt.x, minY: pt.y, maxY: pt.y };
      } else {
        bounds.minX = Math.min(bounds.minX, pt.x);
        bounds.maxX = Math.max(bounds.maxX, pt.x);
        bounds.minY = Math.min(bounds.minY, pt.y);
        bounds.maxY = Math.max(bounds.maxY, pt.y);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Print setup
// ---------------------------------------------------------------------------

console.log(
  `\nWave ${waveIndex}: λ=${waveSource.wavelength}ft, ` +
    `dir=${((waveSource.direction * 180) / Math.PI).toFixed(1)}°, ` +
    `amp=${waveSource.amplitude}ft`,
);
console.log(
  `Terrain: ${terrain.contourCount} contours, ` +
    `${terrain.vertexData.length / 2} vertices`,
);
if (bounds) {
  console.log(
    `Bounds: [${bounds.minX.toFixed(0)}, ${bounds.minY.toFixed(0)}] → ` +
      `[${bounds.maxX.toFixed(0)}, ${bounds.maxY.toFixed(0)}]`,
  );
}
console.log(
  `Builders: ${builderTypes.join(", ")}  (${iterations} iterations each)\n`,
);

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

// Suppress console.log from builders during benchmarking
const originalLog = console.log;
const originalWarn = console.warn;

for (const builderType of builderTypes) {
  const buildFn = builders[builderType];
  const timesMs: number[] = [];
  let lastVertexCount = 0;
  let lastIndexCount = 0;

  originalLog(`${builderType}`);

  for (let i = 0; i < iterations; i++) {
    console.log = () => {};
    console.warn = () => {};

    const start = performance.now();
    const result = buildFn(waveSource, bounds, terrain, tideHeight);
    const elapsed = performance.now() - start;

    console.log = originalLog;
    console.warn = originalWarn;

    timesMs.push(elapsed);
    lastVertexCount = result.vertexCount;
    lastIndexCount = result.indexCount;

    process.stdout.write(`  Run ${i + 1}: ${elapsed.toFixed(1)}ms\n`);
  }

  const sorted = [...timesMs].sort((a, b) => a - b);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  const medianMs = sorted[Math.floor(sorted.length / 2)];
  const meanMs = timesMs.reduce((a, b) => a + b, 0) / timesMs.length;

  console.log(
    `  => min=${minMs.toFixed(1)}  median=${medianMs.toFixed(1)}  ` +
      `mean=${meanMs.toFixed(1)}  max=${maxMs.toFixed(1)}ms`,
  );
  console.log(
    `     ${lastVertexCount.toLocaleString()} vertices, ` +
      `${(lastIndexCount / 3).toLocaleString()} triangles\n`,
  );
}
