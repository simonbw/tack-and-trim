/**
 * TypeScript port of the terrain-query shader math.
 *
 * Mirrors `src/game/world/shaders/terrain.wgsl.ts` (and the packed-buffer
 * accessors in `src/game/world/shaders/terrain-packed.wgsl.ts`). Kept
 * worker-safe: no DOM, no BaseEntity, no imports from outside
 * `src/game/world/`.
 *
 * This is the "slow path" port — it intentionally skips all three GPU
 * acceleration structures (per-contour containment grid, per-contour IDW
 * grid, level-wide lookup grid) and relies on:
 *   - the DFS pre-order skip-count traversal for deepest-contour lookup,
 *   - bbox rejection plus winding-number containment test,
 *   - full linear scan of parent+children edges for IDW boundary
 *     distance, and
 *   - finite-difference normals (central differences around the query
 *     point).
 *
 * Result layout matches `TerrainQueryResult.ts`:
 *   [height, normalX, normalY, terrainType]
 */

// Number of u32 elements per packed contour record. Kept as a local
// constant (rather than importing `FLOATS_PER_CONTOUR` from
// `../terrain/LandMass`) so the worker bundle doesn't pull in LandMass's
// transitive main-thread dependencies (Vector, Geometry, LevelFileFormat).
// Must stay in sync with `FLOATS_PER_CONTOUR` in LandMass.ts.
// Exported so sibling worker-side modules (water-math) can reuse it
// without pulling the main-thread-only LandMass module into the bundle.
export const FLOATS_PER_CONTOUR = 14;

// ---------------------------------------------------------------------------
// Packed-buffer layout constants (mirrors terrain-packed.wgsl.ts)
// ---------------------------------------------------------------------------
// Header:
//   [0] verticesOffset
//   [1] contoursOffset
//   [2] childrenOffset
//   [3] containmentGridOffset   (unused here)
//   [4] idwGridDataOffset       (unused here)
//   [5] lookupGridOffset        (unused here)
//
// ContourData (FLOATS_PER_CONTOUR = 14 u32s per contour):
//   [ 0] pointStartIndex  u32
//   [ 1] pointCount       u32
//   [ 2] height           f32
//   [ 3] parentIndex      i32
//   [ 4] depth            u32
//   [ 5] childStartIndex  u32
//   [ 6] childCount       u32
//   [ 7] isCoastline      u32
//   [ 8] bboxMinX         f32
//   [ 9] bboxMinY         f32
//   [10] bboxMaxX         f32
//   [11] bboxMaxY         f32
//   [12] skipCount        u32
//   [13] idwGridDataOffset u32  (unused here)

const HEADER_VERTICES_OFFSET = 0;
const HEADER_CONTOURS_OFFSET = 1;
const HEADER_CHILDREN_OFFSET = 2;

const CONTOUR_POINT_START = 0;
const CONTOUR_POINT_COUNT = 1;
const CONTOUR_HEIGHT = 2;
// const CONTOUR_PARENT = 3; // unused
const CONTOUR_DEPTH = 4;
const CONTOUR_CHILD_START = 5;
const CONTOUR_CHILD_COUNT = 6;
// const CONTOUR_IS_COASTLINE = 7; // (unused: terrainType derived from height sign to match GPU)
const CONTOUR_BBOX_MIN_X = 8;
const CONTOUR_BBOX_MIN_Y = 9;
const CONTOUR_BBOX_MAX_X = 10;
const CONTOUR_BBOX_MAX_Y = 11;
const CONTOUR_SKIP_COUNT = 12;

// Minimum distance for IDW weighting, matches `_IDW_MIN_DIST` in WGSL.
const IDW_MIN_DIST = 0.1;

// Normal z-axis weight when converting the analytical gradient into a
// 3-space normal. Matches `normalize(vec3<f32>(-gx, -gy, 1.0))` in
// TerrainQueryShader.ts.
const NORMAL_Z = 1.0;

// ---------------------------------------------------------------------------
// Float view cache. The WGSL reads f32 fields via `bitcast<f32>()` from the
// same u32 buffer; in JS we mirror this by keeping a Float32Array view over
// the same ArrayBuffer. Since `packed` can be a fresh buffer each frame in
// theory, we cache a single Float32Array tied to the last seen buffer so
// the worker doesn't reallocate per call.
// ---------------------------------------------------------------------------
let _cachedU32: Uint32Array | null = null;
let _cachedF32: Float32Array | null = null;

function floatsOf(packed: Uint32Array): Float32Array {
  if (_cachedU32 !== packed) {
    _cachedU32 = packed;
    _cachedF32 = new Float32Array(
      packed.buffer,
      packed.byteOffset,
      packed.length,
    );
  }
  return _cachedF32!;
}

// ---------------------------------------------------------------------------
// Helpers that mirror the WGSL accessors in terrain-packed.wgsl.ts.
// Each is private to this module; callers use `writeTerrainResult`.
// ---------------------------------------------------------------------------

function contourBase(packed: Uint32Array, contourIndex: number): number {
  // let offset = (*packed)[1u]; // contoursOffset
  // let base = offset + contourIndex * FLOATS_PER_CONTOUR;
  return packed[HEADER_CONTOURS_OFFSET] + contourIndex * FLOATS_PER_CONTOUR;
}

function getVertexX(
  packed: Uint32Array,
  f32View: Float32Array,
  vertexIndex: number,
): number {
  // fn getTerrainVertex: base = verticesOffset + index * 2u; x = bitcast<f32>(…[base]);
  const base = packed[HEADER_VERTICES_OFFSET] + vertexIndex * 2;
  return f32View[base];
}

function getVertexY(
  packed: Uint32Array,
  f32View: Float32Array,
  vertexIndex: number,
): number {
  const base = packed[HEADER_VERTICES_OFFSET] + vertexIndex * 2;
  return f32View[base + 1];
}

function getChildIndex(packed: Uint32Array, childListIndex: number): number {
  // fn getTerrainChild: return (*packed)[childrenOffset + index];
  return packed[packed[HEADER_CHILDREN_OFFSET] + childListIndex];
}

// ---------------------------------------------------------------------------
// Containment test (slow path — bbox + winding only, no containment grid).
// Mirrors fn_isInsideContour but drops the containment-grid fast path.
// ---------------------------------------------------------------------------
function isInsideContour(
  worldX: number,
  worldY: number,
  contourIndex: number,
  packed: Uint32Array,
  f32View: Float32Array,
): boolean {
  const cBase = contourBase(packed, contourIndex);

  // let c = getContourData(...);  bbox fields
  const bboxMinX = f32View[cBase + CONTOUR_BBOX_MIN_X];
  const bboxMinY = f32View[cBase + CONTOUR_BBOX_MIN_Y];
  const bboxMaxX = f32View[cBase + CONTOUR_BBOX_MAX_X];
  const bboxMaxY = f32View[cBase + CONTOUR_BBOX_MAX_Y];
  const bboxW = bboxMaxX - bboxMinX;
  const bboxH = bboxMaxY - bboxMinY;

  // if (worldPos.x < c.bboxMinX || … || bboxW <= 0 || bboxH <= 0) return false;
  if (
    worldX < bboxMinX ||
    worldX > bboxMaxX ||
    worldY < bboxMinY ||
    worldY > bboxMaxY ||
    bboxW <= 0.0 ||
    bboxH <= 0.0
  ) {
    return false;
  }

  // Skip containment-grid fast path (task spec: slow path only).
  // Fall through to the winding test.

  const n = packed[cBase + CONTOUR_POINT_COUNT];
  const start = packed[cBase + CONTOUR_POINT_START];

  let windingNumber = 0;

  // for (var i = 0; i < n; i++) { a = vert[start+i]; b = vert[start+(i+1)%n]; ... }
  for (let i = 0; i < n; i++) {
    const ai = start + i;
    const bi = start + ((i + 1) % n);
    const ax = getVertexX(packed, f32View, ai);
    const ay = getVertexY(packed, f32View, ai);
    const bx = getVertexX(packed, f32View, bi);
    const by = getVertexY(packed, f32View, bi);

    // WGSL: pointLeftOfSegment(a, b, p) = (b.x-a.x)*(p.y-a.y) - (p.x-a.x)*(b.y-a.y)
    if (ay <= worldY) {
      if (by > worldY) {
        const cross = (bx - ax) * (worldY - ay) - (worldX - ax) * (by - ay);
        if (cross > 0) windingNumber += 1;
      }
    } else {
      if (by <= worldY) {
        const cross = (bx - ax) * (worldY - ay) - (worldX - ax) * (by - ay);
        if (cross < 0) windingNumber -= 1;
      }
    }
  }

  return windingNumber !== 0;
}

// ---------------------------------------------------------------------------
// Distance to contour boundary + analytical gradient (slow path, linear
// scan). Mirrors fn_computeDistanceToBoundaryWithGradient.
//
// Writes three scalars into `out`: [distance, gradientX, gradientY]. The
// gradient is the unit vector from the nearest boundary point toward
// `worldPos` (i.e., grad of `distance` w.r.t. worldPos). Returns (0, 0)
// for the gradient if distance is effectively zero, matching the WGSL
// `distance > 1e-9` guard.
// ---------------------------------------------------------------------------
const _boundaryDistGrad: Float64Array = new Float64Array(3);

function computeDistanceToBoundaryWithGradient(
  worldX: number,
  worldY: number,
  contourIndex: number,
  packed: Uint32Array,
  f32View: Float32Array,
): void {
  const cBase = contourBase(packed, contourIndex);
  const n = packed[cBase + CONTOUR_POINT_COUNT];
  const start = packed[cBase + CONTOUR_POINT_START];

  let minDistSq = 1e20;
  let bestDx = 0;
  let bestDy = 0;

  for (let i = 0; i < n; i++) {
    const ai = start + i;
    const bi = start + ((i + 1) % n);
    const ax = getVertexX(packed, f32View, ai);
    const ay = getVertexY(packed, f32View, ai);
    const bx = getVertexX(packed, f32View, bi);
    const by = getVertexY(packed, f32View, bi);

    const abx = bx - ax;
    const aby = by - ay;
    const lengthSq = abx * abx + aby * aby;
    let dx: number;
    let dy: number;
    if (lengthSq === 0) {
      dx = worldX - ax;
      dy = worldY - ay;
    } else {
      let t = ((worldX - ax) * abx + (worldY - ay) * aby) / lengthSq;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const nearestX = ax + t * abx;
      const nearestY = ay + t * aby;
      dx = worldX - nearestX;
      dy = worldY - nearestY;
    }

    const distSq = dx * dx + dy * dy;
    if (distSq < minDistSq) {
      minDistSq = distSq;
      bestDx = dx;
      bestDy = dy;
    }
  }

  const distance = Math.sqrt(minDistSq);
  _boundaryDistGrad[0] = distance;
  if (distance > 1e-9) {
    const invDist = 1 / distance;
    _boundaryDistGrad[1] = bestDx * invDist;
    _boundaryDistGrad[2] = bestDy * invDist;
  } else {
    _boundaryDistGrad[1] = 0;
    _boundaryDistGrad[2] = 0;
  }
}

// ---------------------------------------------------------------------------
// Find deepest-containing contour by DFS skip traversal.
// Mirrors the `else` branch in fn_computeTerrainHeight (no lookup grid).
// Returns contour DFS index, or -1 if none contain the point.
// ---------------------------------------------------------------------------
function findDeepestContainingContour(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  f32View: Float32Array,
  contourCount: number,
): number {
  let deepestIndex = -1;
  let deepestDepth = 0;
  let i = 0;
  let lastToCheck = contourCount;

  // while (i < lastToCheck) { if inside → record, narrow, step; else skip subtree }
  while (i < lastToCheck) {
    const cBase = contourBase(packed, i);
    const skipCount = packed[cBase + CONTOUR_SKIP_COUNT];

    if (isInsideContour(worldX, worldY, i, packed, f32View)) {
      const depth = packed[cBase + CONTOUR_DEPTH];
      if (depth >= deepestDepth) {
        deepestDepth = depth;
        deepestIndex = i;
      }
      lastToCheck = i + skipCount + 1;
      i += 1;
    } else {
      i += skipCount + 1;
    }
  }

  return deepestIndex;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute terrain height + analytical gradient + terrain type at the
 * given world point and write them into `results` at
 * `resultOffset..resultOffset+3`.
 *
 * Layout: [height, normalX, normalY, terrainType].
 *
 * Mirrors the compute shader entry point in `TerrainQueryShader.ts`,
 * which:
 *   1. Calls `computeTerrainHeightAndGradient` (analytical IDW gradient
 *      via quotient rule), then
 *   2. Converts the gradient to a normal via `normalize(-gx, -gy, 1)`
 *      — or returns (0, 0) when the gradient is effectively zero.
 *
 * The CPU port follows the same structure but takes the "fallback: no
 * IDW grid" branch of the WGSL (linear scan over contour + children),
 * since the CPU path deliberately skips the GPU's IDW grid acceleration.
 * The math is otherwise identical, so results should agree to f32
 * precision.
 */
export function writeTerrainResult(
  worldX: number,
  worldY: number,
  packed: Uint32Array,
  contourCount: number,
  defaultDepth: number,
  results: Float32Array,
  resultOffset: number,
): void {
  const f32View = floatsOf(packed);

  // Phase 1: find deepest containing contour.
  const deepestIndex = findDeepestContainingContour(
    worldX,
    worldY,
    packed,
    f32View,
    contourCount,
  );

  let height: number;
  let gradientX: number;
  let gradientY: number;

  if (deepestIndex < 0) {
    // Phase 2: no containing contour → default depth, zero gradient.
    height = defaultDepth;
    gradientX = 0;
    gradientY = 0;
  } else {
    const parentBase = contourBase(packed, deepestIndex);
    const parentHeight = f32View[parentBase + CONTOUR_HEIGHT];
    const childCount = packed[parentBase + CONTOUR_CHILD_COUNT];

    if (childCount === 0) {
      // Phase 3: constant height, no IDW → zero gradient.
      height = parentHeight;
      gradientX = 0;
      gradientY = 0;
    } else {
      // Phase 4: IDW blend between parent + children, with analytical
      // gradient via quotient rule.
      //
      //   H     = Σ h_i w_i / Σ w_i
      //   ∇H    = (Σ h_i ∇w_i · Σ w_i − Σ h_i w_i · Σ ∇w_i) / (Σ w_i)²
      //
      // Weight and its gradient per contour:
      //   d ≤ MIN_DIST:  w = 1/MIN_DIST,  ∇w = −1/MIN_DIST² · ∇d
      //   d >  MIN_DIST: w = 1/d,          ∇w = −1/d² · ∇d
      // where ∇d is the unit vector from the nearest boundary point
      // toward worldPos (filled into `_boundaryDistGrad` by the helper).
      let weightSum = 0;
      let weightedHeightSum = 0;
      let gradWeightSumX = 0;
      let gradWeightSumY = 0;
      let gradWeightedHeightSumX = 0;
      let gradWeightedHeightSumY = 0;

      const accumulate = (contourIndex: number, h: number): void => {
        computeDistanceToBoundaryWithGradient(
          worldX,
          worldY,
          contourIndex,
          packed,
          f32View,
        );
        const dist = _boundaryDistGrad[0];
        const gdx = _boundaryDistGrad[1];
        const gdy = _boundaryDistGrad[2];
        let w: number;
        let gwx: number;
        let gwy: number;
        if (dist <= IDW_MIN_DIST) {
          w = 1 / IDW_MIN_DIST;
          const scale = -1 / (IDW_MIN_DIST * IDW_MIN_DIST);
          gwx = scale * gdx;
          gwy = scale * gdy;
        } else {
          const invDist = 1 / dist;
          w = invDist;
          const scale = -invDist * invDist;
          gwx = scale * gdx;
          gwy = scale * gdy;
        }
        weightSum += w;
        weightedHeightSum += h * w;
        gradWeightSumX += gwx;
        gradWeightSumY += gwy;
        gradWeightedHeightSumX += h * gwx;
        gradWeightedHeightSumY += h * gwy;
      };

      accumulate(deepestIndex, parentHeight);

      const childStart = packed[parentBase + CONTOUR_CHILD_START];
      for (let c = 0; c < childCount; c++) {
        const childIndex = getChildIndex(packed, childStart + c);
        const childBase = contourBase(packed, childIndex);
        const childHeight = f32View[childBase + CONTOUR_HEIGHT];
        accumulate(childIndex, childHeight);
      }

      const invWeightSum = 1 / weightSum;
      const invWeightSumSq = invWeightSum * invWeightSum;
      height = weightedHeightSum * invWeightSum;
      gradientX =
        (gradWeightedHeightSumX * weightSum -
          weightedHeightSum * gradWeightSumX) *
        invWeightSumSq;
      gradientY =
        (gradWeightedHeightSumY * weightSum -
          weightedHeightSum * gradWeightSumY) *
        invWeightSumSq;
    }
  }

  // Convert gradient to normal. Matches the shader's fallback when the
  // gradient is (near-)zero: return a zero normal rather than normalising
  // a degenerate vector.
  let normalX = 0;
  let normalY = 0;
  const gradMag = Math.sqrt(gradientX * gradientX + gradientY * gradientY);
  if (gradMag > 1e-9) {
    const nx = -gradientX;
    const ny = -gradientY;
    const nz = NORMAL_Z;
    const invLen = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    normalX = nx * invLen;
    normalY = ny * invLen;
  }

  // Terrain type: 1.0 for land, 0.0 for water. Matches GPU shader
  // (TerrainQueryShader.ts: `select(0.0, 1.0, result.height >= 0.0)`).
  const terrainType = height >= 0 ? 1 : 0;

  results[resultOffset] = height;
  results[resultOffset + 1] = normalX;
  results[resultOffset + 2] = normalY;
  results[resultOffset + 3] = terrainType;
}
