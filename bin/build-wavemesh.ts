#!/usr/bin/env tsx
/**
 * CLI tool to build .wavemesh binary files for offline wave mesh data.
 *
 * Usage:
 *   npx tsx bin/build-wavemesh.ts                    # all levels
 *   npx tsx bin/build-wavemesh.ts --level path/to/level.json
 *   npx tsx bin/build-wavemesh.ts --level path/to/level.json --output path/to/output.wavemesh
 */

import * as fs from "fs";
import * as path from "path";
import { globSync } from "glob";
import {
  parseLevelFile,
  levelFileToTerrainDefinition,
  levelFileToWaveConfig,
} from "../src/editor/io/LevelFileFormat";
import {
  buildTerrainGPUData,
  normalizeTerrainWinding,
} from "../src/game/world/terrain/LandMass";
import { buildMarchingMesh } from "../src/pipeline/mesh-building/buildMarchingMesh";
import type { TerrainCPUData } from "../src/game/world/terrain/TerrainCPUData";
import type {
  MeshBuildBounds,
  WavefrontMeshData,
} from "../src/pipeline/mesh-building/MeshBuildTypes";
import {
  buildWavemeshBuffer,
  computeInputHash,
} from "../src/pipeline/mesh-building/WavemeshFile";

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let levelPaths: string[] = [];
let outputPath: string | null = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--level" || args[i] === "-l") {
    levelPaths.push(path.resolve(args[++i]));
  } else if (args[i] === "--output" || args[i] === "-o") {
    outputPath = path.resolve(args[++i]);
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`Usage: npx tsx bin/build-wavemesh.ts [options]

Options:
  -l, --level <path>    Level file path (repeatable; default: all levels in resources/levels/)
  -o, --output <path>   Output .wavemesh path (only valid with single --level)
  -h, --help            Show this help

Config overrides:
  Set MESH_BUILD_* environment variables (for example:
  MESH_BUILD_VERTEX_SPACING_FT=30 MESH_BUILD_STEP_SIZE_FT=15)
`);
    process.exit(0);
  }
}

// Default: all levels
if (levelPaths.length === 0) {
  const levelsDir = path.resolve(__dirname, "../resources/levels");
  levelPaths = globSync(`${levelsDir}/*.level.json`);
}

if (outputPath && levelPaths.length > 1) {
  console.error("--output can only be used with a single --level");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build each level
// ---------------------------------------------------------------------------

for (const levelPath of levelPaths) {
  const levelName = path.basename(levelPath, ".level.json");
  const wavemeshPath =
    outputPath ?? levelPath.replace(/\.level\.json$/, ".wavemesh");

  console.log(`\n=== ${levelName} ===`);
  console.log(`  Level: ${levelPath}`);

  // Load and parse level
  let timer = performance.now();
  const levelJson = fs.readFileSync(levelPath, "utf-8");
  const levelFile = parseLevelFile(levelJson);
  const terrainDef = normalizeTerrainWinding(
    levelFileToTerrainDefinition(levelFile),
  );
  const waveConfig = levelFileToWaveConfig(levelFile);
  console.log(
    `  Parsed level: ${(performance.now() - timer).toFixed(0)}ms (${terrainDef.contours.length} contours, ${waveConfig.sources.length} wave sources)`,
  );

  if (waveConfig.sources.length === 0) {
    console.log("  No wave sources — skipping");
    continue;
  }

  // Build terrain CPU data
  timer = performance.now();
  const terrainGPUData = buildTerrainGPUData(terrainDef);
  const terrain: TerrainCPUData = {
    vertexData: terrainGPUData.vertexData,
    contourData: terrainGPUData.contourData,
    childrenData: terrainGPUData.childrenData,
    contourCount: terrainGPUData.contourCount,
    defaultDepth: terrainDef.defaultDepth ?? terrainGPUData.defaultDepth,
  };
  console.log(
    `  Built terrain data: ${(performance.now() - timer).toFixed(0)}ms`,
  );

  // Compute coastline bounds
  let coastlineBounds: MeshBuildBounds | null = null;
  for (const contour of terrainDef.contours) {
    if (contour.height === 0) {
      for (const pt of contour.sampledPolygon) {
        if (!coastlineBounds) {
          coastlineBounds = {
            minX: pt.x,
            maxX: pt.x,
            minY: pt.y,
            maxY: pt.y,
          };
        } else {
          coastlineBounds.minX = Math.min(coastlineBounds.minX, pt.x);
          coastlineBounds.maxX = Math.max(coastlineBounds.maxX, pt.x);
          coastlineBounds.minY = Math.min(coastlineBounds.minY, pt.y);
          coastlineBounds.maxY = Math.max(coastlineBounds.maxY, pt.y);
        }
      }
    }
  }

  const tideHeight = 0;

  // Compute input hash
  const inputHash = computeInputHash(waveConfig.sources, terrain, tideHeight);
  console.log(
    `  Input hash: 0x${inputHash[0].toString(16).padStart(8, "0")}${inputHash[1].toString(16).padStart(8, "0")}`,
  );

  // Build meshes for all wave sources
  const meshes: WavefrontMeshData[] = [];
  const totalTimer = performance.now();

  for (let i = 0; i < waveConfig.sources.length; i++) {
    const waveSource = waveConfig.sources[i];
    timer = performance.now();
    console.log(
      `  Wave ${i}: λ=${waveSource.wavelength}ft, dir=${((waveSource.direction * 180) / Math.PI).toFixed(1)}°`,
    );

    const meshData = buildMarchingMesh(
      waveSource,
      coastlineBounds,
      terrain,
      tideHeight,
    );

    const elapsed = performance.now() - timer;
    console.log(
      `    Built in ${elapsed.toFixed(0)}ms — ${meshData.vertexCount.toLocaleString()} vertices, ${(meshData.indexCount / 3).toLocaleString()} triangles`,
    );
    meshes.push(meshData);
  }

  const totalBuildTime = performance.now() - totalTimer;
  console.log(`  Total build time: ${totalBuildTime.toFixed(0)}ms`);

  // Write binary file
  timer = performance.now();
  const buffer = buildWavemeshBuffer(meshes, inputHash);
  fs.writeFileSync(wavemeshPath, Buffer.from(buffer));
  console.log(
    `  Wrote ${wavemeshPath} (${(buffer.byteLength / 1024).toFixed(1)} KB) in ${(performance.now() - timer).toFixed(0)}ms`,
  );
}

console.log("\nDone.");
