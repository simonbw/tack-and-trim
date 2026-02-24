#!/usr/bin/env tsx
/**
 * Find exact crossing segments between contours and understand the geometry.
 */
import { readFileSync } from "fs";

const levelPath = "assets/terrain/san-juan-islands/san-juan-islands.level.json";
const data = JSON.parse(readFileSync(levelPath, "utf-8"));
const contours: { height: number; polygon: [number, number][] }[] =
  data.contours;

function segmentsIntersect(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  p3x: number,
  p3y: number,
  p4x: number,
  p4y: number,
): { t: number; u: number } | null {
  const d1x = p2x - p1x,
    d1y = p2y - p1y;
  const d2x = p4x - p3x,
    d2y = p4y - p3y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
  const u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;
  const eps = 1e-9;
  if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
    return { t, u };
  }
  return null;
}

// Find ALL crossings between contour 7 (0ft) and contour 534 (200ft)
const c0 = contours[7]; // 0ft
const c200 = contours[534]; // 200ft
console.log(`Contour 7: h=${c0.height}ft, ${c0.polygon.length} pts`);
console.log(`Contour 534: h=${c200.height}ft, ${c200.polygon.length} pts`);

console.log("\nSearching for crossing segments...");
let crossCount = 0;
for (let i = 0; i < c0.polygon.length; i++) {
  const i2 = (i + 1) % c0.polygon.length;
  const [ax1, ay1] = c0.polygon[i];
  const [ax2, ay2] = c0.polygon[i2];

  for (let j = 0; j < c200.polygon.length; j++) {
    const j2 = (j + 1) % c200.polygon.length;
    const [bx1, by1] = c200.polygon[j];
    const [bx2, by2] = c200.polygon[j2];

    const result = segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2);
    if (result) {
      crossCount++;
      const crossX = ax1 + result.t * (ax2 - ax1);
      const crossY = ay1 + result.t * (ay2 - ay1);

      // Print context: vertices around the crossing on both contours
      console.log(
        `\n--- Crossing #${crossCount} at (${crossX.toFixed(1)}, ${crossY.toFixed(1)}) ---`,
      );
      console.log(
        `  0ft seg [${i}→${i2}]: (${ax1.toFixed(1)}, ${ay1.toFixed(1)}) → (${ax2.toFixed(1)}, ${ay2.toFixed(1)}), len=${Math.hypot(ax2 - ax1, ay2 - ay1).toFixed(1)}ft`,
      );
      console.log(
        `  200ft seg [${j}→${j2}]: (${bx1.toFixed(1)}, ${by1.toFixed(1)}) → (${bx2.toFixed(1)}, ${by2.toFixed(1)}), len=${Math.hypot(bx2 - bx1, by2 - by1).toFixed(1)}ft`,
      );

      // Print nearby vertices on both contours
      console.log(
        `  0ft context (${Math.max(0, i - 3)} to ${Math.min(c0.polygon.length - 1, i + 4)}):`,
      );
      for (
        let k = Math.max(0, i - 3);
        k <= Math.min(c0.polygon.length - 1, i + 4);
        k++
      ) {
        const marker = k === i ? " >>>" : k === i2 ? " <<<" : "    ";
        console.log(
          `${marker}  [${k}] (${c0.polygon[k][0].toFixed(1)}, ${c0.polygon[k][1].toFixed(1)})`,
        );
      }
      console.log(
        `  200ft context (${Math.max(0, j - 3)} to ${Math.min(c200.polygon.length - 1, j + 4)}):`,
      );
      for (
        let k = Math.max(0, j - 3);
        k <= Math.min(c200.polygon.length - 1, j + 4);
        k++
      ) {
        const marker = k === j ? " >>>" : k === j2 ? " <<<" : "    ";
        console.log(
          `${marker}  [${k}] (${c200.polygon[k][0].toFixed(1)}, ${c200.polygon[k][1].toFixed(1)})`,
        );
      }

      if (crossCount >= 5) break;
    }
  }
  if (crossCount >= 5) break;
}

console.log(`\nTotal crossings found: ${crossCount} (stopped at 5)`);

// Check if these contours share maxX
let c0maxX = -Infinity,
  c200maxX = -Infinity;
for (const [x] of c0.polygon) if (x > c0maxX) c0maxX = x;
for (const [x] of c200.polygon) if (x > c200maxX) c200maxX = x;
console.log(`\n0ft maxX: ${c0maxX.toFixed(1)}`);
console.log(`200ft maxX: ${c200maxX.toFixed(1)}`);

// Check if contour 534 is a near-duplicate of 535
if (contours[535]) {
  const c535 = contours[535];
  console.log(`\nContour 535: h=${c535.height}ft, ${c535.polygon.length} pts`);
  // Find segments that differ between 534 and 535
  const diff534 = new Set(
    c200.polygon.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`),
  );
  const diff535 = new Set(
    c535.polygon.map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`),
  );
  const only534 = [...diff534].filter((p) => !diff535.has(p));
  const only535 = [...diff535].filter((p) => !diff534.has(p));
  console.log(
    `Points only in 534: ${only534.length}, only in 535: ${only535.length}`,
  );
  if (only534.length < 20) {
    console.log("Only in 534:");
    for (const p of only534) console.log(`  ${p}`);
  }
  if (only535.length < 20) {
    console.log("Only in 535:");
    for (const p of only535) console.log(`  ${p}`);
  }
}
