/**
 * ContainmentTree: CPU-side hierarchical contour representation for fast height lookups.
 *
 * Builds a tree structure where contours contain child contours, enabling
 * efficient point-in-polygon queries by walking the tree from roots to leaves.
 */

import { V2d } from "../../../core/Vector";
import { AABB } from "../../../core/physics/collision/AABB";
import {
  sampleClosedSpline,
  isSplineInsideSpline,
} from "../../../core/util/Spline";
import { pointInPolygon } from "../../../core/util/Geometry";
import type { TerrainContour } from "./TerrainTypes";

/**
 * Number of samples per spline segment for polygon approximation.
 * Higher values = more accurate containment tests but slower construction.
 */
const SAMPLES_PER_SEGMENT = 16;

/**
 * Tolerance for identifying coastlines (contours at approximately water level).
 */
const COASTLINE_TOLERANCE = 0.01;

/**
 * A node in the containment tree representing a terrain contour.
 */
export interface ContourNode {
  /** The original contour definition */
  readonly contour: TerrainContour;

  /** Sampled polygon approximation for fast point-in-polygon tests */
  readonly sampledPolygon: readonly V2d[];

  /** Axis-aligned bounding box for quick rejection */
  readonly aabb: AABB;

  /** Child contours contained within this contour */
  readonly children: ContourNode[];
}

/**
 * Hierarchical tree of terrain contours for efficient height queries.
 *
 * The tree is built by determining parent-child relationships between contours
 * using geometric containment tests. Height queries walk the tree from roots
 * to find the deepest containing contour.
 */
export class ContainmentTree {
  /** Root nodes of the tree (contours with no parents) */
  private readonly roots: ContourNode[];

  /** Default height/depth for points outside all contours */
  private readonly defaultDepth: number;

  /** Cached list of coastline contours (height ≈ 0) */
  private readonly coastlines: readonly TerrainContour[];

  /**
   * Build a containment tree from terrain contours.
   *
   * @param contours - Array of terrain contours to organize
   * @param defaultDepth - Height to return for points outside all contours
   */
  constructor(contours: readonly TerrainContour[], defaultDepth: number) {
    this.defaultDepth = defaultDepth;

    // Build nodes from contours
    const nodes = this.buildNodes(contours);

    // Build hierarchy
    this.roots = this.buildHierarchy(nodes);

    // Extract coastlines
    this.coastlines = contours.filter(
      (c) => Math.abs(c.height) < COASTLINE_TOLERANCE,
    );
  }

  /**
   * Get the height/depth at a specific world position.
   *
   * Walks the tree from roots to find the deepest containing contour.
   * Returns the contour's height, or defaultDepth if no contour contains the point.
   *
   * @param point - World position to query
   * @returns Height/depth value at the point
   */
  getHeightAt(point: V2d): number {
    const node = this.findDeepestContaining(point);
    return node ? node.contour.height : this.defaultDepth;
  }

  /**
   * Find the deepest contour node that contains the given point.
   *
   * Recursively descends the tree, always taking the deepest path
   * that contains the point.
   *
   * @param point - World position to query
   * @returns The deepest containing node, or null if no contour contains the point
   */
  findDeepestContaining(point: V2d): ContourNode | null {
    // Start from roots
    for (const root of this.roots) {
      const result = this.findDeepestContainingRecursive(point, root);
      if (result) {
        return result;
      }
    }
    return null;
  }

  /**
   * Get all coastline contours (height ≈ 0).
   *
   * @returns Array of contours representing the coastline
   */
  getCoastlines(): readonly TerrainContour[] {
    return this.coastlines;
  }

  /**
   * Get the root nodes of the tree.
   * Useful for debugging and visualization.
   *
   * @returns Array of root contour nodes
   */
  getRoots(): readonly ContourNode[] {
    return this.roots;
  }

  /**
   * Build contour nodes from terrain contours.
   * Each node contains the sampled polygon and AABB for efficient queries.
   */
  private buildNodes(contours: readonly TerrainContour[]): ContourNode[] {
    return contours.map((contour) => {
      // Sample the spline to a dense polygon
      const sampledPolygon = sampleClosedSpline(
        contour.controlPoints,
        SAMPLES_PER_SEGMENT,
      );

      // Compute AABB for quick rejection
      const aabb = new AABB();
      aabb.setFromPoints(sampledPolygon);

      return {
        contour,
        sampledPolygon,
        aabb,
        children: [],
      };
    });
  }

  /**
   * Build the containment hierarchy by determining parent-child relationships.
   *
   * Algorithm:
   * 1. For each node, find all nodes it's contained within
   * 2. Choose the smallest containing node as the parent
   * 3. Nodes with no parents become roots
   *
   * @param nodes - Array of contour nodes to organize
   * @returns Array of root nodes
   */
  private buildHierarchy(nodes: ContourNode[]): ContourNode[] {
    if (nodes.length === 0) {
      return [];
    }

    // For each node, find potential parents (nodes that contain it)
    const potentialParents = new Map<ContourNode, ContourNode[]>();

    for (const node of nodes) {
      const parents: ContourNode[] = [];

      for (const otherNode of nodes) {
        if (node === otherNode) continue;

        // Check if otherNode contains node
        if (
          isSplineInsideSpline(
            node.contour.controlPoints,
            otherNode.contour.controlPoints,
            SAMPLES_PER_SEGMENT,
          )
        ) {
          parents.push(otherNode);
        }
      }

      potentialParents.set(node, parents);
    }

    // For each node, choose the smallest containing node as its parent
    // (the one with the fewest other containers)
    const roots: ContourNode[] = [];

    for (const node of nodes) {
      const parents = potentialParents.get(node) || [];

      if (parents.length === 0) {
        // No parent, this is a root
        roots.push(node);
      } else {
        // Find the immediate parent (the smallest container)
        // This is the parent with the most containers (deepest in tree)
        let immediateParent = parents[0];
        let maxParentCount = (potentialParents.get(immediateParent) || [])
          .length;

        for (let i = 1; i < parents.length; i++) {
          const parentCount = (potentialParents.get(parents[i]) || []).length;
          if (parentCount > maxParentCount) {
            immediateParent = parents[i];
            maxParentCount = parentCount;
          }
        }

        // Add this node as a child of its immediate parent
        // Cast to mutable to build the tree
        (immediateParent.children as ContourNode[]).push(node);
      }
    }

    return roots;
  }

  /**
   * Recursively search for the deepest node containing the point.
   *
   * @param point - World position to query
   * @param node - Current node to test
   * @returns The deepest containing descendant, or null if this node doesn't contain the point
   */
  private findDeepestContainingRecursive(
    point: V2d,
    node: ContourNode,
  ): ContourNode | null {
    // Quick rejection using AABB
    if (!node.aabb.containsPoint(point)) {
      return null;
    }

    // Exact test using sampled polygon
    if (!pointInPolygon(point, node.sampledPolygon)) {
      return null;
    }

    // This node contains the point. Check if any children contain it.
    for (const child of node.children) {
      const result = this.findDeepestContainingRecursive(point, child);
      if (result) {
        return result; // Found a deeper match
      }
    }

    // No children contain the point, so this is the deepest
    return node;
  }
}
