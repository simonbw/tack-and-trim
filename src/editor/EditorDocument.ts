/**
 * Editor document state.
 *
 * Manages the editable terrain state including:
 * - Current terrain definition (mutable working copy)
 * - Selection state (selected contour, selected points)
 * - Dirty flag for unsave warning
 * - Undo/redo stack (command pattern)
 */

import { V, V2d } from "../core/Vector";
import {
  createEmptyEditorDefinition,
  EditorContour,
  EditorTerrainDefinition,
} from "./io/TerrainFileFormat";

/**
 * Selection state for the editor.
 */
export interface EditorSelection {
  /** Index of the currently selected contour, or null if none */
  contourIndex: number | null;
  /** Set of selected point indices within the selected contour */
  pointIndices: Set<number>;
}

/**
 * Base interface for editor commands (for undo/redo).
 */
export interface EditorCommand {
  /** Execute the command */
  execute(): void;
  /** Undo the command */
  undo(): void;
  /** Human-readable description for UI */
  description: string;
}

/**
 * Listeners for document changes.
 */
export interface DocumentChangeListener {
  onTerrainChanged(): void;
  onSelectionChanged(): void;
  onDirtyChanged(isDirty: boolean): void;
}

/**
 * Editor document manages the terrain being edited.
 */
export class EditorDocument {
  private terrainDefinition: EditorTerrainDefinition;
  private selection: EditorSelection = {
    contourIndex: null,
    pointIndices: new Set(),
  };
  private isDirty = false;
  private undoStack: EditorCommand[] = [];
  private redoStack: EditorCommand[] = [];
  private listeners: DocumentChangeListener[] = [];

  constructor(initialTerrain?: EditorTerrainDefinition) {
    this.terrainDefinition = initialTerrain ?? createEmptyEditorDefinition();
  }

  // ==========================================
  // Listener management
  // ==========================================

  addListener(listener: DocumentChangeListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: DocumentChangeListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  private notifyTerrainChanged(): void {
    for (const listener of this.listeners) {
      listener.onTerrainChanged();
    }
  }

  private notifySelectionChanged(): void {
    for (const listener of this.listeners) {
      listener.onSelectionChanged();
    }
  }

  private notifyDirtyChanged(): void {
    for (const listener of this.listeners) {
      listener.onDirtyChanged(this.isDirty);
    }
  }

  // ==========================================
  // Terrain access
  // ==========================================

  getTerrainDefinition(): EditorTerrainDefinition {
    return this.terrainDefinition;
  }

  setTerrainDefinition(definition: EditorTerrainDefinition): void {
    this.terrainDefinition = definition;
    this.clearSelection();
    this.clearUndoHistory();
    this.setDirty(false);
    this.notifyTerrainChanged();
  }

  getContours(): readonly EditorContour[] {
    return this.terrainDefinition.contours;
  }

  getContour(index: number): EditorContour | undefined {
    return this.terrainDefinition.contours[index];
  }

  getDefaultDepth(): number {
    return this.terrainDefinition.defaultDepth;
  }

  // ==========================================
  // Selection management
  // ==========================================

  getSelection(): EditorSelection {
    return this.selection;
  }

  getSelectedContour(): EditorContour | null {
    if (this.selection.contourIndex === null) return null;
    return this.terrainDefinition.contours[this.selection.contourIndex] ?? null;
  }

  getSelectedContourIndex(): number | null {
    return this.selection.contourIndex;
  }

  getSelectedPointIndices(): Set<number> {
    return this.selection.pointIndices;
  }

  selectContour(index: number | null): void {
    if (this.selection.contourIndex !== index) {
      this.selection.contourIndex = index;
      this.selection.pointIndices.clear();
      this.notifySelectionChanged();
    }
  }

  selectPoint(
    contourIndex: number,
    pointIndex: number,
    additive = false,
  ): void {
    if (this.selection.contourIndex !== contourIndex) {
      this.selection.contourIndex = contourIndex;
      this.selection.pointIndices.clear();
    }

    if (additive) {
      if (this.selection.pointIndices.has(pointIndex)) {
        this.selection.pointIndices.delete(pointIndex);
      } else {
        this.selection.pointIndices.add(pointIndex);
      }
    } else {
      this.selection.pointIndices.clear();
      this.selection.pointIndices.add(pointIndex);
    }
    this.notifySelectionChanged();
  }

  selectPoints(contourIndex: number, pointIndices: number[]): void {
    this.selection.contourIndex = contourIndex;
    this.selection.pointIndices = new Set(pointIndices);
    this.notifySelectionChanged();
  }

  clearSelection(): void {
    if (
      this.selection.contourIndex !== null ||
      this.selection.pointIndices.size > 0
    ) {
      this.selection.contourIndex = null;
      this.selection.pointIndices.clear();
      this.notifySelectionChanged();
    }
  }

  isPointSelected(contourIndex: number, pointIndex: number): boolean {
    return (
      this.selection.contourIndex === contourIndex &&
      this.selection.pointIndices.has(pointIndex)
    );
  }

  isContourSelected(contourIndex: number): boolean {
    return this.selection.contourIndex === contourIndex;
  }

  // ==========================================
  // Dirty state management
  // ==========================================

  getIsDirty(): boolean {
    return this.isDirty;
  }

  setDirty(dirty: boolean): void {
    if (this.isDirty !== dirty) {
      this.isDirty = dirty;
      this.notifyDirtyChanged();
    }
  }

  markClean(): void {
    this.setDirty(false);
  }

  // ==========================================
  // Direct edit operations (without undo)
  // ==========================================

  /**
   * Move a point directly (used during drag operations).
   * Does not create an undo entry - use executeCommand for that.
   */
  movePointDirect(
    contourIndex: number,
    pointIndex: number,
    newPosition: V2d,
  ): void {
    const contour = this.terrainDefinition.contours[contourIndex];
    if (!contour) return;

    const points = [...contour.controlPoints];
    if (pointIndex < 0 || pointIndex >= points.length) return;

    points[pointIndex] = V(newPosition.x, newPosition.y);
    this.terrainDefinition.contours[contourIndex] = {
      ...contour,
      controlPoints: points,
    };
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  /**
   * Move multiple selected points by a delta.
   */
  moveSelectedPointsDirect(delta: V2d): void {
    if (this.selection.contourIndex === null) return;
    if (this.selection.pointIndices.size === 0) return;

    const contour =
      this.terrainDefinition.contours[this.selection.contourIndex];
    if (!contour) return;

    const points = [...contour.controlPoints];
    for (const pointIndex of this.selection.pointIndices) {
      if (pointIndex >= 0 && pointIndex < points.length) {
        const pt = points[pointIndex];
        points[pointIndex] = V(pt.x + delta.x, pt.y + delta.y);
      }
    }

    this.terrainDefinition.contours[this.selection.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  // ==========================================
  // Command execution (with undo)
  // ==========================================

  executeCommand(command: EditorCommand): void {
    command.execute();
    this.undoStack.push(command);
    this.redoStack = []; // Clear redo stack on new action
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;

    command.undo();
    this.redoStack.push(command);
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;

    command.execute();
    this.undoStack.push(command);
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  clearUndoHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  getUndoDescription(): string | null {
    const command = this.undoStack[this.undoStack.length - 1];
    return command?.description ?? null;
  }

  getRedoDescription(): string | null {
    const command = this.redoStack[this.redoStack.length - 1];
    return command?.description ?? null;
  }
}

// ==========================================
// Command implementations
// ==========================================

/**
 * Command to move a single point.
 */
export class MovePointCommand implements EditorCommand {
  description: string;

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
    private pointIndex: number,
    private oldPosition: V2d,
    private newPosition: V2d,
  ) {
    this.description = "Move point";
  }

  execute(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    points[this.pointIndex] = V(this.newPosition.x, this.newPosition.y);

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    points[this.pointIndex] = V(this.oldPosition.x, this.oldPosition.y);

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }
}

/**
 * Command to move multiple points.
 */
export class MovePointsCommand implements EditorCommand {
  description: string;

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
    private pointMoves: Array<{
      index: number;
      oldPosition: V2d;
      newPosition: V2d;
    }>,
  ) {
    this.description =
      pointMoves.length === 1
        ? "Move point"
        : `Move ${pointMoves.length} points`;
  }

  execute(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    for (const move of this.pointMoves) {
      points[move.index] = V(move.newPosition.x, move.newPosition.y);
    }

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    for (const move of this.pointMoves) {
      points[move.index] = V(move.oldPosition.x, move.oldPosition.y);
    }

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }
}

/**
 * Command to add a point to a contour.
 */
export class AddPointCommand implements EditorCommand {
  description = "Add point";

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
    private insertIndex: number,
    private position: V2d,
  ) {}

  execute(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    points.splice(this.insertIndex, 0, V(this.position.x, this.position.y));

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    points.splice(this.insertIndex, 1);

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }
}

/**
 * Command to delete points from a contour.
 */
export class DeletePointsCommand implements EditorCommand {
  description: string;
  private deletedPoints: Array<{ index: number; position: V2d }>;

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
    pointIndices: number[],
  ) {
    const contour = this.document.getContour(this.contourIndex);
    // Store points in reverse order for proper restoration
    this.deletedPoints = [...pointIndices]
      .sort((a, b) => b - a)
      .map((index) => ({
        index,
        position: contour?.controlPoints[index] ?? V(0, 0),
      }));
    this.description =
      pointIndices.length === 1
        ? "Delete point"
        : `Delete ${pointIndices.length} points`;
  }

  execute(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    // Delete in reverse order to maintain indices
    for (const { index } of this.deletedPoints) {
      points.splice(index, 1);
    }

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const points = [...contour.controlPoints];
    // Restore in forward order (reverse of deletion order)
    for (let i = this.deletedPoints.length - 1; i >= 0; i--) {
      const { index, position } = this.deletedPoints[i];
      points.splice(index, 0, V(position.x, position.y));
    }

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
  }
}

/**
 * Command to add a new contour.
 */
export class AddContourCommand implements EditorCommand {
  description = "Add contour";

  constructor(
    private document: EditorDocument,
    private contour: EditorContour,
    private insertIndex?: number,
  ) {}

  execute(): void {
    const definition = this.document.getTerrainDefinition();
    if (this.insertIndex !== undefined) {
      definition.contours.splice(this.insertIndex, 0, this.contour);
    } else {
      definition.contours.push(this.contour);
    }
  }

  undo(): void {
    const definition = this.document.getTerrainDefinition();
    const index = this.insertIndex ?? definition.contours.indexOf(this.contour);
    if (index >= 0) {
      definition.contours.splice(index, 1);
    }
  }
}

/**
 * Command to delete a contour.
 */
export class DeleteContourCommand implements EditorCommand {
  description = "Delete contour";
  private deletedContour: EditorContour | null = null;

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
  ) {}

  execute(): void {
    const definition = this.document.getTerrainDefinition();
    this.deletedContour = definition.contours[this.contourIndex] ?? null;
    if (this.deletedContour) {
      definition.contours.splice(this.contourIndex, 1);
    }
  }

  undo(): void {
    if (!this.deletedContour) return;
    const definition = this.document.getTerrainDefinition();
    definition.contours.splice(this.contourIndex, 0, this.deletedContour);
  }
}

/**
 * Command to set a contour property.
 */
export class SetContourPropertyCommand<K extends keyof EditorContour>
  implements EditorCommand
{
  description: string;

  constructor(
    private document: EditorDocument,
    private contourIndex: number,
    private property: K,
    private oldValue: EditorContour[K],
    private newValue: EditorContour[K],
  ) {
    this.description = `Change ${String(property)}`;
  }

  execute(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      [this.property]: this.newValue,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const definition = this.document.getTerrainDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      [this.property]: this.oldValue,
    };
  }
}
