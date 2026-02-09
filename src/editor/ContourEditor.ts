/**
 * Contour editor interaction handler.
 *
 * Handles mouse interaction for editing terrain contours:
 * - Click on point: Select it
 * - Drag point: Move it (creates MovePointCommand on release)
 * - Click on spline segment: Select entire contour
 * - Cmd/Ctrl+click on spline: Insert new point
 * - Click empty space: Deselect
 * - Delete/Backspace: Delete selected points
 * - Shift+click: Multi-select points
 * - Escape or Space: Deselect all
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { V, V2d } from "../core/Vector";
import { ContourRenderer } from "./ContourRenderer";
import { EditorController } from "./EditorController";
import {
  AddPointCommand,
  DeletePointsCommand,
  EditorDocument,
  MoveMultiContourPointsCommand,
  MovePointsCommand,
  MultiContourPointMove,
} from "./EditorDocument";

interface DragState {
  /** Primary contour being dragged */
  contourIndex: number;
  /** All contours affected (primary + descendants for cascading) */
  affectedContours: number[];
  /** Starting positions of all dragged points: "contourIndex:pointIndex" -> position */
  startPositions: Map<string, V2d>;
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

    // Always do fresh hit testing on click to avoid stale hover info issues
    const pointHit = this.renderer.hitTestPoint(worldPos);
    const splineHit = this.renderer.hitTestSpline(worldPos);

    // 1. Check if clicking on a control point (highest priority)
    if (pointHit) {
      this.handlePointClick(
        pointHit.contourIndex,
        pointHit.pointIndex,
        worldPos,
        io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight"),
      );
      return;
    }

    // 2. Check if clicking on a spline segment (before fill, since stroke overlaps fill area)
    if (splineHit) {
      const hasModifier =
        io.isKeyDown("MetaLeft") ||
        io.isKeyDown("MetaRight") ||
        io.isKeyDown("ControlLeft") ||
        io.isKeyDown("ControlRight");

      if (hasModifier) {
        // Cmd/Ctrl+click: insert new point
        this.handleSplineClick(
          splineHit.contourIndex,
          splineHit.segmentIndex,
          splineHit.position,
        );
      } else {
        // Plain click: select entire contour (but do NOT start drag)
        this.document.selectAllPoints(splineHit.contourIndex);
      }
      return;
    }

    // 3. Check if clicking on fill of SELECTED contour (allows drag-by-fill)
    const selectedContourIndex = this.document.getSelectedContourIndex();
    if (selectedContourIndex !== null) {
      const fillHit = this.renderer.hitTestFill(worldPos);
      if (fillHit && fillHit.contourIndex === selectedContourIndex) {
        // Start drag of entire contour
        const contour = this.document.getContour(selectedContourIndex);
        if (contour) {
          this.document.selectAllPoints(selectedContourIndex);
          const allIndices = contour.controlPoints.map((_, i) => i);
          this.startDrag(selectedContourIndex, worldPos, allIndices);
        }
        return;
      }
    }

    // 4. Clicked on empty space - deselect
    this.document.clearSelection();
  }

  private handlePointClick(
    contourIndex: number,
    pointIndex: number,
    worldPos: V2d,
    additive: boolean,
  ): void {
    if (additive) {
      // Shift+click: just toggle selection, no drag
      this.document.selectPoint(contourIndex, pointIndex, true);
    } else {
      // Regular click: drag just this one point
      // Update selection for visual feedback
      this.document.selectPoint(contourIndex, pointIndex, false);
      this.startDrag(contourIndex, worldPos, [pointIndex]);
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

    // Start dragging immediately (just the new point)
    this.startDrag(contourIndex, position, [insertIndex]);
  }

  private startDrag(
    contourIndex: number,
    mousePos: V2d,
    pointIndices: number[],
  ): void {
    const contour = this.document.getContour(contourIndex);
    if (!contour) return;

    const startPositions = new Map<string, V2d>();

    // Check if we're dragging the whole contour (all points)
    const allPointsDragged =
      pointIndices.length === contour.controlPoints.length;

    if (allPointsDragged) {
      // Cascading move: include this contour and all descendants
      const descendants = this.document.getContourDescendants(contourIndex);
      const affectedContours = [contourIndex, ...descendants];

      for (const ci of affectedContours) {
        const c = this.document.getContour(ci);
        if (!c) continue;

        for (let pi = 0; pi < c.controlPoints.length; pi++) {
          const pt = c.controlPoints[pi];
          startPositions.set(`${ci}:${pi}`, V(pt.x, pt.y));
        }
      }

      if (startPositions.size === 0) return;

      this.dragState = {
        contourIndex,
        affectedContours,
        startPositions,
        startMousePos: V(mousePos.x, mousePos.y),
        hasMoved: false,
      };
    } else {
      // Non-cascading: just move the specified points of this contour
      for (const pointIndex of pointIndices) {
        const pt = contour.controlPoints[pointIndex];
        if (pt) {
          startPositions.set(`${contourIndex}:${pointIndex}`, V(pt.x, pt.y));
        }
      }

      if (startPositions.size === 0) return;

      this.dragState = {
        contourIndex,
        affectedContours: [contourIndex],
        startPositions,
        startMousePos: V(mousePos.x, mousePos.y),
        hasMoved: false,
      };
    }
  }

  @on("mouseUp")
  onMouseUp(): void {
    if (!this.dragState) return;

    if (this.dragState.hasMoved) {
      // Build the list of point moves
      const pointMoves: MultiContourPointMove[] = [];

      for (const [key, oldPos] of this.dragState.startPositions) {
        const [contourStr, pointStr] = key.split(":");
        const contourIndex = parseInt(contourStr, 10);
        const pointIndex = parseInt(pointStr, 10);

        const contour = this.document.getContour(contourIndex);
        if (!contour) continue;

        const newPos = contour.controlPoints[pointIndex];
        if (newPos) {
          pointMoves.push({
            contourIndex,
            pointIndex,
            oldPosition: oldPos,
            newPosition: V(newPos.x, newPos.y),
          });
        }
      }

      if (pointMoves.length > 0) {
        // Reset to start positions
        this.document.moveMultiContourPointsDirect(
          this.dragState.startPositions,
        );

        // Check if single contour or multi-contour
        if (this.dragState.affectedContours.length === 1) {
          // Single contour: use MovePointsCommand for better description
          const singleContourMoves = pointMoves.map((m) => ({
            index: m.pointIndex,
            oldPosition: m.oldPosition,
            newPosition: m.newPosition,
          }));
          const command = new MovePointsCommand(
            this.document,
            this.dragState.contourIndex,
            singleContourMoves,
          );
          this.document.executeCommand(command);
        } else {
          // Multi-contour: use MoveMultiContourPointsCommand
          const command = new MoveMultiContourPointsCommand(
            this.document,
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

    // Build new positions map
    const newPositions = new Map<string, V2d>();
    for (const [key, startPos] of this.dragState.startPositions) {
      newPositions.set(key, V(startPos.x + dx, startPos.y + dy));
    }

    // Update all dragged point positions directly
    this.document.moveMultiContourPointsDirect(newPositions);
  }

  @on("keyDown")
  onKeyDown({ key, event }: { key: string; event?: KeyboardEvent }): void {
    // Ignore key events when focus is in an input field
    if (
      event?.target instanceof HTMLInputElement ||
      event?.target instanceof HTMLTextAreaElement
    ) {
      return;
    }

    const io = this.game.io;
    const meta = io.isKeyDown("MetaLeft") || io.isKeyDown("MetaRight");
    const ctrl = io.isKeyDown("ControlLeft") || io.isKeyDown("ControlRight");
    const shift = io.isKeyDown("ShiftLeft") || io.isKeyDown("ShiftRight");
    const modifier = meta || ctrl;

    // Delete selected points
    if (key === "Delete" || key === "Backspace") {
      this.deleteSelectedPoints();
      return;
    }

    // Escape or Space - deselect all
    if (key === "Escape" || key === "Space") {
      this.document.clearSelection();
      return;
    }

    // Undo/Redo
    if (key === "KeyZ" && modifier) {
      if (shift) {
        this.document.redo();
      } else {
        this.document.undo();
      }
      return;
    }

    // Copy (Cmd/Ctrl+C)
    if (key === "KeyC" && modifier) {
      const controller = this.game.entities.tryGetSingleton(EditorController);
      controller?.copySelectedContour();
      return;
    }

    // Paste (Cmd/Ctrl+V)
    if (key === "KeyV" && modifier) {
      const controller = this.game.entities.tryGetSingleton(EditorController);
      controller?.pasteContour();
      return;
    }

    // Duplicate (Cmd/Ctrl+D)
    if (key === "KeyD" && modifier) {
      const controller = this.game.entities.tryGetSingleton(EditorController);
      controller?.duplicateSelectedContour();
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
