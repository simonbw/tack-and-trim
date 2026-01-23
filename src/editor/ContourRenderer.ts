/**
 * Contour renderer for the editor.
 *
 * Renders the editable contour visualization including:
 * - Catmull-Rom spline curves for each contour
 * - Control points as circles (filled if selected, outlined if not)
 * - Connecting lines between control points
 * - Color-coded by height (blue=underwater, green=shore, brown=elevated)
 * - Highlight hovered elements
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { Draw } from "../core/graphics/Draw";
import { V, V2d } from "../core/Vector";
import { EditorDocument } from "./EditorDocument";
import { EditorContour } from "./io/TerrainFileFormat";

/** Base radius for control points (in world units) */
const POINT_RADIUS = 8;

/** Minimum point radius at max zoom out */
const MIN_POINT_RADIUS = 4;

/** Maximum point radius at max zoom in */
const MAX_POINT_RADIUS = 16;

/** Line width for spline curves */
const SPLINE_WIDTH = 2;

/** Line width for control point connections */
const CONNECTION_WIDTH = 1;

/** Alpha for connection lines */
const CONNECTION_ALPHA = 0.4;

/** Color for selected elements */
const SELECTED_COLOR = 0xffff00;

/** Color for hovered elements */
const HOVER_COLOR = 0x00ffff;

/**
 * Get contour color based on height.
 */
function getContourColor(height: number): number {
  if (height === 0) {
    // Shore level - green
    return 0x44aa44;
  } else if (height < 0) {
    // Underwater - blue, darker for deeper
    const t = Math.min(-height / 50, 1);
    const r = Math.round(50 * (1 - t));
    const g = Math.round(100 + 50 * (1 - t));
    const b = Math.round(180 + 75 * (1 - t));
    return (r << 16) | (g << 8) | b;
  } else {
    // Above water - brown/tan, lighter for higher
    const t = Math.min(height / 20, 1);
    const r = Math.round(140 + 60 * t);
    const g = Math.round(100 + 40 * t);
    const b = Math.round(60 + 20 * t);
    return (r << 16) | (g << 8) | b;
  }
}

/**
 * Evaluate a Catmull-Rom spline point.
 */
function catmullRomPoint(p0: V2d, p1: V2d, p2: V2d, p3: V2d, t: number): V2d {
  const t2 = t * t;
  const t3 = t2 * t;

  const x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

  return V(x, y);
}

export interface HoverInfo {
  /** Index of hovered contour */
  contourIndex: number;
  /** Index of hovered point, or null if hovering over spline */
  pointIndex: number | null;
  /** World position of hover */
  worldPosition: V2d;
  /** If hovering spline, the segment index and t parameter for insertion */
  splineSegment?: { segmentIndex: number; t: number };
}

export class ContourRenderer extends BaseEntity {
  layer = "main" as const;

  private document: EditorDocument;
  private hoverInfo: HoverInfo | null = null;

  constructor(document: EditorDocument) {
    super();
    this.document = document;
  }

  setHoverInfo(info: HoverInfo | null): void {
    this.hoverInfo = info;
  }

  getHoverInfo(): HoverInfo | null {
    return this.hoverInfo;
  }

  /**
   * Get the point radius adjusted for current zoom level.
   */
  private getPointRadius(): number {
    const zoom = this.game.camera.z;
    const radius = POINT_RADIUS / zoom;
    return Math.max(
      MIN_POINT_RADIUS / zoom,
      Math.min(MAX_POINT_RADIUS / zoom, radius),
    );
  }

  /**
   * Hit test a point against all control points.
   */
  hitTestPoint(
    worldPos: V2d,
  ): { contourIndex: number; pointIndex: number } | null {
    const radius = this.getPointRadius() * 1.5; // Slightly larger hit area
    const radiusSq = radius * radius;
    const contours = this.document.getContours();

    for (let ci = 0; ci < contours.length; ci++) {
      const contour = contours[ci];
      for (let pi = 0; pi < contour.controlPoints.length; pi++) {
        const pt = contour.controlPoints[pi];
        const dx = worldPos.x - pt.x;
        const dy = worldPos.y - pt.y;
        if (dx * dx + dy * dy <= radiusSq) {
          return { contourIndex: ci, pointIndex: pi };
        }
      }
    }

    return null;
  }

  /**
   * Hit test against spline segments for point insertion.
   */
  hitTestSpline(worldPos: V2d): {
    contourIndex: number;
    segmentIndex: number;
    t: number;
    position: V2d;
  } | null {
    const contours = this.document.getContours();
    const hitDistance = this.getPointRadius() * 2;
    let bestHit: {
      contourIndex: number;
      segmentIndex: number;
      t: number;
      position: V2d;
      distance: number;
    } | null = null;

    for (let ci = 0; ci < contours.length; ci++) {
      const contour = contours[ci];
      const points = contour.controlPoints;
      if (points.length < 3) continue;

      const n = points.length;

      // Check each segment
      for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];

        // Sample the segment
        const samples = 10;
        for (let j = 0; j <= samples; j++) {
          const t = j / samples;
          const splinePos = catmullRomPoint(p0, p1, p2, p3, t);
          const dx = worldPos.x - splinePos.x;
          const dy = worldPos.y - splinePos.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < hitDistance && (!bestHit || dist < bestHit.distance)) {
            bestHit = {
              contourIndex: ci,
              segmentIndex: i,
              t,
              position: splinePos,
              distance: dist,
            };
          }
        }
      }
    }

    if (bestHit) {
      return {
        contourIndex: bestHit.contourIndex,
        segmentIndex: bestHit.segmentIndex,
        t: bestHit.t,
        position: bestHit.position,
      };
    }

    return null;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    const contours = this.document.getContours();
    const selection = this.document.getSelection();
    const pointRadius = this.getPointRadius();

    // Draw each contour
    for (let ci = 0; ci < contours.length; ci++) {
      const contour = contours[ci];
      const isContourSelected = selection.contourIndex === ci;

      this.renderContour(
        draw,
        contour,
        ci,
        pointRadius,
        isContourSelected,
        selection.pointIndices,
      );
    }

    // Draw hover point indicator for spline insertion
    if (this.hoverInfo?.splineSegment && this.hoverInfo.pointIndex === null) {
      draw.fillCircle(
        this.hoverInfo.worldPosition.x,
        this.hoverInfo.worldPosition.y,
        pointRadius * 0.7,
        { color: HOVER_COLOR, alpha: 0.8 },
      );
    }
  }

  private renderContour(
    draw: Draw,
    contour: EditorContour,
    contourIndex: number,
    pointRadius: number,
    isContourSelected: boolean,
    selectedPoints: Set<number>,
  ): void {
    const points = contour.controlPoints;
    if (points.length < 2) return;

    const baseColor = getContourColor(contour.height);
    const splineColor = isContourSelected ? SELECTED_COLOR : baseColor;

    // Draw smoothed spline
    if (points.length >= 3) {
      draw.strokeSmoothPolygon([...points], {
        color: splineColor,
        width: SPLINE_WIDTH,
        alpha: isContourSelected ? 1.0 : 0.8,
      });
    } else {
      // Just draw a line for 2 points
      draw.line(points[0].x, points[0].y, points[1].x, points[1].y, {
        width: SPLINE_WIDTH,
        color: splineColor,
      });
    }

    // Draw connection lines between control points (dashed effect via segments)
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      draw.line(p1.x, p1.y, p2.x, p2.y, {
        width: CONNECTION_WIDTH,
        color: baseColor,
        alpha: CONNECTION_ALPHA,
      });
    }

    // Draw control points
    for (let pi = 0; pi < points.length; pi++) {
      const pt = points[pi];
      const isSelected = isContourSelected && selectedPoints.has(pi);
      const isHovered =
        this.hoverInfo?.contourIndex === contourIndex &&
        this.hoverInfo?.pointIndex === pi;

      let pointColor = baseColor;
      if (isSelected) {
        pointColor = SELECTED_COLOR;
      } else if (isHovered) {
        pointColor = HOVER_COLOR;
      }

      if (isSelected || isHovered) {
        // Filled circle for selected/hovered
        draw.fillCircle(pt.x, pt.y, pointRadius, {
          color: pointColor,
          alpha: 1.0,
        });
      } else {
        // Outlined circle for unselected
        draw.strokeCircle(pt.x, pt.y, pointRadius, {
          color: pointColor,
          alpha: 0.9,
        });
        // Inner fill with low alpha
        draw.fillCircle(pt.x, pt.y, pointRadius * 0.6, {
          color: pointColor,
          alpha: 0.4,
        });
      }
    }
  }
}
