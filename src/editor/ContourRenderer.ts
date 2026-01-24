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
import { V2d } from "../core/Vector";
import { catmullRomPoint, sampleClosedSpline } from "../core/util/Spline";
import { pointInPolygon } from "../core/util/Geometry";
import { getTerrainHeightColor } from "../game/world-data/terrain/TerrainColors";
import { EditorDocument } from "./EditorDocument";
import { EditorContour } from "./io/TerrainFileFormat";

/** Base radius for control points (in world units) */
const POINT_RADIUS = 8;

/** Minimum point radius at max zoom out */
const MIN_POINT_RADIUS = 4;

/** Maximum point radius at max zoom in */
const MAX_POINT_RADIUS = 16;

/** Line width for spline curves (in screen pixels) */
const SPLINE_WIDTH = 2;

/** Line width for selected contour (multiplier) */
const SELECTED_WIDTH_MULTIPLIER = 2.5;

/** Line width for shadow outline (multiplier) */
const SHADOW_WIDTH_MULTIPLIER = 2;

/** Line width for control point connections (in screen pixels) */
const CONNECTION_WIDTH = 1;

/** Shadow/outline color for better visibility */
const SHADOW_COLOR = 0x222222;

/** Alpha for connection lines */
const CONNECTION_ALPHA = 0.4;

/** Color for selected elements */
const SELECTED_COLOR = 0xffff00;

/** Color for hovered elements */
const HOVER_COLOR = 0x00ffff;

/** Color for invalid contours (self-intersecting or intersecting others) */
const INVALID_COLOR = 0xff4444;

/** Axis colors for origin visualization */
const AXIS_COLOR_X = 0xff4444;
const AXIS_COLOR_Y = 0x44ff44;
const AXIS_WIDTH = 1;
const AXIS_ALPHA = 0.6;

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

  /**
   * Test if a world position is inside the fill area of a contour.
   * Uses ray casting algorithm on sampled spline points.
   */
  hitTestFill(worldPos: V2d): { contourIndex: number } | null {
    const contours = this.document.getContours();

    for (let ci = 0; ci < contours.length; ci++) {
      const points = contours[ci].controlPoints;
      if (points.length < 3) continue;

      // Sample the Catmull-Rom spline to get polygon vertices
      const sampledPoints = sampleClosedSpline([...points], 8);

      if (pointInPolygon(worldPos, sampledPoints)) {
        return { contourIndex: ci };
      }
    }
    return null;
  }

  /**
   * Render origin axes for coordinate reference.
   */
  private renderAxes(draw: Draw): void {
    const camera = this.game.camera;
    const viewport = camera.getWorldViewport();
    const zoom = camera.z;
    const axisWidth = AXIS_WIDTH / zoom;

    // X axis (red)
    draw.line(viewport.left, 0, viewport.left + viewport.width, 0, {
      color: AXIS_COLOR_X,
      width: axisWidth,
      alpha: AXIS_ALPHA,
    });
    // Y axis (green)
    draw.line(0, viewport.top, 0, viewport.top + viewport.height, {
      color: AXIS_COLOR_Y,
      width: axisWidth,
      alpha: AXIS_ALPHA,
    });
    // Origin marker
    draw.fillCircle(0, 0, 8 / zoom, { color: 0xffffff, alpha: 0.8 });
  }

  @on("render")
  onRender({ draw }: { draw: Draw }): void {
    // Draw axes first (underneath contours)
    this.renderAxes(draw);

    const contours = this.document.getContours();
    const selection = this.document.getSelection();
    const pointRadius = this.getPointRadius();

    // Draw each contour
    for (let ci = 0; ci < contours.length; ci++) {
      const contour = contours[ci];
      const isContourSelected = selection.contourIndex === ci;
      const isContourValid = this.document.isContourValid(ci);

      this.renderContour(
        draw,
        contour,
        ci,
        pointRadius,
        isContourSelected,
        isContourValid,
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
    isContourValid: boolean,
    selectedPoints: Set<number>,
  ): void {
    const points = contour.controlPoints;
    if (points.length < 2) return;

    const zoom = this.game.camera.z;
    const baseColor = isContourValid
      ? getTerrainHeightColor(contour.height)
      : INVALID_COLOR;
    const splineColor = isContourSelected ? SELECTED_COLOR : baseColor;

    // Calculate zoom-independent line widths
    const splineWidth = SPLINE_WIDTH / zoom;
    const connectionWidth = CONNECTION_WIDTH / zoom;
    const shadowWidth = splineWidth * SHADOW_WIDTH_MULTIPLIER;
    const selectedWidth = splineWidth * SELECTED_WIDTH_MULTIPLIER;

    // Draw smoothed spline
    if (points.length >= 3) {
      // Pass 0: Fill for selected contour (allows drag-by-fill)
      if (isContourSelected) {
        draw.fillSmoothPolygon([...points], {
          color: splineColor,
          alpha: 0.15,
        });
      }

      // Pass 1: Shadow outline for visibility on terrain
      draw.strokeSmoothPolygon([...points], {
        color: SHADOW_COLOR,
        width: shadowWidth,
        alpha: 0.6,
      });

      // Pass 2: Selected glow (if selected)
      if (isContourSelected) {
        draw.strokeSmoothPolygon([...points], {
          color: splineColor,
          width: selectedWidth,
          alpha: 0.5,
        });
      }

      // Pass 3: Main spline
      draw.strokeSmoothPolygon([...points], {
        color: splineColor,
        width: splineWidth,
        alpha: isContourSelected ? 1.0 : 0.8,
      });
    } else {
      // Just draw a line for 2 points
      // Shadow
      draw.line(points[0].x, points[0].y, points[1].x, points[1].y, {
        width: shadowWidth,
        color: SHADOW_COLOR,
        alpha: 0.6,
      });
      // Main line
      draw.line(points[0].x, points[0].y, points[1].x, points[1].y, {
        width: isContourSelected ? selectedWidth : splineWidth,
        color: splineColor,
      });
    }

    // Draw connection lines between control points (dashed effect via segments)
    for (let i = 0; i < points.length; i++) {
      const p1 = points[i];
      const p2 = points[(i + 1) % points.length];
      draw.line(p1.x, p1.y, p2.x, p2.y, {
        width: connectionWidth,
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
