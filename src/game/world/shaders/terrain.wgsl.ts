/**
 * High-level terrain query shader modules.
 *
 * Top-level entry points (`computeTerrainHeight`, `computeTerrainHeightAndGradient`,
 * `computeTerrainNormal`) that turn a world position into a height/gradient by:
 *  1. Locating the deepest containing contour
 *  2. IDW-blending against that contour's children
 *
 * Lower-level helpers live in:
 *  - `terrain-idw.wgsl` — IDW weight/blend primitives
 *  - `terrain-containment.wgsl` — point-in-contour and signed-distance helpers
 *
 * Naming convention:
 * - `fn_` prefix for function modules
 * - `struct_` prefix for struct modules
 * - `const_` prefix for constant modules
 *
 * Each module exports exactly one thing, named to match the export.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";
import { FLOATS_PER_CONTOUR } from "../terrain/LandMass";
import { IDW_GRID_SIZE, MAX_IDW_CONTOURS } from "../terrain/TerrainConstants";
import { fn_pointToLineSegmentDistanceSq } from "./polygon.wgsl";
import {
  fn_computeDistanceToBoundary,
  fn_computeDistanceToBoundaryWithGradient,
  fn_isInsideContour,
} from "./terrain-containment.wgsl";
import {
  struct_ContourData,
  fn_getTerrainVertex,
  fn_getContourData,
  fn_getTerrainChild,
  fn_getIDWGridCandidateRange,
  fn_getIDWGridEntry,
  fn_getLookupGridBaseContour,
  fn_getLookupGridCandidateRange,
  fn_getLookupGridCandidate,
} from "./terrain-packed.wgsl";

// Re-export for backwards compatibility with existing consumers
// (e.g. TerrainTileShader, TerrainGradientDebugMode use struct_ContourData
// alongside the high-level entry points)
export { struct_ContourData };

/**
 * Compute terrain height at a world point using IDW interpolation.
 *
 * Algorithm:
 * 1. Find the deepest contour containing the point using DFS skip traversal
 *    (uses fast winding-only test, no distance calculation)
 * 2. Compute distance to the deepest contour and each of its children
 * 3. Blend heights using inverse distance weighting:
 *    height = sum(h_i / d_i) / sum(1 / d_i)
 *
 * Contours are ordered in DFS pre-order. Each contour has a skipCount
 * indicating how many contours are in its subtree. If we're not inside
 * a contour, we skip its entire subtree.
 *
 * This creates smooth height transitions between contours.
 *
 * Dependencies: fn_isInsideContour, fn_computeDistanceToBoundary
 */
export const fn_computeTerrainHeight: ShaderModule = {
  code: /*wgsl*/ `
    // Minimum distance to avoid division by zero in IDW (private to this module)
    const _IDW_MIN_DIST: f32 = 0.1;

    fn computeTerrainHeight(
      worldPos: vec2<f32>,
      packedTerrain: ptr<storage, array<u32>, read>,
      contourCount: u32,
      defaultDepth: f32
    ) -> f32 {
      // Phase 1: Find the deepest containing contour
      var deepestIndex: i32 = -1;

      let lookupGridOffset = (*packedTerrain)[5u];
      if (lookupGridOffset != 0u) {
        // Lookup grid fast path: O(candidates) instead of O(contours)
        let gridCols = (*packedTerrain)[lookupGridOffset];
        let gridRows = (*packedTerrain)[lookupGridOffset + 1u];
        let gridMinX = bitcast<f32>((*packedTerrain)[lookupGridOffset + 2u]);
        let gridMinY = bitcast<f32>((*packedTerrain)[lookupGridOffset + 3u]);
        let gridInvCellW = bitcast<f32>((*packedTerrain)[lookupGridOffset + 4u]);
        let gridInvCellH = bitcast<f32>((*packedTerrain)[lookupGridOffset + 5u]);

        let col = i32(floor((worldPos.x - gridMinX) * gridInvCellW));
        let row = i32(floor((worldPos.y - gridMinY) * gridInvCellH));

        if (col >= 0 && row >= 0 && u32(col) < gridCols && u32(row) < gridRows) {
          let cellIndex = u32(row) * gridCols + u32(col);

          // Check candidates deepest-first; first match is the deepest containing contour
          let range = getLookupGridCandidateRange(packedTerrain, lookupGridOffset, cellIndex);
          for (var c = range.x; c < range.y; c++) {
            let candidateIdx = getLookupGridCandidate(packedTerrain, lookupGridOffset, c);
            if (isInsideContour(worldPos, candidateIdx, packedTerrain)) {
              deepestIndex = i32(candidateIdx);
              break;
            }
          }

          // If no candidate matched, use base contour
          if (deepestIndex < 0) {
            let base = getLookupGridBaseContour(packedTerrain, lookupGridOffset, cellIndex);
            if (base != 0xFFFFFFFFu) {
              deepestIndex = i32(base);
            }
          }
        }
        // Outside grid bounds → outside all contours → deepestIndex stays -1
      } else {
        // DFS skip traversal fallback (when no lookup grid is available)
        var deepestDepth: u32 = 0u;
        var i: u32 = 0u;
        var lastToCheck: u32 = contourCount;

        while (i < lastToCheck) {
          let contour = getContourData(packedTerrain, i);

          if (isInsideContour(worldPos, i, packedTerrain)) {
            if (contour.depth >= deepestDepth) {
              deepestDepth = contour.depth;
              deepestIndex = i32(i);
            }
            lastToCheck = i + contour.skipCount + 1u;
            i += 1u;
          } else {
            i += contour.skipCount + 1u;
          }
        }
      }

      // Phase 2: If not inside any contour, return default depth
      if (deepestIndex < 0) {
        return defaultDepth;
      }

      let parent = getContourData(packedTerrain, u32(deepestIndex));

      // Phase 3: If the parent has no children, return its height directly
      // (no IDW blending needed, so skip distance calculation entirely)
      if (parent.childCount == 0u) {
        return parent.height;
      }

      // Phase 4: IDW interpolation between parent and children
      let gridBase = parent.idwGridDataOffset;
      if (gridBase == 0u) {
        // Fallback: no IDW grid — linear scan of all edges
        let distToParent = computeDistanceToBoundary(worldPos, u32(deepestIndex), packedTerrain);
        let parentWeight = 1.0 / max(distToParent, _IDW_MIN_DIST);
        var totalWeight = parentWeight;
        var weightedSum = parent.height * parentWeight;

        for (var c: u32 = 0u; c < parent.childCount; c++) {
          let childIndex = getTerrainChild(packedTerrain, parent.childStartIndex + c);
          let child = getContourData(packedTerrain, childIndex);
          let distToChild = computeDistanceToBoundary(worldPos, childIndex, packedTerrain);
          let childWeight = 1.0 / max(distToChild, _IDW_MIN_DIST);
          totalWeight += childWeight;
          weightedSum += child.height * childWeight;
        }
        return weightedSum / totalWeight;
      }

      // Grid-accelerated IDW: map world pos to grid cell
      let bboxW = parent.bboxMaxX - parent.bboxMinX;
      let bboxH = parent.bboxMaxY - parent.bboxMinY;
      let col = u32(clamp(floor((worldPos.x - parent.bboxMinX) * (${IDW_GRID_SIZE}.0 / bboxW)), 0.0, ${IDW_GRID_SIZE - 1}.0));
      let row = u32(clamp(floor((worldPos.y - parent.bboxMinY) * (${IDW_GRID_SIZE}.0 / bboxH)), 0.0, ${IDW_GRID_SIZE - 1}.0));
      let cellIdx = row * ${IDW_GRID_SIZE}u + col;

      let range = getIDWGridCandidateRange(packedTerrain, gridBase, cellIdx);

      // Track per-contour best distances
      let contourCount2 = 1u + parent.childCount;
      var bestDistSq: array<f32, ${MAX_IDW_CONTOURS}>;
      for (var t = 0u; t < contourCount2; t++) { bestDistSq[t] = 1e20; }

      // Read parent contour vertex info once
      let contoursBase = (*packedTerrain)[1u];

      // Process candidates
      for (var e = range.x; e < range.y; e++) {
        let packed_entry = getIDWGridEntry(packedTerrain, gridBase, e);
        let tag = packed_entry >> 16u;
        let edgeIdx = packed_entry & 0xFFFFu;

        // Resolve contour index for this tag
        var cIdx: u32;
        if (tag == 0u) { cIdx = u32(deepestIndex); }
        else { cIdx = getTerrainChild(packedTerrain, parent.childStartIndex + tag - 1u); }

        let cBase = contoursBase + cIdx * ${FLOATS_PER_CONTOUR}u;
        let pStart = (*packedTerrain)[cBase];
        let pCount = (*packedTerrain)[cBase + 1u];

        let a = getTerrainVertex(packedTerrain, pStart + edgeIdx);
        let b = getTerrainVertex(packedTerrain, pStart + ((edgeIdx + 1u) % pCount));

        let distSq = pointToLineSegmentDistanceSq(worldPos, a, b);
        if (distSq < bestDistSq[tag]) { bestDistSq[tag] = distSq; }
      }

      // IDW blend using per-contour best distances
      let parentDist = max(sqrt(bestDistSq[0u]), _IDW_MIN_DIST);
      let parentW = 1.0 / parentDist;
      var totalWeight2 = parentW;
      var weightedSum2 = parent.height * parentW;

      for (var c2: u32 = 0u; c2 < parent.childCount; c2++) {
        let childIdx = getTerrainChild(packedTerrain, parent.childStartIndex + c2);
        let child = getContourData(packedTerrain, childIdx);
        let childDist = max(sqrt(bestDistSq[c2 + 1u]), _IDW_MIN_DIST);
        let childW = 1.0 / childDist;
        totalWeight2 += childW;
        weightedSum2 += child.height * childW;
      }
      return weightedSum2 / totalWeight2;
    }
  `,
  dependencies: [
    fn_isInsideContour,
    fn_computeDistanceToBoundary,
    fn_pointToLineSegmentDistanceSq,
    fn_getContourData,
    fn_getTerrainChild,
    fn_getTerrainVertex,
    fn_getIDWGridCandidateRange,
    fn_getIDWGridEntry,
    fn_getLookupGridBaseContour,
    fn_getLookupGridCandidateRange,
    fn_getLookupGridCandidate,
  ],
};

/**
 * Compute terrain height AND gradient in a single pass.
 *
 * Instead of finite-difference normals (which require 3 extra computeTerrainHeight calls),
 * this analytically differentiates the IDW interpolation formula using the quotient rule:
 *   h = Σ(hᵢ·wᵢ) / Σ(wᵢ)  where wᵢ = 1/dᵢ
 *   ∇h = (∇(Σhᵢwᵢ)·Σwᵢ - Σhᵢwᵢ·∇(Σwᵢ)) / (Σwᵢ)²
 *
 * The gradient of each weight w=1/d is ∇w = -1/d² · ∇d, where ∇d is the unit direction
 * to the nearest boundary edge (computed alongside distance at no extra traversal cost).
 *
 * Result: same quality gradient with 1 terrain traversal instead of 4.
 *
 * Dependencies: fn_isInsideContour, fn_computeDistanceToBoundaryWithGradient
 */
export const fn_computeTerrainHeightAndGradient: ShaderModule = {
  code: /*wgsl*/ `
    struct TerrainHeightAndGradient {
      height: f32,
      gradientX: f32,
      gradientY: f32,
    }

    const _IDW_MIN_DIST: f32 = 0.1;

    fn computeTerrainHeightAndGradient(
      worldPos: vec2<f32>,
      packedTerrain: ptr<storage, array<u32>, read>,
      contourCount: u32,
      defaultDepth: f32
    ) -> TerrainHeightAndGradient {
      var result: TerrainHeightAndGradient;

      // Phase 1: Find the deepest containing contour
      var deepestIndex: i32 = -1;

      let lookupGridOffset = (*packedTerrain)[5u];
      if (lookupGridOffset != 0u) {
        // Lookup grid fast path
        let gridCols = (*packedTerrain)[lookupGridOffset];
        let gridRows = (*packedTerrain)[lookupGridOffset + 1u];
        let gridMinX = bitcast<f32>((*packedTerrain)[lookupGridOffset + 2u]);
        let gridMinY = bitcast<f32>((*packedTerrain)[lookupGridOffset + 3u]);
        let gridInvCellW = bitcast<f32>((*packedTerrain)[lookupGridOffset + 4u]);
        let gridInvCellH = bitcast<f32>((*packedTerrain)[lookupGridOffset + 5u]);

        let col = i32(floor((worldPos.x - gridMinX) * gridInvCellW));
        let row = i32(floor((worldPos.y - gridMinY) * gridInvCellH));

        if (col >= 0 && row >= 0 && u32(col) < gridCols && u32(row) < gridRows) {
          let cellIndex = u32(row) * gridCols + u32(col);

          let range = getLookupGridCandidateRange(packedTerrain, lookupGridOffset, cellIndex);
          for (var c = range.x; c < range.y; c++) {
            let candidateIdx = getLookupGridCandidate(packedTerrain, lookupGridOffset, c);
            if (isInsideContour(worldPos, candidateIdx, packedTerrain)) {
              deepestIndex = i32(candidateIdx);
              break;
            }
          }

          if (deepestIndex < 0) {
            let base = getLookupGridBaseContour(packedTerrain, lookupGridOffset, cellIndex);
            if (base != 0xFFFFFFFFu) {
              deepestIndex = i32(base);
            }
          }
        }
      } else {
        // DFS skip traversal fallback
        var deepestDepth: u32 = 0u;
        var i: u32 = 0u;
        var lastToCheck: u32 = contourCount;

        while (i < lastToCheck) {
          let contour = getContourData(packedTerrain, i);

          if (isInsideContour(worldPos, i, packedTerrain)) {
            if (contour.depth >= deepestDepth) {
              deepestDepth = contour.depth;
              deepestIndex = i32(i);
            }
            lastToCheck = i + contour.skipCount + 1u;
            i += 1u;
          } else {
            i += contour.skipCount + 1u;
          }
        }
      }

      // Phase 2: If not inside any contour, return default depth with zero gradient
      if (deepestIndex < 0) {
        result.height = defaultDepth;
        result.gradientX = 0.0;
        result.gradientY = 0.0;
        return result;
      }

      let parent = getContourData(packedTerrain, u32(deepestIndex));

      // Phase 3: If the parent has no children, height is constant — zero gradient
      if (parent.childCount == 0u) {
        result.height = parent.height;
        result.gradientX = 0.0;
        result.gradientY = 0.0;
        return result;
      }

      // Phase 4: IDW interpolation with analytical gradient
      let gridBase = parent.idwGridDataOffset;
      if (gridBase == 0u) {
        // Fallback: no IDW grid — linear scan
        var weightSum: f32 = 0.0;
        var weightedHeightSum: f32 = 0.0;
        var gradWeightSumX: f32 = 0.0;
        var gradWeightSumY: f32 = 0.0;
        var gradWeightedHeightSumX: f32 = 0.0;
        var gradWeightedHeightSumY: f32 = 0.0;

        let parentBdg = computeDistanceToBoundaryWithGradient(worldPos, u32(deepestIndex), packedTerrain);
        var weight: f32;
        var gradWeightX: f32 = 0.0;
        var gradWeightY: f32 = 0.0;
        if (parentBdg.distance <= _IDW_MIN_DIST) {
          weight = 1.0 / _IDW_MIN_DIST;
          let scale = -1.0 / (_IDW_MIN_DIST * _IDW_MIN_DIST);
          gradWeightX = scale * parentBdg.gradientX;
          gradWeightY = scale * parentBdg.gradientY;
        } else {
          let invDist = 1.0 / parentBdg.distance;
          weight = invDist;
          let scale = -invDist * invDist;
          gradWeightX = scale * parentBdg.gradientX;
          gradWeightY = scale * parentBdg.gradientY;
        }
        weightSum += weight;
        weightedHeightSum += parent.height * weight;
        gradWeightSumX += gradWeightX;
        gradWeightSumY += gradWeightY;
        gradWeightedHeightSumX += parent.height * gradWeightX;
        gradWeightedHeightSumY += parent.height * gradWeightY;

        for (var c: u32 = 0u; c < parent.childCount; c++) {
          let childIndex = getTerrainChild(packedTerrain, parent.childStartIndex + c);
          let child = getContourData(packedTerrain, childIndex);
          let childBdg = computeDistanceToBoundaryWithGradient(worldPos, childIndex, packedTerrain);
          var cWeight: f32;
          var cGradWeightX: f32 = 0.0;
          var cGradWeightY: f32 = 0.0;
          if (childBdg.distance <= _IDW_MIN_DIST) {
            cWeight = 1.0 / _IDW_MIN_DIST;
            let cScale = -1.0 / (_IDW_MIN_DIST * _IDW_MIN_DIST);
            cGradWeightX = cScale * childBdg.gradientX;
            cGradWeightY = cScale * childBdg.gradientY;
          } else {
            let cInvDist = 1.0 / childBdg.distance;
            cWeight = cInvDist;
            let cScale = -cInvDist * cInvDist;
            cGradWeightX = cScale * childBdg.gradientX;
            cGradWeightY = cScale * childBdg.gradientY;
          }
          weightSum += cWeight;
          weightedHeightSum += child.height * cWeight;
          gradWeightSumX += cGradWeightX;
          gradWeightSumY += cGradWeightY;
          gradWeightedHeightSumX += child.height * cGradWeightX;
          gradWeightedHeightSumY += child.height * cGradWeightY;
        }

        let invWeightSum = 1.0 / weightSum;
        let invWeightSumSq = invWeightSum * invWeightSum;
        result.height = weightedHeightSum * invWeightSum;
        result.gradientX = (gradWeightedHeightSumX * weightSum - weightedHeightSum * gradWeightSumX) * invWeightSumSq;
        result.gradientY = (gradWeightedHeightSumY * weightSum - weightedHeightSum * gradWeightSumY) * invWeightSumSq;
        return result;
      }

      // Grid-accelerated IDW with gradient
      let bboxW = parent.bboxMaxX - parent.bboxMinX;
      let bboxH = parent.bboxMaxY - parent.bboxMinY;
      let col = u32(clamp(floor((worldPos.x - parent.bboxMinX) * (${IDW_GRID_SIZE}.0 / bboxW)), 0.0, ${IDW_GRID_SIZE - 1}.0));
      let row = u32(clamp(floor((worldPos.y - parent.bboxMinY) * (${IDW_GRID_SIZE}.0 / bboxH)), 0.0, ${IDW_GRID_SIZE - 1}.0));
      let cellIdx = row * ${IDW_GRID_SIZE}u + col;

      let range = getIDWGridCandidateRange(packedTerrain, gridBase, cellIdx);

      let contourCount2 = 1u + parent.childCount;
      var bestDistSq: array<f32, ${MAX_IDW_CONTOURS}>;
      var bestDx: array<f32, ${MAX_IDW_CONTOURS}>;
      var bestDy: array<f32, ${MAX_IDW_CONTOURS}>;
      for (var t = 0u; t < contourCount2; t++) {
        bestDistSq[t] = 1e20;
        bestDx[t] = 0.0;
        bestDy[t] = 0.0;
      }

      let contoursBase = (*packedTerrain)[1u];

      for (var e = range.x; e < range.y; e++) {
        let packed_entry = getIDWGridEntry(packedTerrain, gridBase, e);
        let tag = packed_entry >> 16u;
        let edgeIdx = packed_entry & 0xFFFFu;

        var cIdx: u32;
        if (tag == 0u) { cIdx = u32(deepestIndex); }
        else { cIdx = getTerrainChild(packedTerrain, parent.childStartIndex + tag - 1u); }

        let cBase = contoursBase + cIdx * ${FLOATS_PER_CONTOUR}u;
        let pStart = (*packedTerrain)[cBase];
        let pCount = (*packedTerrain)[cBase + 1u];

        let a = getTerrainVertex(packedTerrain, pStart + edgeIdx);
        let b = getTerrainVertex(packedTerrain, pStart + ((edgeIdx + 1u) % pCount));

        // Compute distance and gradient direction to nearest point on edge
        let ab = b - a;
        let lengthSq = dot(ab, ab);
        var dx: f32;
        var dy: f32;
        var distSq: f32;
        if (lengthSq == 0.0) {
          dx = worldPos.x - a.x;
          dy = worldPos.y - a.y;
          distSq = dx * dx + dy * dy;
        } else {
          let t2 = clamp(dot(worldPos - a, ab) / lengthSq, 0.0, 1.0);
          let nearest = a + t2 * ab;
          dx = worldPos.x - nearest.x;
          dy = worldPos.y - nearest.y;
          distSq = dx * dx + dy * dy;
        }

        if (distSq < bestDistSq[tag]) {
          bestDistSq[tag] = distSq;
          bestDx[tag] = dx;
          bestDy[tag] = dy;
        }
      }

      // IDW blend with gradient using quotient rule
      var gWeightSum: f32 = 0.0;
      var gWeightedHeightSum: f32 = 0.0;
      var gGradWeightSumX: f32 = 0.0;
      var gGradWeightSumY: f32 = 0.0;
      var gGradWHSumX: f32 = 0.0;
      var gGradWHSumY: f32 = 0.0;

      for (var c2: u32 = 0u; c2 < contourCount2; c2++) {
        var height: f32;
        if (c2 == 0u) {
          height = parent.height;
        } else {
          let childIdx = getTerrainChild(packedTerrain, parent.childStartIndex + c2 - 1u);
          let child = getContourData(packedTerrain, childIdx);
          height = child.height;
        }

        let dist = sqrt(bestDistSq[c2]);
        var w: f32;
        var gwx: f32 = 0.0;
        var gwy: f32 = 0.0;
        if (dist <= _IDW_MIN_DIST) {
          w = 1.0 / _IDW_MIN_DIST;
          // Use clamped distance for gradient magnitude, keep direction
          if (dist > 1e-9) {
            let invD = 1.0 / dist;
            let gradDx = bestDx[c2] * invD;
            let gradDy = bestDy[c2] * invD;
            let scale = -1.0 / (_IDW_MIN_DIST * _IDW_MIN_DIST);
            gwx = scale * gradDx;
            gwy = scale * gradDy;
          }
        } else {
          let invD = 1.0 / dist;
          w = invD;
          // Gradient of distance = unit direction from nearest boundary point
          let gradDx = bestDx[c2] * invD;
          let gradDy = bestDy[c2] * invD;
          // Gradient of weight = -1/d² * grad(d)
          let scale = -invD * invD;
          gwx = scale * gradDx;
          gwy = scale * gradDy;
        }
        gWeightSum += w;
        gWeightedHeightSum += height * w;
        gGradWeightSumX += gwx;
        gGradWeightSumY += gwy;
        gGradWHSumX += height * gwx;
        gGradWHSumY += height * gwy;
      }

      let invWS = 1.0 / gWeightSum;
      let invWSSq = invWS * invWS;
      result.height = gWeightedHeightSum * invWS;
      result.gradientX = (gGradWHSumX * gWeightSum - gWeightedHeightSum * gGradWeightSumX) * invWSSq;
      result.gradientY = (gGradWHSumY * gWeightSum - gWeightedHeightSum * gGradWeightSumY) * invWSSq;
      return result;
    }
  `,
  dependencies: [
    fn_isInsideContour,
    fn_computeDistanceToBoundaryWithGradient,
    fn_pointToLineSegmentDistanceSq,
    fn_getContourData,
    fn_getTerrainChild,
    fn_getTerrainVertex,
    fn_getIDWGridCandidateRange,
    fn_getIDWGridEntry,
    fn_getLookupGridBaseContour,
    fn_getLookupGridCandidateRange,
    fn_getLookupGridCandidate,
  ],
};

/**
 * Estimate terrain normal using finite differences.
 *
 * Dependencies: fn_computeTerrainHeight
 */
export const fn_computeTerrainNormal: ShaderModule = {
  code: /*wgsl*/ `
    fn computeTerrainNormal(
      worldPos: vec2<f32>,
      packedTerrain: ptr<storage, array<u32>, read>,
      contourCount: u32,
      defaultDepth: f32
    ) -> vec2<f32> {
      let h = 1.0; // Sample offset
      let hCenter = computeTerrainHeight(worldPos, packedTerrain, contourCount, defaultDepth);
      let hRight = computeTerrainHeight(worldPos + vec2<f32>(h, 0.0), packedTerrain, contourCount, defaultDepth);
      let hUp = computeTerrainHeight(worldPos + vec2<f32>(0.0, h), packedTerrain, contourCount, defaultDepth);

      let dx = hRight - hCenter;
      let dy = hUp - hCenter;

      // Normal from gradient (pointing up from surface)
      let normal3d = normalize(vec3<f32>(-dx, -dy, h));
      return vec2<f32>(normal3d.x, normal3d.y);
    }
  `,
  dependencies: [fn_computeTerrainHeight],
};
