/**
 * Deck plan renderer — builds triangle meshes for interior deck features
 * (cockpits, cabins, benches, etc.) from zone-based definitions.
 *
 * Zone polygons are clipped to the hull's deck outline using
 * Sutherland-Hodgman, then triangulated with ear-clipping.
 * Walls are generated as vertical quads around zone boundaries.
 */

import { earClipTriangulate, type Point2D } from "../../core/util/Triangulate";
import type { DeckPlan } from "./BoatConfig";
import type { HullMesh } from "./Hull";
import { extractHullOutlineAtZ } from "./hull-profiles";
import type { MeshContribution } from "./tessellation";

/**
 * Clip a subject polygon against a convex-ish clip polygon using the
 * Sutherland-Hodgman algorithm. Returns the clipped polygon, or an
 * empty array if the subject is entirely outside the clip region.
 */
export function clipPolygon(
  subject: [number, number][],
  clip: [number, number][],
): [number, number][] {
  if (subject.length === 0 || clip.length < 3) return [];

  let output: [number, number][] = subject.slice();

  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) return [];

    const edgeA = clip[i];
    const edgeB = clip[(i + 1) % clip.length];
    const input = output;
    output = [];

    for (let j = 0; j < input.length; j++) {
      const current = input[j];
      const previous = input[(j - 1 + input.length) % input.length];

      const currInside = isInside(current, edgeA, edgeB);
      const prevInside = isInside(previous, edgeA, edgeB);

      if (currInside) {
        if (!prevInside) {
          // Entering: add intersection then current
          output.push(lineIntersect(previous, current, edgeA, edgeB));
        }
        output.push(current);
      } else if (prevInside) {
        // Leaving: add intersection only
        output.push(lineIntersect(previous, current, edgeA, edgeB));
      }
    }
  }

  return output;
}

/**
 * Test if point P is on the inside (left side) of directed edge A->B.
 * Uses the cross product sign; positive = left of edge = inside.
 */
function isInside(
  p: [number, number],
  edgeA: [number, number],
  edgeB: [number, number],
): boolean {
  return (
    (edgeB[0] - edgeA[0]) * (p[1] - edgeA[1]) -
      (edgeB[1] - edgeA[1]) * (p[0] - edgeA[0]) >=
    0
  );
}

/**
 * Compute the intersection of line segment P1-P2 with the infinite line
 * through edgeA-edgeB.
 */
function lineIntersect(
  p1: [number, number],
  p2: [number, number],
  edgeA: [number, number],
  edgeB: [number, number],
): [number, number] {
  const x1 = p1[0],
    y1 = p1[1];
  const x2 = p2[0],
    y2 = p2[1];
  const x3 = edgeA[0],
    y3 = edgeA[1];
  const x4 = edgeB[0],
    y4 = edgeB[1];

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-12) {
    // Lines are parallel; return midpoint as fallback
    return [(x1 + x2) / 2, (y1 + y2) / 2];
  }

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

/** Darken a hex RGB color by multiplying each channel by factor (0-1). */
function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * Build renderable mesh contributions for a deck plan.
 * Returns meshes sorted by z-order (draw lowest first).
 *
 * @param plan The deck plan definition
 * @param hullOutline The hull's deck edge polygon (gunwale points), hull-local XY
 * @param defaultDeckZ The default deck height (used as wall top for cockpits, etc.)
 * @param hullMesh Optional hull mesh for extracting precise outlines at each zone's z-level
 */
export function buildDeckPlanMeshes(
  plan: DeckPlan,
  hullOutline: [number, number][],
  defaultDeckZ: number,
  hullMesh?: HullMesh,
): MeshContribution[] {
  const meshes: MeshContribution[] = [];

  // Sort zones by floorZ ascending — lowest floors first
  const sortedZones = [...plan.zones].sort((a, b) => a.floorZ - b.floorZ);

  // Cache extracted outlines by z-level (many zones share the same floorZ)
  const outlineCache = new Map<number, [number, number][]>();

  for (const zone of sortedZones) {
    // Clip zone outline to the hull boundary at this zone's z-level.
    // When the hull mesh is available, we extract the precise hull outline
    // at the zone's floorZ — this handles hull taper perfectly.
    let clipOutline: [number, number][];
    if (hullMesh && zone.floorZ < defaultDeckZ) {
      let cached = outlineCache.get(zone.floorZ);
      if (!cached) {
        cached = extractHullOutlineAtZ(hullMesh, zone.floorZ);
        outlineCache.set(zone.floorZ, cached);
      }
      clipOutline = cached.length >= 3 ? cached : hullOutline;
    } else {
      clipOutline = hullOutline;
    }

    const outline: [number, number][] = zone.outline.map(
      ([x, y]) => [x, y] as [number, number],
    );
    const clipped = clipPolygon(outline, clipOutline);
    if (clipped.length < 3) continue;

    // --- Walls (drawn before floor so floor of higher zones covers wall tops) ---
    if (zone.wallHeight != null && zone.wallHeight > 0) {
      const wallColor = zone.wallColor ?? darkenColor(zone.color, 0.75);
      const bottomZ = zone.floorZ;
      const topZ = zone.floorZ + zone.wallHeight;

      const positions: [number, number][] = [];
      const zValues: number[] = [];
      const indices: number[] = [];

      for (let i = 0; i < clipped.length; i++) {
        const next = (i + 1) % clipped.length;
        const ax = clipped[i][0],
          ay = clipped[i][1];
        const bx = clipped[next][0],
          by = clipped[next][1];

        // Each wall segment is a quad: 4 vertices, 2 triangles.
        // Bottom-left, bottom-right, top-right, top-left
        const base = positions.length;
        positions.push([ax, ay], [bx, by], [bx, by], [ax, ay]);
        zValues.push(bottomZ, bottomZ, topZ, topZ);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }

      meshes.push({ positions, zValues, indices, color: wallColor, alpha: 1 });
    }

    // --- Floor polygon ---
    const points: Point2D[] = clipped.map(([x, y]) => ({ x, y }));
    const triIndices = earClipTriangulate(points);
    if (!triIndices || triIndices.length === 0) continue;

    const floorPositions: [number, number][] = clipped.map(
      ([x, y]) => [x, y] as [number, number],
    );
    const floorZValues: number[] = clipped.map(() => zone.floorZ);

    meshes.push({
      positions: floorPositions,
      zValues: floorZValues,
      indices: triIndices,
      color: zone.color,
      alpha: 1,
    });
  }

  return meshes;
}
