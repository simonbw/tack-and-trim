/**
 * Contour editor interaction handler.
 *
 * Handles mouse interaction for editing terrain contours:
 * - Click on point: Select it
 * - Drag point: Move it (creates MovePointCommand on release)
 * - Click on spline segment: Insert new point
 * - Click empty space: Deselect
 * - Delete/Backspace: Delete selected points
 * - Shift+click: Multi-select points
 * - Escape: Deselect all
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { V, V2d } from "../core/Vector";
import { ContourRenderer } from "./ContourRenderer";
import {
  AddPointCommand,
  DeletePointsCommand,
  EditorDocument,
  MovePointsCommand,
} from "./EditorDocument";

interface DragState {
  contourIndex: number;
  /** Starting positions of all dragged points */
  startPositions: Map<number, V2d>;
  /** Initial mouse position when drag started */
  startMousePos: V2d;
  /** Whether a significant drag has occurred */
  hasMoved: boolean;
}

export class ContourEditor extends BaseEntity {
  pausable = false;

  private document: EditorDocument;
  private renderer: ContourRenderer;
  private dragState: DragState | null = null;

  constructor(document: EditorDocument, renderer: ContourRenderer) {
    super();
    this.document = document;
    this.renderer = renderer;
  }

  @on("render")
  onRender(): void {
    // Update hover state
    const io = this.game.io;
    const worldPos = this.game.camera.toWorld(io.mousePosition);

    // Don't update hover while dragging
    if (this.dragState) {
      return;
    }

    // Check for point hover
    const pointHit = this.renderer.hitTestPoint(worldPos);
    if (pointHit) {
      this.renderer.setHoverInfo({
        contourIndex: pointHit.contourIndex,
        pointIndex: pointHit.pointIndex,
        worldPosition: this.document.getContour(pointHit.contourIndex)!
          .controlPoints[pointHit.pointIndex],
      });
      return;
    }

    // Check for spline hover
    const splineHit = this.renderer.hitTestSpline(worldPos);
    if (splineHit) {
      this.renderer.setHoverInfo({
        contourIndex: splineHit.contourIndex,
        pointIndex: null,
        worldPosition: splineHit.position,
        splineSegment: {
          segmentIndex: splineHit.segmentIndex,
          t: splineHit.t,
        },
      });
      return;
    }

    // Nothing hovered
    this.renderer.setHoverInfo(null);
  }

  @on("mouseDown")
  onMouseDown(): void {
    const io = this.game.io;

    // Ignore middle mouse (panning) and right mouse
    if (io.mmb || io.rmb) return;

    // Ignore if Space is held (panning)
    if (io.isKeyDown("Space")) return;

    const worldPos = this.game.camera.toWorld(io.mousePosition);
    const hoverInfo = this.renderer.getHoverInfo();

    // Check if clicking on a control point
    if (hoverInfo?.pointIndex !== null && hoverInfo?.pointIndex !== undefined) {
      this.handlePointClick(
        hoverInfo.contourIndex,
        hoverInfo.pointIndex,
        worldPos,
        io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight"),
      );
      return;
    }

    // Check if clicking on a spline segment (insert point)
    if (hoverInfo?.splineSegment) {
      this.handleSplineClick(
        hoverInfo.contourIndex,
        hoverInfo.splineSegment.segmentIndex,
        hoverInfo.worldPosition,
      );
      return;
    }

    // Clicked on empty space - deselect
    this.document.clearSelection();
  }

  private handlePointClick(
    contourIndex: number,
    pointIndex: number,
    worldPos: V2d,
    additive: boolean,
  ): void {
    const selection = this.document.getSelection();

    if (additive) {
      // Toggle selection of this point
      this.document.selectPoint(contourIndex, pointIndex, true);
    } else {
      // Check if clicking on already selected point (start drag)
      if (this.document.isPointSelected(contourIndex, pointIndex)) {
        // Start dragging all selected points
        this.startDrag(contourIndex, worldPos);
      } else {
        // Select just this point
        this.document.selectPoint(contourIndex, pointIndex, false);
        this.startDrag(contourIndex, worldPos);
      }
    }
  }

  private handleSplineClick(
    contourIndex: number,
    segmentIndex: number,
    position: V2d,
  ): void {
    // Insert a new point after the segment start index
    const insertIndex = segmentIndex + 1;
    const command = new AddPointCommand(
      this.document,
      contourIndex,
      insertIndex,
      V(position.x, position.y),
    );
    this.document.executeCommand(command);

    // Select the new point
    this.document.selectPoint(contourIndex, insertIndex, false);

    // Start dragging immediately
    this.startDrag(contourIndex, position);
  }

  private startDrag(contourIndex: number, mousePos: V2d): void {
    const contour = this.document.getContour(contourIndex);
    if (!contour) return;

    const selection = this.document.getSelection();
    const startPositions = new Map<number, V2d>();

    for (const pointIndex of selection.pointIndices) {
      const pt = contour.controlPoints[pointIndex];
      if (pt) {
        startPositions.set(pointIndex, V(pt.x, pt.y));
      }
    }

    if (startPositions.size === 0) return;

    this.dragState = {
      contourIndex,
      startPositions,
      startMousePos: V(mousePos.x, mousePos.y),
      hasMoved: false,
    };
  }

  @on("mouseUp")
  onMouseUp(): void {
    if (!this.dragState) return;

    if (this.dragState.hasMoved) {
      // Create undo command for the move
      const contour = this.document.getContour(this.dragState.contourIndex);
      if (contour) {
        const pointMoves: Array<{
          index: number;
          oldPosition: V2d;
          newPosition: V2d;
        }> = [];

        for (const [pointIndex, oldPos] of this.dragState.startPositions) {
          const newPos = contour.controlPoints[pointIndex];
          if (newPos) {
            pointMoves.push({
              index: pointIndex,
              oldPosition: oldPos,
              newPosition: V(newPos.x, newPos.y),
            });
          }
        }

        if (pointMoves.length > 0) {
          // We need to undo the direct move first, then apply via command
          // Actually, since we did direct moves, we just create the command for undo
          // The command's execute() won't change anything since positions are already set

          // Reset to start positions
          for (const move of pointMoves) {
            this.document.movePointDirect(
              this.dragState.contourIndex,
              move.index,
              move.oldPosition,
            );
          }

          // Now execute the command (which will set final positions and add to undo stack)
          const command = new MovePointsCommand(
            this.document,
            this.dragState.contourIndex,
            pointMoves,
          );
          this.document.executeCommand(command);
        }
      }
    }

    this.dragState = null;
  }

  @on("tick")
  onTick(): void {
    if (!this.dragState) return;

    const io = this.game.io;
    const worldPos = this.game.camera.toWorld(io.mousePosition);

    // Calculate delta from start position
    const dx = worldPos.x - this.dragState.startMousePos.x;
    const dy = worldPos.y - this.dragState.startMousePos.y;

    // Check if moved enough to count as a drag
    const dragThreshold = 2 / this.game.camera.z;
    if (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold) {
      this.dragState.hasMoved = true;
    }

    // Update all dragged point positions directly
    for (const [pointIndex, startPos] of this.dragState.startPositions) {
      this.document.movePointDirect(
        this.dragState.contourIndex,
        pointIndex,
        V(startPos.x + dx, startPos.y + dy),
      );
    }
  }

  @on("keyDown")
  onKeyDown({ key }: { key: string }): void {
    // Delete selected points
    if (key === "Delete" || key === "Backspace") {
      this.deleteSelectedPoints();
      return;
    }

    // Escape - deselect all
    if (key === "Escape") {
      this.document.clearSelection();
      return;
    }

    // Undo
    if (key === "KeyZ" && this.game.io.isKeyDown("MetaLeft")) {
      if (this.game.io.isKeyDown("ShiftLeft")) {
        this.document.redo();
      } else {
        this.document.undo();
      }
      return;
    }

    // Redo (Ctrl+Y or Cmd+Shift+Z)
    if (key === "KeyY" && this.game.io.isKeyDown("MetaLeft")) {
      this.document.redo();
      return;
    }
  }

  private deleteSelectedPoints(): void {
    const selection = this.document.getSelection();
    if (selection.contourIndex === null || selection.pointIndices.size === 0) {
      return;
    }

    const contour = this.document.getContour(selection.contourIndex);
    if (!contour) return;

    // Don't delete if it would leave less than 3 points
    const remainingPoints =
      contour.controlPoints.length - selection.pointIndices.size;
    if (remainingPoints < 3) {
      console.warn("Cannot delete points: contour needs at least 3 points");
      return;
    }

    const command = new DeletePointsCommand(
      this.document,
      selection.contourIndex,
      [...selection.pointIndices],
    );
    this.document.executeCommand(command);

    // Clear selection after delete
    this.document.clearSelection();
  }
}
