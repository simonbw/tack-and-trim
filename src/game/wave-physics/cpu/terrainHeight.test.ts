/**
 * Unit tests for CPU terrain height computation.
 *
 * Run with: npx tsx --test src/game/wave-physics/cpu/terrainHeight.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeTerrainHeight,
  isInsideContour,
  computeDistanceToBoundary,
} from "./terrainHeight";
import type { TerrainDataForWorker } from "../mesh-building/MeshBuildTypes";

// =============================================================================
// Test fixture helpers
// =============================================================================

/** A simple contour definition for building test terrain data. */
interface TestContour {
  /** Polygon vertices as [x, y] pairs (CCW winding for land) */
  polygon: [number, number][];
  /** Contour height */
  height: number;
  /** Parent index in the contours array (-1 for root) */
  parentIndex: number;
  /** Child indices in the contours array */
  children: number[];
}

const FLOATS_PER_CONTOUR = 13;

/**
 * Build a TerrainDataForWorker from simple contour definitions.
 * Contours must be provided in DFS pre-order (parents before children).
 */
function buildTestTerrain(
  contours: TestContour[],
  defaultDepth: number,
): TerrainDataForWorker {
  // Count total vertices
  let totalVertices = 0;
  for (const c of contours) {
    totalVertices += c.polygon.length;
  }

  const vertexData = new Float32Array(totalVertices * 2);
  const contourBuffer = new ArrayBuffer(
    contours.length * FLOATS_PER_CONTOUR * 4,
  );
  const contourView = new DataView(contourBuffer);

  // Build children flat array
  const childStartIndices: number[] = [];
  const childrenFlat: number[] = [];
  for (let i = 0; i < contours.length; i++) {
    childStartIndices.push(childrenFlat.length);
    for (const childIdx of contours[i].children) {
      childrenFlat.push(childIdx);
    }
  }
  const childrenData = new Uint32Array(childrenFlat);

  // Compute depths (distance from root in tree)
  const depths: number[] = new Array(contours.length).fill(0);
  for (let i = 0; i < contours.length; i++) {
    if (contours[i].parentIndex >= 0) {
      depths[i] = depths[contours[i].parentIndex] + 1;
    }
  }

  // Compute skip counts (number of descendants)
  const skipCounts: number[] = new Array(contours.length).fill(0);
  for (let i = contours.length - 1; i >= 0; i--) {
    const parent = contours[i].parentIndex;
    if (parent >= 0) {
      skipCounts[parent] += skipCounts[i] + 1;
    }
  }

  // Write vertex and contour data
  let vertexIndex = 0;
  for (let i = 0; i < contours.length; i++) {
    const c = contours[i];
    const byteBase = i * FLOATS_PER_CONTOUR * 4;

    // Contour metadata
    contourView.setUint32(byteBase + 0, vertexIndex, true); // pointStartIndex
    contourView.setUint32(byteBase + 4, c.polygon.length, true); // pointCount
    contourView.setFloat32(byteBase + 8, c.height, true); // height
    contourView.setInt32(byteBase + 12, c.parentIndex, true); // parentIndex
    contourView.setUint32(byteBase + 16, depths[i], true); // depth
    contourView.setUint32(byteBase + 20, childStartIndices[i], true); // childStartIndex
    contourView.setUint32(byteBase + 24, c.children.length, true); // childCount
    contourView.setUint32(byteBase + 28, c.height === 0 ? 1 : 0, true); // isCoastline

    // Compute bbox
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const [x, y] of c.polygon) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    contourView.setFloat32(byteBase + 32, minX, true);
    contourView.setFloat32(byteBase + 36, minY, true);
    contourView.setFloat32(byteBase + 40, maxX, true);
    contourView.setFloat32(byteBase + 44, maxY, true);

    contourView.setUint32(byteBase + 48, skipCounts[i], true); // skipCount

    // Write polygon vertices
    for (const [x, y] of c.polygon) {
      vertexData[vertexIndex * 2] = x;
      vertexData[vertexIndex * 2 + 1] = y;
      vertexIndex++;
    }
  }

  return {
    vertexData,
    contourData: contourBuffer,
    childrenData,
    contourCount: contours.length,
    defaultDepth,
  };
}

/** A simple square polygon centered at (cx, cy) with half-size s. CCW winding. */
function square(cx: number, cy: number, s: number): [number, number][] {
  return [
    [cx - s, cy - s],
    [cx + s, cy - s],
    [cx + s, cy + s],
    [cx - s, cy + s],
  ];
}

// =============================================================================
// Tests
// =============================================================================

describe("buildTestTerrain helper", () => {
  it("produces valid terrain data for empty terrain", () => {
    const terrain = buildTestTerrain([], -50);
    assert.equal(terrain.contourCount, 0);
    assert.equal(terrain.defaultDepth, -50);
    assert.equal(terrain.vertexData.length, 0);
  });

  it("produces valid terrain data for a single contour", () => {
    const terrain = buildTestTerrain(
      [
        {
          polygon: square(0, 0, 100),
          height: 0,
          parentIndex: -1,
          children: [],
        },
      ],
      -50,
    );
    assert.equal(terrain.contourCount, 1);
    assert.equal(terrain.vertexData.length, 8); // 4 vertices * 2 floats
  });
});

describe("isInsideContour", () => {
  const terrain = buildTestTerrain(
    [
      {
        polygon: square(0, 0, 100),
        height: 0,
        parentIndex: -1,
        children: [],
      },
    ],
    -50,
  );

  it("returns true for points inside", () => {
    assert.equal(isInsideContour(0, 0, 0, terrain), true);
    assert.equal(isInsideContour(50, 50, 0, terrain), true);
    assert.equal(isInsideContour(-99, -99, 0, terrain), true);
  });

  it("returns false for points outside", () => {
    assert.equal(isInsideContour(200, 0, 0, terrain), false);
    assert.equal(isInsideContour(0, 200, 0, terrain), false);
    assert.equal(isInsideContour(101, 101, 0, terrain), false);
  });

  it("returns false for points outside bbox", () => {
    assert.equal(isInsideContour(500, 500, 0, terrain), false);
  });
});

describe("computeDistanceToBoundary", () => {
  const terrain = buildTestTerrain(
    [
      {
        polygon: square(0, 0, 100),
        height: 0,
        parentIndex: -1,
        children: [],
      },
    ],
    -50,
  );

  it("computes distance from center to edge", () => {
    const dist = computeDistanceToBoundary(0, 0, 0, terrain);
    assert.ok(Math.abs(dist - 100) < 0.01, `Expected ~100, got ${dist}`);
  });

  it("computes distance from near an edge", () => {
    const dist = computeDistanceToBoundary(90, 0, 0, terrain);
    assert.ok(Math.abs(dist - 10) < 0.01, `Expected ~10, got ${dist}`);
  });

  it("computes distance from outside", () => {
    const dist = computeDistanceToBoundary(110, 0, 0, terrain);
    assert.ok(Math.abs(dist - 10) < 0.01, `Expected ~10, got ${dist}`);
  });
});

describe("computeTerrainHeight", () => {
  describe("no contours (open ocean)", () => {
    const terrain = buildTestTerrain([], -50);

    it("returns defaultDepth everywhere", () => {
      assert.equal(computeTerrainHeight(0, 0, terrain), -50);
      assert.equal(computeTerrainHeight(1000, 1000, terrain), -50);
      assert.equal(computeTerrainHeight(-500, 200, terrain), -50);
    });
  });

  describe("single island (one coastline contour at height 0)", () => {
    const terrain = buildTestTerrain(
      [
        {
          polygon: square(0, 0, 100),
          height: 0,
          parentIndex: -1,
          children: [],
        },
      ],
      -50,
    );

    it("returns defaultDepth outside the island", () => {
      assert.equal(computeTerrainHeight(200, 200, terrain), -50);
      assert.equal(computeTerrainHeight(-200, 0, terrain), -50);
    });

    it("returns contour height inside (no children, so direct height)", () => {
      assert.equal(computeTerrainHeight(0, 0, terrain), 0);
      assert.equal(computeTerrainHeight(50, 50, terrain), 0);
    });
  });

  describe("nested contours (underwater shelf + island)", () => {
    // Outer contour: underwater shelf at -20ft, large square
    // Inner contour: coastline at 0ft, smaller square
    const terrain = buildTestTerrain(
      [
        {
          polygon: square(0, 0, 200),
          height: -20,
          parentIndex: -1,
          children: [1],
        },
        {
          polygon: square(0, 0, 50),
          height: 0,
          parentIndex: 0,
          children: [],
        },
      ],
      -50,
    );

    it("returns defaultDepth far outside", () => {
      assert.equal(computeTerrainHeight(500, 500, terrain), -50);
    });

    it("returns inner contour height inside inner contour", () => {
      assert.equal(computeTerrainHeight(0, 0, terrain), 0);
    });

    it("returns IDW blend between parent and child near the child boundary", () => {
      // At the midpoint between inner (50) and outer (200) edges,
      // the IDW blend should be between -20 and 0
      const h = computeTerrainHeight(125, 0, terrain);
      assert.ok(h > -20, `Expected > -20, got ${h}`);
      assert.ok(h < 0, `Expected < 0, got ${h}`);
    });

    it("returns close to parent height near parent boundary", () => {
      const h = computeTerrainHeight(190, 0, terrain);
      assert.ok(h < -10, `Expected close to -20, got ${h}`);
    });

    it("returns close to child height near child boundary", () => {
      const h = computeTerrainHeight(55, 0, terrain);
      assert.ok(h > -5, `Expected close to 0, got ${h}`);
    });
  });

  describe("multiple root contours (two islands)", () => {
    const terrain = buildTestTerrain(
      [
        {
          polygon: square(-300, 0, 50),
          height: 0,
          parentIndex: -1,
          children: [],
        },
        {
          polygon: square(300, 0, 50),
          height: 0,
          parentIndex: -1,
          children: [],
        },
      ],
      -50,
    );

    it("returns defaultDepth between islands", () => {
      assert.equal(computeTerrainHeight(0, 0, terrain), -50);
    });

    it("returns height inside first island", () => {
      assert.equal(computeTerrainHeight(-300, 0, terrain), 0);
    });

    it("returns height inside second island", () => {
      assert.equal(computeTerrainHeight(300, 0, terrain), 0);
    });
  });

  describe("deeply nested contours", () => {
    // -50 (default) -> -30 (outer shelf) -> -10 (inner shelf) -> 0 (coastline) -> +5 (hilltop)
    const terrain = buildTestTerrain(
      [
        {
          polygon: square(0, 0, 400),
          height: -30,
          parentIndex: -1,
          children: [1],
        },
        {
          polygon: square(0, 0, 200),
          height: -10,
          parentIndex: 0,
          children: [2],
        },
        {
          polygon: square(0, 0, 100),
          height: 0,
          parentIndex: 1,
          children: [3],
        },
        {
          polygon: square(0, 0, 30),
          height: 5,
          parentIndex: 2,
          children: [],
        },
      ],
      -50,
    );

    it("returns defaultDepth outside all contours", () => {
      assert.equal(computeTerrainHeight(500, 0, terrain), -50);
    });

    it("returns deepest contour height at center", () => {
      assert.equal(computeTerrainHeight(0, 0, terrain), 5);
    });

    it("returns coastline height inside coastline but outside hilltop", () => {
      // At (60, 0): inside contour 2 (r=100) but outside contour 3 (r=30)
      // Contour 2 has no children that contain this point, so direct height
      // Actually contour 2 has child 3, so it should IDW blend
      const h = computeTerrainHeight(60, 0, terrain);
      assert.ok(h >= -1, `Expected near 0, got ${h}`);
      assert.ok(h <= 5, `Expected <= 5, got ${h}`);
    });

    it("does not infinite loop or crash", () => {
      // Test many points across the domain to check for hangs
      for (let x = -500; x <= 500; x += 25) {
        for (let y = -500; y <= 500; y += 25) {
          const h = computeTerrainHeight(x, y, terrain);
          assert.ok(
            typeof h === "number" && isFinite(h),
            `Got non-finite height ${h} at (${x}, ${y})`,
          );
        }
      }
    });
  });

  describe("edge cases", () => {
    it("handles contour with 3 vertices (triangle)", () => {
      const terrain = buildTestTerrain(
        [
          {
            polygon: [
              [0, 0],
              [100, 0],
              [50, 100],
            ],
            height: 0,
            parentIndex: -1,
            children: [],
          },
        ],
        -50,
      );
      assert.equal(computeTerrainHeight(50, 30, terrain), 0);
      assert.equal(computeTerrainHeight(-50, -50, terrain), -50);
    });

    it("handles a large number of terrain queries without crashing", () => {
      const terrain = buildTestTerrain(
        [
          {
            polygon: square(0, 0, 1000),
            height: -20,
            parentIndex: -1,
            children: [1],
          },
          {
            polygon: square(0, 0, 500),
            height: 0,
            parentIndex: 0,
            children: [],
          },
        ],
        -50,
      );

      // Simulate what a builder would do: many queries across the domain
      let count = 0;
      for (let x = -1500; x <= 1500; x += 10) {
        for (let y = -1500; y <= 1500; y += 10) {
          const h = computeTerrainHeight(x, y, terrain);
          assert.ok(isFinite(h));
          count++;
        }
      }
      assert.ok(count > 10000, `Ran ${count} queries`);
    });
  });
});
