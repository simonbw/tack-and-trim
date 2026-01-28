/**
 * TerrainInfo class (stub for editor compatibility).
 * Provides terrain height queries using a containment tree.
 * This is a temporary stub while the new TerrainSystem is being implemented.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { Game } from "../../../core/Game";
import { V2d } from "../../../core/Vector";
import { sampleClosedSpline } from "../../../core/util/Spline";
import { pointInPolygon } from "../../../core/util/Geometry";
import {
  TerrainContour,
  TerrainDefinition,
} from "../../world/terrain/TerrainTypes";

/**
 * Node in the terrain containment tree.
 */
interface ContourNode {
  contour: TerrainContour;
  polygon: V2d[]; // Sampled points for fast point-in-polygon tests
  children: ContourNode[];
  parent: ContourNode | null;
}

/**
 * Entity that manages terrain data and provides height queries.
 * Uses a containment tree for efficient point-in-contour tests.
 */
export class TerrainInfo extends BaseEntity {
  private contours: TerrainContour[];
  private defaultDepth: number;
  private containmentTree: ContourNode[] = []; // Root nodes

  constructor(contours: TerrainContour[], defaultDepth: number = -50) {
    super();
    this.id = "terrainInfo";
    this.contours = contours;
    this.defaultDepth = defaultDepth;
    this.buildContainmentTree();
  }

  /**
   * Update terrain definition and rebuild containment tree.
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.contours = [...definition.contours];
    this.defaultDepth = definition.defaultDepth;
    this.buildContainmentTree();
  }

  /**
   * Get terrain height at a point.
   * Returns the height of the deepest contour containing the point.
   */
  getHeightAtPoint(point: V2d): number {
    const node = this.findDeepestContaining(point, this.containmentTree);
    return node ? node.contour.height : this.defaultDepth;
  }

  /**
   * Build the containment tree from the contours.
   */
  private buildContainmentTree(): void {
    // Sample all contours into polygons for fast tests
    const nodes: ContourNode[] = this.contours.map((contour) => ({
      contour,
      polygon: sampleClosedSpline(contour.controlPoints, 2.0),
      children: [],
      parent: null,
    }));

    // Sort by bounding box area (smaller = more specific = child)
    nodes.sort((a, b) => {
      const areaA = this.computeBoundingBoxArea(a.polygon);
      const areaB = this.computeBoundingBoxArea(b.polygon);
      return areaA - areaB;
    });

    // Build containment hierarchy
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];

      // Find the smallest contour that contains this one
      for (let j = i + 1; j < nodes.length; j++) {
        const candidateParent = nodes[j];

        // Check if candidateParent contains node
        if (
          this.isContourInsideContour(node.polygon, candidateParent.polygon)
        ) {
          node.parent = candidateParent;
          candidateParent.children.push(node);
          break;
        }
      }
    }

    // Extract root nodes (those with no parent)
    this.containmentTree = nodes.filter((n) => n.parent === null);
  }

  /**
   * Find the deepest contour node containing a point.
   */
  private findDeepestContaining(
    point: V2d,
    nodes: ContourNode[],
  ): ContourNode | null {
    for (const node of nodes) {
      if (pointInPolygon(point, node.polygon)) {
        // Check if a child contains it (go deeper)
        const deeperNode = this.findDeepestContaining(point, node.children);
        return deeperNode || node;
      }
    }
    return null;
  }

  /**
   * Check if one contour is inside another.
   */
  private isContourInsideContour(inner: V2d[], outer: V2d[]): boolean {
    // Sample a few points from inner and check if they're all in outer
    for (
      let i = 0;
      i < Math.min(4, inner.length);
      i += Math.floor(inner.length / 4) || 1
    ) {
      if (!pointInPolygon(inner[i], outer)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Compute bounding box area.
   */
  private computeBoundingBoxArea(polygon: V2d[]): number {
    if (polygon.length === 0) return 0;

    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;

    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    return (maxX - minX) * (maxY - minY);
  }

  /**
   * Get the TerrainInfo from a Game instance, if present.
   */
  static maybeFromGame(game: Game): TerrainInfo | undefined {
    const terrainInfo = game.entities.getById("terrainInfo");
    return terrainInfo instanceof TerrainInfo ? terrainInfo : undefined;
  }
}
