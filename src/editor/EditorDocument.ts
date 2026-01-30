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
import { isSplineInsideSpline, sampleClosedSpline } from "../core/util/Spline";
import {
  ContourValidationResult,
  validateContours,
} from "../game/world/terrain/ContourValidation";
import {
  createEmptyEditorDefinition,
  EditorContour,
  EditorLevelDefinition,
} from "./io/TerrainFileFormat";

/**
 * Contour hierarchy based on geometric containment.
 */
export interface ContourHierarchy {
  /** Map from contour index to parent index (-1 if root) */
  parentMap: Map<number, number>;
  /** Map from contour index to direct children indices */
  childrenMap: Map<number, number[]>;
  /** Indices of root contours (no parent) */
  roots: number[];
}

/**
 * Compute approximate bounding box area of a spline.
 */
function computeBoundingBoxArea(points: readonly V2d[]): number {
  if (points.length === 0) return 0;

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  return (maxX - minX) * (maxY - minY);
}

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
  onLevelChanged(): void;
  onSelectionChanged(): void;
  onDirtyChanged(isDirty: boolean): void;
}

/**
 * Editor document manages the terrain being edited.
 */
export class EditorDocument {
  private levelDefinition: EditorLevelDefinition;
  private selection: EditorSelection = {
    contourIndex: null,
    pointIndices: new Set(),
  };
  private isDirty = false;
  private undoStack: EditorCommand[] = [];
  private redoStack: EditorCommand[] = [];
  private listeners: DocumentChangeListener[] = [];

  /** Cached validation results, invalidated when terrain changes */
  private validationCache: ContourValidationResult[] | null = null;

  /** Cached hierarchy, invalidated when terrain changes */
  private hierarchyCache: ContourHierarchy | null = null;

  constructor(initialTerrain?: EditorLevelDefinition) {
    this.levelDefinition = initialTerrain ?? createEmptyEditorDefinition();
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
    // Invalidate caches when terrain changes
    this.validationCache = null;
    this.hierarchyCache = null;
    for (const listener of this.listeners) {
      listener.onLevelChanged();
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

  getLevelDefinition(): EditorLevelDefinition {
    return this.levelDefinition;
  }

  setLevelDefinition(definition: EditorLevelDefinition): void {
    this.levelDefinition = definition;
    this.clearSelection();
    this.clearUndoHistory();
    this.setDirty(false);
    this.notifyTerrainChanged();
  }

  getContours(): readonly EditorContour[] {
    return this.levelDefinition.contours;
  }

  getContour(index: number): EditorContour | undefined {
    return this.levelDefinition.contours[index];
  }

  getDefaultDepth(): number {
    return this.levelDefinition.defaultDepth;
  }

  /**
   * Get validation results for all contours.
   * Results are cached and recomputed when terrain changes.
   */
  getValidationResults(): ContourValidationResult[] {
    if (this.validationCache === null) {
      const controlPointArrays = this.levelDefinition.contours.map(
        (c) => c.controlPoints,
      );
      this.validationCache = validateContours(controlPointArrays);
    }
    return this.validationCache;
  }

  /**
   * Check if a specific contour is valid.
   */
  isContourValid(contourIndex: number): boolean {
    const results = this.getValidationResults();
    return results[contourIndex]?.isValid ?? true;
  }

  // ==========================================
  // Hierarchy computation
  // ==========================================

  /**
   * Build and cache the contour hierarchy based on geometric containment.
   * Parent is the smallest contour that fully contains a child.
   */
  buildHierarchy(): ContourHierarchy {
    if (this.hierarchyCache !== null) {
      return this.hierarchyCache;
    }

    const contours = this.levelDefinition.contours;
    const n = contours.length;

    const parentMap = new Map<number, number>();
    const childrenMap = new Map<number, number[]>();
    const roots: number[] = [];

    // Initialize children map
    for (let i = 0; i < n; i++) {
      childrenMap.set(i, []);
    }

    // Pre-sample all splines and compute their areas for efficiency
    const sampledSplines: V2d[][] = contours.map((c) =>
      sampleClosedSpline(c.controlPoints, 8),
    );
    const areas: number[] = sampledSplines.map((s) =>
      computeBoundingBoxArea(s),
    );

    // For each contour, find the smallest containing contour
    for (let i = 0; i < n; i++) {
      let parentIndex = -1;
      let parentArea = Infinity;

      for (let j = 0; j < n; j++) {
        if (i === j) continue;

        // Check if contour i is inside contour j
        if (
          isSplineInsideSpline(
            contours[i].controlPoints,
            contours[j].controlPoints,
            8,
          )
        ) {
          // Prefer smaller containers
          if (areas[j] < parentArea) {
            parentIndex = j;
            parentArea = areas[j];
          }
        }
      }

      parentMap.set(i, parentIndex);

      if (parentIndex === -1) {
        roots.push(i);
      } else {
        childrenMap.get(parentIndex)!.push(i);
      }
    }

    this.hierarchyCache = { parentMap, childrenMap, roots };
    return this.hierarchyCache;
  }

  /**
   * Get the parent contour index, or -1 if root.
   */
  getContourParent(index: number): number {
    const hierarchy = this.buildHierarchy();
    return hierarchy.parentMap.get(index) ?? -1;
  }

  /**
   * Get direct children of a contour.
   */
  getContourChildren(index: number): number[] {
    const hierarchy = this.buildHierarchy();
    return hierarchy.childrenMap.get(index) ?? [];
  }

  /**
   * Get all descendants of a contour (recursively).
   */
  getContourDescendants(index: number): number[] {
    const hierarchy = this.buildHierarchy();
    const result: number[] = [];
    const stack = [...(hierarchy.childrenMap.get(index) ?? [])];

    while (stack.length > 0) {
      const child = stack.pop()!;
      result.push(child);
      const grandchildren = hierarchy.childrenMap.get(child) ?? [];
      stack.push(...grandchildren);
    }

    return result;
  }

  /**
   * Get the depth of a contour in the hierarchy (0 for root).
   */
  getContourDepth(index: number): number {
    const hierarchy = this.buildHierarchy();
    let depth = 0;
    let current = index;

    while (true) {
      const parent = hierarchy.parentMap.get(current);
      if (parent === undefined || parent === -1) break;
      depth++;
      current = parent;
    }

    return depth;
  }

  // ==========================================
  // Selection management
  // ==========================================

  getSelection(): EditorSelection {
    return this.selection;
  }

  getSelectedContour(): EditorContour | null {
    if (this.selection.contourIndex === null) return null;
    return this.levelDefinition.contours[this.selection.contourIndex] ?? null;
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

  /**
   * Select a contour and all of its control points.
   * Used when clicking on a spline without a modifier key.
   */
  selectAllPoints(contourIndex: number): void {
    const contour = this.levelDefinition.contours[contourIndex];
    if (!contour) return;

    this.selection.contourIndex = contourIndex;
    this.selection.pointIndices = new Set(
      contour.controlPoints.map((_, i) => i),
    );
    this.notifySelectionChanged();
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
    const contour = this.levelDefinition.contours[contourIndex];
    if (!contour) return;

    const points = [...contour.controlPoints];
    if (pointIndex < 0 || pointIndex >= points.length) return;

    points[pointIndex] = V(newPosition.x, newPosition.y);
    this.levelDefinition.contours[contourIndex] = {
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

    const contour = this.levelDefinition.contours[this.selection.contourIndex];
    if (!contour) return;

    const points = [...contour.controlPoints];
    for (const pointIndex of this.selection.pointIndices) {
      if (pointIndex >= 0 && pointIndex < points.length) {
        const pt = points[pointIndex];
        points[pointIndex] = V(pt.x + delta.x, pt.y + delta.y);
      }
    }

    this.levelDefinition.contours[this.selection.contourIndex] = {
      ...contour,
      controlPoints: points,
    };
    this.setDirty(true);
    this.notifyTerrainChanged();
  }

  /**
   * Move points across multiple contours directly (used during drag).
   * The positions map uses key format "contourIndex:pointIndex".
   */
  moveMultiContourPointsDirect(positions: Map<string, V2d>): void {
    // Group by contour index
    const byContour = new Map<number, Map<number, V2d>>();

    for (const [key, pos] of positions) {
      const [contourStr, pointStr] = key.split(":");
      const contourIndex = parseInt(contourStr, 10);
      const pointIndex = parseInt(pointStr, 10);

      if (!byContour.has(contourIndex)) {
        byContour.set(contourIndex, new Map());
      }
      byContour.get(contourIndex)!.set(pointIndex, pos);
    }

    // Apply changes
    for (const [contourIndex, pointPositions] of byContour) {
      const contour = this.levelDefinition.contours[contourIndex];
      if (!contour) continue;

      const points = [...contour.controlPoints];
      for (const [pointIndex, pos] of pointPositions) {
        if (pointIndex >= 0 && pointIndex < points.length) {
          points[pointIndex] = V(pos.x, pos.y);
        }
      }

      this.levelDefinition.contours[contourIndex] = {
        ...contour,
        controlPoints: points,
      };
    }

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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
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
    const definition = this.document.getLevelDefinition();
    if (this.insertIndex !== undefined) {
      definition.contours.splice(this.insertIndex, 0, this.contour);
    } else {
      definition.contours.push(this.contour);
    }
  }

  undo(): void {
    const definition = this.document.getLevelDefinition();
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
    const definition = this.document.getLevelDefinition();
    this.deletedContour = definition.contours[this.contourIndex] ?? null;
    if (this.deletedContour) {
      definition.contours.splice(this.contourIndex, 1);
    }
  }

  undo(): void {
    if (!this.deletedContour) return;
    const definition = this.document.getLevelDefinition();
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

    const definition = this.document.getLevelDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      [this.property]: this.newValue,
    };
  }

  undo(): void {
    const contour = this.document.getContour(this.contourIndex);
    if (!contour) return;

    const definition = this.document.getLevelDefinition();
    definition.contours[this.contourIndex] = {
      ...contour,
      [this.property]: this.oldValue,
    };
  }
}

/**
 * Command to paste a contour with an offset.
 */
export class PasteContourCommand implements EditorCommand {
  description = "Paste contour";
  private pastedContour: EditorContour;

  constructor(
    private document: EditorDocument,
    contour: EditorContour,
    offset: V2d,
  ) {
    // Deep clone with offset applied
    this.pastedContour = {
      ...contour,
      name: contour.name ? `${contour.name} copy` : "Contour copy",
      controlPoints: contour.controlPoints.map((p) =>
        V(p.x + offset.x, p.y + offset.y),
      ),
    };
  }

  execute(): void {
    const definition = this.document.getLevelDefinition();
    definition.contours.push(this.pastedContour);
  }

  undo(): void {
    const definition = this.document.getLevelDefinition();
    const index = definition.contours.indexOf(this.pastedContour);
    if (index >= 0) {
      definition.contours.splice(index, 1);
    }
  }

  /**
   * Get the index of the pasted contour (after execute).
   */
  getPastedIndex(): number {
    const definition = this.document.getLevelDefinition();
    return definition.contours.indexOf(this.pastedContour);
  }
}

/**
 * Point move info for multi-contour moves.
 */
export interface MultiContourPointMove {
  contourIndex: number;
  pointIndex: number;
  oldPosition: V2d;
  newPosition: V2d;
}

/**
 * Command to move points across multiple contours (for cascading moves).
 */
export class MoveMultiContourPointsCommand implements EditorCommand {
  description: string;

  constructor(
    private document: EditorDocument,
    private pointMoves: MultiContourPointMove[],
  ) {
    const contourCount = new Set(pointMoves.map((m) => m.contourIndex)).size;
    const pointCount = pointMoves.length;
    if (contourCount === 1) {
      this.description =
        pointCount === 1 ? "Move point" : `Move ${pointCount} points`;
    } else {
      this.description = `Move ${pointCount} points across ${contourCount} contours`;
    }
  }

  execute(): void {
    const definition = this.document.getLevelDefinition();

    // Group moves by contour for efficiency
    const movesByContour = new Map<number, MultiContourPointMove[]>();
    for (const move of this.pointMoves) {
      if (!movesByContour.has(move.contourIndex)) {
        movesByContour.set(move.contourIndex, []);
      }
      movesByContour.get(move.contourIndex)!.push(move);
    }

    for (const [contourIndex, moves] of movesByContour) {
      const contour = definition.contours[contourIndex];
      if (!contour) continue;

      const points = [...contour.controlPoints];
      for (const move of moves) {
        points[move.pointIndex] = V(move.newPosition.x, move.newPosition.y);
      }

      definition.contours[contourIndex] = {
        ...contour,
        controlPoints: points,
      };
    }
  }

  undo(): void {
    const definition = this.document.getLevelDefinition();

    // Group moves by contour for efficiency
    const movesByContour = new Map<number, MultiContourPointMove[]>();
    for (const move of this.pointMoves) {
      if (!movesByContour.has(move.contourIndex)) {
        movesByContour.set(move.contourIndex, []);
      }
      movesByContour.get(move.contourIndex)!.push(move);
    }

    for (const [contourIndex, moves] of movesByContour) {
      const contour = definition.contours[contourIndex];
      if (!contour) continue;

      const points = [...contour.controlPoints];
      for (const move of moves) {
        points[move.pointIndex] = V(move.oldPosition.x, move.oldPosition.y);
      }

      definition.contours[contourIndex] = {
        ...contour,
        controlPoints: points,
      };
    }
  }
}
