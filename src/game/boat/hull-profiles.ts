/**
 * Hull mesh builder from station-based cross-section profiles.
 *
 * Takes a HullShape (stations with y-z half-profiles) and produces a HullMesh
 * with classified triangle index lists, matching the interface expected by Hull.ts.
 *
 * Pipeline:
 *   1. Resample each station's profile via Catmull-Rom spline → uniform arc-length points
 *   2. Mirror starboard half-profiles to full cross-sections
 *   3. Interpolate subdivided stations between defined stations (Catmull-Rom along x)
 *   4. Loft adjacent cross-sections into quad strips
 *   5. Cap the deck with ear-clip triangulation
 *   6. Classify triangles by centroid z-height
 *   7. Extract deck outline for gunwale rendering
 */

import { earClipTriangulate } from "../../core/util/Triangulate";
import type { HullMesh } from "./Hull";
import type { HullShape } from "./BoatConfig";

// --------------------------------------------------------------------
// Catmull-Rom spline evaluation
// --------------------------------------------------------------------

/**
 * Evaluate a Catmull-Rom spline at parameter t in [0, 1] between p1 and p2,
 * using p0 and p3 as neighboring control points. Standard centripetal form
 * with alpha = 0 (uniform parameterization — simpler and sufficient here
 * since we resample to arc length anyway).
 */
function catmullRom(
  p0y: number,
  p0z: number,
  p1y: number,
  p1z: number,
  p2y: number,
  p2z: number,
  p3y: number,
  p3z: number,
  t: number,
): [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;

  // Catmull-Rom basis (tau = 0.5)
  const y =
    0.5 *
    ((-p0y + 3 * p1y - 3 * p2y + p3y) * t3 +
      (2 * p0y - 5 * p1y + 4 * p2y - p3y) * t2 +
      (-p0y + p2y) * t +
      2 * p1y);
  const z =
    0.5 *
    ((-p0z + 3 * p1z - 3 * p2z + p3z) * t3 +
      (2 * p0z - 5 * p1z + 4 * p2z - p3z) * t2 +
      (-p0z + p2z) * t +
      2 * p1z);

  return [y, z];
}

/**
 * Evaluate Catmull-Rom for a 1D value (used for scalar x interpolation between stations).
 */
function catmullRom1D(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    ((-v0 + 3 * v1 - 3 * v2 + v3) * t3 +
      (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2 +
      (-v0 + v2) * t +
      2 * v1)
  );
}

// --------------------------------------------------------------------
// Profile resampling
// --------------------------------------------------------------------

/**
 * Resample a half-profile's control points into `count` uniformly-spaced
 * points along the arc length using Catmull-Rom interpolation.
 *
 * Returns [y, z] pairs from keel (first point) to gunwale (last point).
 * A single-point profile (bow collapse) returns `count` copies of that point.
 */
function resampleProfile(
  profile: ReadonlyArray<readonly [number, number]>,
  count: number,
): [number, number][] {
  const n = profile.length;

  // Degenerate: single point (bow tip). Return identical copies.
  if (n === 1) {
    const pt: [number, number] = [profile[0][0], profile[0][1]];
    return Array.from({ length: count }, () => [pt[0], pt[1]]);
  }

  // Two-point profile: straight line, no spline needed.
  if (n === 2) {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      out.push([
        profile[0][0] + (profile[1][0] - profile[0][0]) * t,
        profile[0][1] + (profile[1][1] - profile[0][1]) * t,
      ]);
    }
    return out;
  }

  // Step 1: densely sample the Catmull-Rom spline to measure arc length.
  const DENSE = 256;
  const dense: [number, number][] = [];
  const segments = n - 1;

  for (let seg = 0; seg < segments; seg++) {
    const samplesInSeg = seg === segments - 1 ? DENSE + 1 : DENSE;
    for (let s = 0; s < samplesInSeg; s++) {
      const t = s / DENSE;
      // Clamp neighbor indices for endpoint tangents
      const i0 = Math.max(0, seg - 1);
      const i1 = seg;
      const i2 = Math.min(n - 1, seg + 1);
      const i3 = Math.min(n - 1, seg + 2);
      dense.push(
        catmullRom(
          profile[i0][0],
          profile[i0][1],
          profile[i1][0],
          profile[i1][1],
          profile[i2][0],
          profile[i2][1],
          profile[i3][0],
          profile[i3][1],
          t,
        ),
      );
    }
  }

  // Step 2: compute cumulative arc lengths along the dense samples.
  const arcLengths = new Float64Array(dense.length);
  arcLengths[0] = 0;
  for (let i = 1; i < dense.length; i++) {
    const dy = dense[i][0] - dense[i - 1][0];
    const dz = dense[i][1] - dense[i - 1][1];
    arcLengths[i] = arcLengths[i - 1] + Math.sqrt(dy * dy + dz * dz);
  }
  const totalLength = arcLengths[dense.length - 1];

  // Step 3: walk the arc-length table to produce uniformly spaced samples.
  const out: [number, number][] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const targetLen = (i / (count - 1)) * totalLength;
    // Advance cursor until we bracket the target length
    while (cursor < dense.length - 2 && arcLengths[cursor + 1] < targetLen) {
      cursor++;
    }
    const segLen = arcLengths[cursor + 1] - arcLengths[cursor];
    const localT =
      segLen > 1e-12 ? (targetLen - arcLengths[cursor]) / segLen : 0;
    out.push([
      dense[cursor][0] + (dense[cursor + 1][0] - dense[cursor][0]) * localT,
      dense[cursor][1] + (dense[cursor + 1][1] - dense[cursor][1]) * localT,
    ]);
  }

  return out;
}

// --------------------------------------------------------------------
// Station interpolation along the hull length
// --------------------------------------------------------------------

/**
 * Given an array of resampled station profiles (each M points), interpolate
 * `subdivisions` new stations between each adjacent pair using Catmull-Rom
 * in the x-direction, and per-profile-point Catmull-Rom in y-z.
 *
 * Returns the full array of station cross-sections including originals.
 * Each entry: { x, profile: [y, z][] }.
 *
 * sharpSet contains indices of original stations that should not be smoothed
 * past — the interpolated stations still appear, but the sharp station's
 * profile is kept exact (no tangent blending past it).
 */
function interpolateStations(
  stations: { x: number; profile: [number, number][] }[],
  subdivisions: number,
  sharpSet: ReadonlySet<number>,
): { x: number; profile: [number, number][] }[] {
  if (subdivisions <= 0 || stations.length < 2) {
    return stations.map((s) => ({
      x: s.x,
      profile: s.profile.map(([y, z]) => [y, z] as [number, number]),
    }));
  }

  const n = stations.length;
  const M = stations[0].profile.length; // all profiles same size
  const result: { x: number; profile: [number, number][] }[] = [];

  for (let i = 0; i < n - 1; i++) {
    // Neighbor stations for Catmull-Rom tangent computation.
    // Clamp at endpoints; sharp stations act as tangent barriers.
    const i0 = sharpSet.has(i) ? i : Math.max(0, i - 1);
    const i1 = i;
    const i2 = i + 1;
    const i3 = sharpSet.has(i + 1) ? i + 1 : Math.min(n - 1, i + 2);

    const s0 = stations[i0];
    const s1 = stations[i1];
    const s2 = stations[i2];
    const s3 = stations[i3];

    // Emit the original station
    result.push({
      x: s1.x,
      profile: s1.profile.map(([y, z]) => [y, z]),
    });

    // Emit subdivided intermediate stations
    for (let sub = 1; sub <= subdivisions; sub++) {
      if (sub === subdivisions && i < n - 2) {
        // Skip — the next iteration's i1 will emit this station
        continue;
      }
      if (sub === subdivisions) {
        // Last segment, last subdivision IS the final station
        break;
      }

      const t = sub / subdivisions;
      // Clamp x to the segment range to prevent Catmull-Rom overshoot
      // past the stern or bow. This avoids concave hull outlines that
      // break Sutherland-Hodgman polygon clipping.
      const xRaw = catmullRom1D(s0.x, s1.x, s2.x, s3.x, t);
      const xMin = Math.min(s1.x, s2.x);
      const xMax = Math.max(s1.x, s2.x);
      const x = Math.max(xMin, Math.min(xMax, xRaw));
      const profile: [number, number][] = [];

      for (let m = 0; m < M; m++) {
        const [y, z] = catmullRom(
          s0.profile[m][0],
          s0.profile[m][1],
          s1.profile[m][0],
          s1.profile[m][1],
          s2.profile[m][0],
          s2.profile[m][1],
          s3.profile[m][0],
          s3.profile[m][1],
          t,
        );
        profile.push([y, z]);
      }

      result.push({ x, profile });
    }
  }

  // Emit the final station
  const last = stations[n - 1];
  result.push({
    x: last.x,
    profile: last.profile.map(([y, z]) => [y, z]),
  });

  return result;
}

// --------------------------------------------------------------------
// Mirror a half-profile to a full cross-section
// --------------------------------------------------------------------

/**
 * Take a starboard half-profile [y, z] (y >= 0) and produce the full
 * cross-section as [y, z] pairs going:
 *   starboard gunwale → ... → keel center → ... → port gunwale
 *
 * The keel center (first profile point, y ≈ 0) appears once.
 * Port points are mirrored (y negated), reversed so the cross-section
 * traces a continuous U shape.
 *
 * Returns the mirrored profile and the index of the keel-center vertex
 * within the full ring, plus the ring size.
 */
function mirrorProfile(halfProfile: [number, number][]): [number, number][] {
  const n = halfProfile.length;
  // Full cross-section: port gunwale (reversed, y < 0) → keel → starboard gunwale
  // We go: starboard gunwale ... keel ... port gunwale
  // That is: halfProfile reversed (gunwale→keel), then port side (keel→gunwale) minus keel duplicate

  // Starboard side: from gunwale (last) down to keel (first)
  const full: [number, number][] = [];
  for (let i = n - 1; i >= 0; i--) {
    full.push([halfProfile[i][0], halfProfile[i][1]]);
  }
  // Port side: mirror from second point (skip keel duplicate) up to gunwale
  for (let i = 1; i < n; i++) {
    full.push([-halfProfile[i][0], halfProfile[i][1]]);
  }

  return full;
}

// --------------------------------------------------------------------
// Detect whether a profile has collapsed to (near) a point
// --------------------------------------------------------------------

function isCollapsedProfile(profile: [number, number][]): boolean {
  let maxY = 0;
  for (const [y] of profile) {
    const absY = Math.abs(y);
    if (absY > maxY) maxY = absY;
  }
  return maxY < 1e-4; // effectively zero beam
}

// --------------------------------------------------------------------
// Hull outline extraction at arbitrary z-levels
// --------------------------------------------------------------------

/**
 * Extract the hull outline polygon at a given z-height by finding where
 * each station's cross-section profile intersects that z-level.
 *
 * Returns a CCW polygon in hull-local XY, or an empty array if the hull
 * doesn't exist at that z-level.
 */
export function extractHullOutlineAtZ(
  mesh: HullMesh,
  targetZ: number,
): [number, number][] {
  const { xyPositions, zValues, ringSize } = mesh;
  const totalVerts = xyPositions.length;
  const numStations = totalVerts / ringSize;
  // Half-profile point count (starboard side including keel center)
  const halfM = (ringSize + 1) / 2;

  // For each station, find the starboard beam at targetZ
  const starboardPoints: [number, number][] = [];

  for (let si = 0; si < numStations; si++) {
    const base = si * ringSize;
    const stationX = xyPositions[base][0];
    const gunwaleZ = zValues[base]; // vertex 0 = starboard gunwale (highest z)
    const keelZ = zValues[base + halfM - 1]; // keel center (lowest z)

    if (targetZ >= gunwaleZ) {
      // Zone at or above gunwale — use full gunwale beam
      starboardPoints.push([stationX, xyPositions[base][1]]);
      continue;
    }

    if (targetZ <= keelZ) {
      // Zone below keel at this station — hull doesn't exist here
      continue;
    }

    // Walk starboard half from gunwale (high z) to keel (low z),
    // find first segment crossing targetZ
    for (let j = 0; j < halfM - 1; j++) {
      const z0 = zValues[base + j];
      const z1 = zValues[base + j + 1];

      if (z0 >= targetZ && z1 < targetZ) {
        const t = (targetZ - z0) / (z1 - z0);
        const y0 = xyPositions[base + j][1];
        const y1 = xyPositions[base + j + 1][1];
        starboardPoints.push([stationX, y0 + t * (y1 - y0)]);
        break;
      }
    }
  }

  if (starboardPoints.length < 2) return [];

  // Build outline: starboard stern→bow, port bow→stern
  const outline: [number, number][] = [];
  for (const [x, y] of starboardPoints) {
    outline.push([x, y]);
  }
  // Port side (mirror y), reversed to close the polygon.
  // Skip collapsed points (y ≈ 0) to avoid duplicate at bow.
  for (let i = starboardPoints.length - 1; i >= 0; i--) {
    const [x, y] = starboardPoints[i];
    if (Math.abs(y) < 0.01) continue;
    outline.push([x, -y]);
  }

  // Ensure CCW winding for Sutherland-Hodgman clipping
  let area = 0;
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    area += outline[i][0] * outline[j][1] - outline[j][0] * outline[i][1];
  }
  if (area < 0) outline.reverse();

  return outline;
}

// --------------------------------------------------------------------
// Mesh builder
// --------------------------------------------------------------------

export function buildHullMeshFromProfiles(shape: HullShape): HullMesh {
  const profileSubdivisions = shape.profileSubdivisions ?? 4;
  const stationSubdivisions = shape.stationSubdivisions ?? 4;
  const sharpSet = new Set(shape.sharpStations ?? []);

  // Number of resampled points per half-profile.
  // Take the densest control point count and multiply by subdivisions.
  let maxControlPoints = 0;
  for (const station of shape.stations) {
    if (station.profile.length > maxControlPoints) {
      maxControlPoints = station.profile.length;
    }
  }
  const M = Math.max(3, (maxControlPoints - 1) * profileSubdivisions + 1);

  // Step 1: Resample all station profiles to M points.
  const resampledStations = shape.stations.map((station) => ({
    x: station.x,
    profile: resampleProfile(station.profile, M),
  }));

  // Step 2: Interpolate subdivided stations along the hull length.
  const allStations = interpolateStations(
    resampledStations,
    stationSubdivisions,
    sharpSet,
  );

  // Step 3: Mirror half-profiles to full cross-sections and build 3D vertices.
  const positions: number[] = [];
  const xyPositions: [number, number][] = [];
  const zValues: number[] = [];

  // Track which stations are collapsed (bow/stern points) for fan triangulation.
  const collapsed: boolean[] = [];
  // Store the full cross-section for each station for deck outline extraction.
  const fullSections: [number, number][][] = [];
  // Ring size (vertices per full cross-section) — same for all non-collapsed stations.
  const ringSize = 2 * M - 1;

  for (const station of allStations) {
    const full = mirrorProfile(station.profile);
    fullSections.push(full);
    const isPoint = isCollapsedProfile(station.profile);
    collapsed.push(isPoint);

    if (isPoint) {
      // Collapsed station: emit a single vertex (repeated to fill the ring for
      // index consistency — but we'll use fan triangulation from the first vertex).
      // Actually, we emit ringSize vertices all at the same position so that
      // the index math stays uniform. The triangle generator handles collapse.
      const z = station.profile[0][1];
      for (let j = 0; j < ringSize; j++) {
        positions.push(station.x, 0, z);
        xyPositions.push([station.x, 0]);
        zValues.push(z);
      }
    } else {
      for (const [y, z] of full) {
        positions.push(station.x, y, z);
        xyPositions.push([station.x, y]);
        zValues.push(z);
      }
    }
  }

  // Step 4: Generate triangle indices between adjacent station rings.
  const upperSideIndices: number[] = [];
  const lowerSideIndices: number[] = [];
  const bottomIndices: number[] = [];
  const numStations = allStations.length;

  for (let si = 0; si < numStations - 1; si++) {
    const baseA = si * ringSize;
    const baseB = (si + 1) * ringSize;
    const colA = collapsed[si];
    const colB = collapsed[si + 1];

    if (colA && colB) {
      // Both collapsed — no surface between two points, skip.
      continue;
    }

    for (let j = 0; j < ringSize - 1; j++) {
      const a0 = baseA + j;
      const a1 = baseA + j + 1;
      const b0 = baseB + j;
      const b1 = baseB + j + 1;

      // Two triangles forming the quad strip panel.
      // If one station is collapsed, only one triangle is non-degenerate (fan).
      // Winding: we want outward-facing normals.
      // For the hull exterior viewed from outside:
      //   On the starboard side (y > 0), looking from +Y, the surface goes
      //   aft-to-fore left-to-right, and the outward normal points +Y.
      //   CCW winding from outside means: a0, b0, b1 and a0, b1, a1.
      // This holds because stations go stern→bow (+X direction), and within
      // each ring the cross-section goes starboard gunwale → keel → port gunwale.

      if (colA) {
        // Fan from collapsed station A to ring B.
        // a0 == a1 (same point), so only one triangle: a0, b0, b1
        pushTriClassified(
          a0,
          b0,
          b1,
          positions,
          zValues,
          upperSideIndices,
          lowerSideIndices,
          bottomIndices,
        );
      } else if (colB) {
        // Fan from ring A to collapsed station B.
        // b0 == b1 (same point), so only one triangle: a0, a1, b0
        pushTriClassified(
          a0,
          a1,
          b0,
          positions,
          zValues,
          upperSideIndices,
          lowerSideIndices,
          bottomIndices,
        );
      } else {
        // Normal quad: two triangles
        pushTriClassified(
          a0,
          b0,
          b1,
          positions,
          zValues,
          upperSideIndices,
          lowerSideIndices,
          bottomIndices,
        );
        pushTriClassified(
          a0,
          b1,
          a1,
          positions,
          zValues,
          upperSideIndices,
          lowerSideIndices,
          bottomIndices,
        );
      }
    }
  }

  // Step 4b: Generate transom cap (stern closure).
  // The first station's cross-section is an open U-shape. We triangulate it
  // as a flat polygon in the y-z plane to close off the stern.
  if (!collapsed[0]) {
    const base = 0;
    // Build 2D polygon from the cross-section (y, z) for ear-clip.
    const transomPoly: { x: number; y: number }[] = [];
    for (let j = 0; j < ringSize; j++) {
      transomPoly.push({ x: xyPositions[base + j][1], y: zValues[base + j] });
    }

    const rawTransom = earClipTriangulate(transomPoly);
    if (rawTransom) {
      for (let t = 0; t < rawTransom.length; t += 3) {
        const i0 = base + rawTransom[t];
        const i1 = base + rawTransom[t + 1];
        const i2 = base + rawTransom[t + 2];
        const centroidZ = (zValues[i0] + zValues[i1] + zValues[i2]) / 3;
        const target = centroidZ > 0 ? upperSideIndices : lowerSideIndices;
        // Reversed winding so outward normal points aft (-x)
        target.push(i2, i1, i0);
      }
    }
  }

  // Step 5: Build deck cap polygon from gunwale points.
  // The gunwale points are the first and last vertex of each non-collapsed
  // full cross-section. We trace the starboard gunwale forward then the
  // port gunwale back to form a closed polygon.
  const deckOutline: [number, number][] = [];
  const deckPolygon: { x: number; y: number }[] = [];
  // Map from deck polygon vertex index to positions array index
  const deckVertexMap: number[] = [];

  // Starboard gunwale: first vertex of each ring (index 0 = starboard gunwale)
  // going stern → bow
  for (let si = 0; si < numStations; si++) {
    if (collapsed[si]) {
      // Collapsed station: single bow/stern point is part of the outline
      const base = si * ringSize;
      deckVertexMap.push(base);
      const x = xyPositions[base][0];
      const y = xyPositions[base][1];
      deckPolygon.push({ x, y });
      deckOutline.push([x, y]);
    } else {
      const base = si * ringSize;
      // Starboard gunwale is vertex 0 in the full cross-section
      deckVertexMap.push(base);
      const x = xyPositions[base][0];
      const y = xyPositions[base][1];
      deckPolygon.push({ x, y });
      deckOutline.push([x, y]);
    }
  }
  // Port gunwale: last vertex of each ring (index ringSize-1 = port gunwale)
  // going bow → stern (reverse direction to close the polygon)
  for (let si = numStations - 1; si >= 0; si--) {
    if (collapsed[si]) {
      // Skip — already included from the starboard pass (it's the same point)
      continue;
    }
    const base = si * ringSize;
    const idx = base + ringSize - 1;
    // Skip if same as starboard (would happen if only 1 point wide — already caught by collapsed)
    if (
      Math.abs(xyPositions[idx][1] - xyPositions[base][1]) < 1e-6 &&
      Math.abs(xyPositions[idx][0] - xyPositions[base][0]) < 1e-6
    ) {
      continue;
    }
    deckVertexMap.push(idx);
    const x = xyPositions[idx][0];
    const y = xyPositions[idx][1];
    deckPolygon.push({ x, y });
    deckOutline.push([x, y]);
  }

  // Ensure CCW winding (positive signed area) — matches existing hull polygon convention.
  // The mirror function puts positive-y (starboard) first, which may produce CW winding.
  {
    let area = 0;
    for (let i = 0; i < deckPolygon.length; i++) {
      const j = (i + 1) % deckPolygon.length;
      area +=
        deckPolygon[i].x * deckPolygon[j].y -
        deckPolygon[j].x * deckPolygon[i].y;
    }
    if (area < 0) {
      // CW — reverse to CCW
      deckPolygon.reverse();
      deckVertexMap.reverse();
      deckOutline.reverse();
    }
  }

  // Triangulate deck polygon
  let deckIndices: number[] = [];
  if (deckPolygon.length >= 3) {
    const rawDeck = earClipTriangulate(deckPolygon);
    if (rawDeck) {
      // Remap from deck polygon indices to positions array indices
      for (const idx of rawDeck) {
        deckIndices.push(deckVertexMap[idx]);
      }
    }
  }

  return {
    positions,
    ringSize,
    xyPositions,
    zValues,
    deckIndices,
    upperSideIndices,
    lowerSideIndices,
    bottomIndices,
    deckOutline,
    deckVertexMap,
  };
}

// --------------------------------------------------------------------
// Triangle classification helper
// --------------------------------------------------------------------

/**
 * Classify a triangle by its centroid z-height and push its indices into
 * the appropriate bucket.
 *
 * Classification:
 *   - Bottom: centroid z is within 0.05 ft of the minimum z in the mesh
 *     and the triangle is roughly horizontal (used for the keel line).
 *     In practice, triangles near the very bottom of the hull go here.
 *   - Upper side: centroid z > 0 (above waterline)
 *   - Lower side: centroid z <= 0 (below waterline)
 */
function pushTriClassified(
  i0: number,
  i1: number,
  i2: number,
  positions: number[],
  zValues: number[],
  upperSide: number[],
  lowerSide: number[],
  bottom: number[],
): void {
  const z0 = zValues[i0];
  const z1 = zValues[i1];
  const z2 = zValues[i2];
  const centroidZ = (z0 + z1 + z2) / 3;

  // Check if the triangle is nearly horizontal and at the very bottom.
  // A bottom triangle has all vertices at roughly the same z, and that z
  // is the lowest in its local neighborhood. We approximate by checking
  // if the triangle's normal is mostly vertical (large |nz|) and z < -draft + epsilon.
  // Simpler heuristic: if the y-span of all three vertices is very small,
  // the triangle lies along the keel centerline — classify as bottom.
  const y0 = positions[i0 * 3 + 1];
  const y1 = positions[i1 * 3 + 1];
  const y2 = positions[i2 * 3 + 1];
  const ySpan = Math.max(y0, y1, y2) - Math.min(y0, y1, y2);

  if (ySpan < 0.01 && centroidZ < 0) {
    // Keel centerline strip — classify as bottom
    bottom.push(i0, i1, i2);
  } else if (centroidZ > 0) {
    upperSide.push(i0, i1, i2);
  } else {
    lowerSide.push(i0, i1, i2);
  }
}
