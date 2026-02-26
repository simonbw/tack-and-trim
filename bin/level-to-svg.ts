/**
 * Generate an SVG visualization of a level file's terrain contours.
 *
 * Usage: npx tsx bin/level-to-svg.ts [level.json] [output.svg]
 * If no output path given, writes to stdout.
 */

import * as fs from "fs";
import * as path from "path";
import {
  parseLevelFile,
  levelFileToTerrainDefinition,
} from "../src/editor/io/LevelFileFormat";
import {
  buildContourTree,
  TerrainContour,
  ContourTree,
} from "../src/game/world/terrain/LandMass";

const DEFAULT_LEVEL = path.resolve(
  __dirname,
  "../assets/terrain/san-juan-islands/san-juan-islands.level.json",
);

function heightToColor(height: number): string {
  if (height < -40) return "#1a3a5c"; // deep ocean
  if (height < -20) return "#1e4d7b"; // mid ocean
  if (height < -5) return "#2d6a9f"; // shallow ocean
  if (height < 0) return "#4a90c4"; // near-shore underwater
  if (height === 0) return "#c2b280"; // coastline / sand
  if (height < 10) return "#5a8f3c"; // low land
  if (height < 30) return "#4a7a2e"; // mid land
  if (height < 60) return "#6b6b3a"; // high land
  if (height < 100) return "#7a6a4f"; // hills
  return "#8a8a7a"; // peaks
}

function run() {
  const levelPath = process.argv[2] || DEFAULT_LEVEL;
  const outputPath = process.argv[3]; // optional

  const json = fs.readFileSync(levelPath, "utf-8");
  const levelFile = parseLevelFile(json);
  const terrain = levelFileToTerrainDefinition(levelFile);
  const contours = terrain.contours;

  if (contours.length === 0) {
    console.error("No contours found.");
    process.exit(1);
  }

  const tree = buildContourTree(contours);

  // Compute global bounding box
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const c of contours) {
    for (const p of c.sampledPolygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }

  const pad = Math.max(maxX - minX, maxY - minY) * 0.05;
  const vx = minX - pad;
  const vy = minY - pad;
  const vw = maxX - minX + pad * 2;
  const vh = maxY - minY + pad * 2;

  // DFS traversal — parents first (painter's algorithm)
  const polygons: string[] = [];

  function visit(contourIndex: number) {
    const contour = contours[contourIndex];
    const points = contour.sampledPolygon.map((p) => `${p.x},${p.y}`).join(" ");
    const fill = heightToColor(contour.height);
    polygons.push(
      `  <polygon points="${points}" fill="${fill}" stroke="#333" stroke-width="${vw * 0.001}" opacity="0.9"/>`,
    );
    // Visit children
    const node = tree.nodes[contourIndex];
    for (const childIdx of node.children) {
      visit(childIdx);
    }
  }

  // Start from roots
  for (let i = 0; i < tree.nodes.length; i++) {
    if (tree.nodes[i].parentIndex === -1) {
      visit(i);
    }
  }

  // Build SVG
  const defaultDepthColor = heightToColor(terrain.defaultDepth ?? -50);
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}">
  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${defaultDepthColor}"/>
${polygons.join("\n")}
</svg>
`;

  if (outputPath) {
    fs.writeFileSync(outputPath, svg);
    console.error(`Wrote SVG to ${outputPath}`);
  } else {
    process.stdout.write(svg);
  }
}

run();
