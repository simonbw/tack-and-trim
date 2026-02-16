#!/usr/bin/env tsx
/**
 * CLI benchmark for wavefront mesh builders.
 *
 * Usage:
 *   npx tsx bin/benchmark-mesh-build.ts              # 1 iteration, all builders
 *   npx tsx bin/benchmark-mesh-build.ts -n 10
 *   npx tsx bin/benchmark-mesh-build.ts -b marching         # single builder
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
import {
  buildMarchingMesh,
  type MeshBuildProfile,
} from "../src/game/wave-physics/mesh-building/marchingBuilder";
import type { TerrainCPUData } from "../src/game/world/terrain/TerrainCPUData";
import type {
  MeshBuildBounds,
  MeshBuilderType,
  WavefrontMeshData,
} from "../src/game/wave-physics/mesh-building/MeshBuildTypes";
import type { WaveSource } from "../src/game/world/water/WaveSource";

// ---------------------------------------------------------------------------
// Builder registry
// ---------------------------------------------------------------------------

type BuilderFn = (
  waveSource: WaveSource,
  coastlineBounds: MeshBuildBounds | null,
  terrain: TerrainCPUData,
  tideHeight: number,
  profile?: MeshBuildProfile,
) => WavefrontMeshData;

const builders: Record<MeshBuilderType, BuilderFn> = {
  marching: buildMarchingMesh,
};

const allBuilderTypes: MeshBuilderType[] = ["marching"];

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let iterations = 1;
let selectedWaveIndex: number | null = null;
let levelPath = path.resolve(
  __dirname,
  "../resources/levels/default.level.json",
);
let selectedBuilders: MeshBuilderType[] | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--iterations" || args[i] === "-n") {
    iterations = parseInt(args[++i], 10);
  } else if (args[i] === "--wave" || args[i] === "-w") {
    selectedWaveIndex = parseInt(args[++i], 10);
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
  -n, --iterations <N>     Number of iterations (default: 1)
  -w, --wave <index>       Wave source index to benchmark (default: all)
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

if (
  selectedWaveIndex !== null &&
  (selectedWaveIndex < 0 || selectedWaveIndex >= waveConfig.sources.length)
) {
  console.error(
    `Wave index ${selectedWaveIndex} out of range (${waveConfig.sources.length} sources available)`,
  );
  process.exit(1);
}
const waveIndices =
  selectedWaveIndex === null
    ? waveConfig.sources.map((_, i) => i)
    : [selectedWaveIndex];

// Build terrain GPU data (same as what the game does)
const terrainGPUData = buildTerrainGPUData(terrainDef);

const terrain: TerrainCPUData = {
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
  `\nTerrain: ${terrain.contourCount} contours, ` +
    `${terrain.vertexData.length / 2} vertices`,
);
if (bounds) {
  console.log(
    `Bounds: [${bounds.minX.toFixed(0)}, ${bounds.minY.toFixed(0)}] → ` +
      `[${bounds.maxX.toFixed(0)}, ${bounds.maxY.toFixed(0)}]`,
  );
}
console.log(
  `Builders: ${builderTypes.join(", ")}  (${iterations} iterations each)`,
);
console.log(
  `Waves: ${
    selectedWaveIndex === null
      ? `${waveIndices.length} (all)`
      : `${selectedWaveIndex}`
  }\n`,
);

// ---------------------------------------------------------------------------
// Run benchmarks
// ---------------------------------------------------------------------------

for (const waveIndex of waveIndices) {
  const waveSource = waveConfig.sources[waveIndex];
  console.log(
    `Wave ${waveIndex}: λ=${waveSource.wavelength}ft, ` +
      `dir=${((waveSource.direction * 180) / Math.PI).toFixed(1)}°, ` +
      `amp=${waveSource.amplitude}ft`,
  );

  for (const builderType of builderTypes) {
    const stageOrder = [
      "bounds",
      "march",
      "amplitude",
      "diffraction",
      "decimate",
      "mesh",
    ] as const;
    const buildFn = builders[builderType];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const timesMs: number[] = [];
    const stageTimesMs = {
      bounds: [] as number[],
      march: [] as number[],
      amplitude: [] as number[],
      diffraction: [] as number[],
      decimate: [] as number[],
      mesh: [] as number[],
    };
    let lastDecimationCounts: MeshBuildProfile["decimationCounts"] | null = null;

    console.log(`  ${builderType}`);

    for (let i = 0; i < iterations; i++) {
      const profile: MeshBuildProfile = {
        totalMs: 0,
        stageMs: {
          bounds: 0,
          march: 0,
          amplitude: 0,
          diffraction: 0,
          decimate: 0,
          mesh: 0,
        },
        decimationCounts: {
          verticesBefore: 0,
          verticesAfter: 0,
          trianglesBefore: 0,
          trianglesAfter: 0,
        },
      };
      console.log = () => {};
      console.warn = () => {};
      buildFn(waveSource, bounds, terrain, tideHeight, profile);
      console.log = originalLog;
      console.warn = originalWarn;
      const elapsed = profile.totalMs;

      timesMs.push(elapsed);
      stageTimesMs.bounds.push(profile.stageMs.bounds);
      stageTimesMs.march.push(profile.stageMs.march);
      stageTimesMs.amplitude.push(profile.stageMs.amplitude);
      stageTimesMs.diffraction.push(profile.stageMs.diffraction);
      stageTimesMs.decimate.push(profile.stageMs.decimate);
      stageTimesMs.mesh.push(profile.stageMs.mesh);
      lastDecimationCounts = profile.decimationCounts;

      const formatStageRows = (
        rows: { label: string; ms: number }[],
        indent: string = "      ",
      ) => {
        const labelWidth = Math.max(...rows.map((r) => r.label.length));
        const msStrings = rows.map((r) => `${r.ms.toFixed(1)}ms`);
        const msWidth = Math.max(...msStrings.map((s) => s.length));
        rows.forEach((row, idx) => {
          console.log(
            `${indent}${row.label.padEnd(labelWidth)} : ${msStrings[idx].padStart(msWidth)}`,
          );
        });
      };

      console.log(`    Run ${i + 1}`);
      formatStageRows([
        { label: "total", ms: elapsed },
        ...stageOrder.map((stage) => ({ label: stage, ms: profile.stageMs[stage] })),
      ]);
    }

    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
        medianMs: sorted[Math.floor(sorted.length / 2)],
        meanMs: values.reduce((a, b) => a + b, 0) / values.length,
      };
    };
    if (iterations > 1) {
      const summaryRows: {
        part: string;
        min: string;
        median: string;
        mean: string;
        max: string;
      }[] = [];
      const total = summarize(timesMs);
      summaryRows.push({
        part: "total",
        min: `${total.minMs.toFixed(1)}ms`,
        median: `${total.medianMs.toFixed(1)}ms`,
        mean: `${total.meanMs.toFixed(1)}ms`,
        max: `${total.maxMs.toFixed(1)}ms`,
      });
      for (const stage of stageOrder) {
        const stats = summarize(stageTimesMs[stage]);
        summaryRows.push({
          part: stage,
          min: `${stats.minMs.toFixed(1)}ms`,
          median: `${stats.medianMs.toFixed(1)}ms`,
          mean: `${stats.meanMs.toFixed(1)}ms`,
          max: `${stats.maxMs.toFixed(1)}ms`,
        });
      }
      console.log("    Summary");
      console.table(summaryRows);
    }
    if (lastDecimationCounts) {
      const verticesRemoved =
        lastDecimationCounts.verticesBefore - lastDecimationCounts.verticesAfter;
      const trianglesRemoved =
        lastDecimationCounts.trianglesBefore - lastDecimationCounts.trianglesAfter;
      const verticesRemovedPct =
        lastDecimationCounts.verticesBefore > 0
          ? (100 * verticesRemoved) / lastDecimationCounts.verticesBefore
          : 0;
      const trianglesRemovedPct =
        lastDecimationCounts.trianglesBefore > 0
          ? (100 * trianglesRemoved) / lastDecimationCounts.trianglesBefore
          : 0;

      console.log("    Mesh counts");
      console.log(
        `      vertices : ${lastDecimationCounts.verticesBefore.toLocaleString()} -> ${lastDecimationCounts.verticesAfter.toLocaleString()} (${verticesRemovedPct.toFixed(1)}% decimated)`,
      );
      console.log(
        `      triangles: ${lastDecimationCounts.trianglesBefore.toLocaleString()} -> ${lastDecimationCounts.trianglesAfter.toLocaleString()} (${trianglesRemovedPct.toFixed(1)}% decimated)`,
      );
    }
    console.log("");
  }
}
