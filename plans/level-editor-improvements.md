# Level Editor Improvements - Execution Plan

## Current State

The terrain editor (`src/editor/`) provides a functional contour editing system with:

### Architecture
- **EditorController** (`EditorController.ts:29-343`) - Main orchestrator managing document state, file I/O, and keyboard shortcuts
- **EditorDocument** (`EditorDocument.ts:56-672`) - State management with command pattern for undo/redo
- **ContourEditor** (`ContourEditor.ts:35-336`) - Mouse interaction handler for selection and dragging
- **ContourRenderer** (`ContourRenderer.ts:105-340`) - Visualization with height-based colors
- **ContourPanel** (`ui/ContourPanel.tsx:232-265`) - Side panel for contour list and properties
- **EditorToolbar** (`ui/EditorToolbar.tsx:17-134`) - Top toolbar with file operations

### Current Capabilities
- Single contour selection with multi-point selection within that contour
- Point drag/move with MovePointsCommand for undo
- Point insertion by clicking spline segments
- Delete/Backspace to remove selected points (minimum 3 enforced)
- Undo/Redo via command pattern (Cmd+Z, Cmd+Shift+Z, Cmd+Y)
- Save downloads JSON, no direct filesystem access
- Validation: self-intersection and cross-contour intersection detection
- Invalid contours render red, but no detailed error messages

### Key Constants (ContourRenderer.ts:19-44)
```typescript
POINT_RADIUS = 8;
MIN_POINT_RADIUS = 4;
MAX_POINT_RADIUS = 16;
SPLINE_WIDTH = 2;  // Fixed world units - problem for zoom
CONNECTION_WIDTH = 1;
SELECTED_COLOR = 0xffff00;
INVALID_COLOR = 0xff4444;
```

---

## Desired Changes

Implement all features from `/docs/level-editor-design.md`:
1. Undo/redo shortcut standardization
2. Contour selection improvements (select entire curve, deselect keys, click behavior)
3. Point deletion verification
4. File System Access API for Save/Save As
5. Copy/paste contours
6. Visual improvements (zoom-independent lines, selected visibility, spline shadows)
7. Invalid contour handling (UI feedback, exclude from rendering)
8. Debug render mode
9. Contour hierarchy view
10. Cascading contour movement

---

## Files to Modify

### Phase 1: Core Usability

| File | Changes |
|------|---------|
| `src/editor/ContourEditor.ts` | Remove Cmd+Y redo (line 303-306), add Spacebar deselect (line 287), change spline click to select instead of add point (line 114-122), add Cmd+click for point insertion |
| `src/editor/EditorDocument.ts` | Add `selectAllPoints(contourIndex)` method, add `isAllPointsSelected()` getter |
| `src/editor/ContourRenderer.ts` | Make line width zoom-independent (line 281-292), enhance selected contour visibility, add spline shadow/outline for all contours |

### Phase 2: Visual Polish

| File | Changes |
|------|---------|
| `src/editor/ContourRenderer.ts` | Add shadow pass before main spline draw, pulsing animation for invalid contours, brighter invalid color |
| `src/editor/ui/ContourPanel.tsx` | Show warning emoji for invalid contours, display error details when selected, use bright red swatch |
| `src/editor/EditorController.ts` | Filter invalid contours from `getTerrainContours()` (line 132-139), add B key for debug mode |
| `src/editor/EditorDocument.ts` | Add `getValidationDetails(contourIndex)` method returning error strings |
| `src/editor/EditorSurfaceRenderer.ts` | Add render mode toggle for debug visualization |

### Phase 3: Advanced Features

| File | Changes |
|------|---------|
| `src/editor/EditorController.ts` | Implement File System Access API with file handle storage, add Save As operation, clipboard handling for contour copy/paste |
| `src/editor/io/TerrainLoader.ts` | Add `FileSystemFileHandle` storage for opened files |
| `src/editor/ui/EditorToolbar.tsx` | Add Save As button, update tooltips |
| `src/editor/EditorDocument.ts` | Add hierarchy computation using `isSplineInsideSpline()`, add `PasteContourCommand`, add `MoveContoursCommand` for cascading moves |
| `src/editor/ContourEditor.ts` | Implement copy/paste keyboard shortcuts, modify drag to include child contours |
| `src/editor/ui/ContourPanel.tsx` | Convert flat list to tree view with expand/collapse |

---

## Execution Order

### Parallel Work (Phase 1 - no dependencies)

These can be implemented independently:

**1a. Undo/Redo & Deselect Keys** (`ContourEditor.ts`)
- Remove Cmd+Y handler (lines 303-306)
- Add Spacebar to deselect (alongside Escape at line 287)

**1b. Zoom-Independent Line Thickness** (`ContourRenderer.ts`)
- Modify `renderContour()` to calculate `SPLINE_WIDTH / camera.z`
- Same for `CONNECTION_WIDTH`
- Pass camera zoom to render method

**1c. Selected Contour Visibility** (`ContourRenderer.ts`)
- Increase width for selected contour (2x-3x)
- Add glow effect: draw twice (dark/thick first, then normal)

### Sequential Work (Phase 1 - has dependencies)

**1d. Click Behavior Change** (depends on 1a for cleaner testing)
1. `ContourEditor.ts`: Modify `onMouseDown` spline handling (lines 114-122)
   - Check for Cmd/Ctrl modifier before adding point
   - Without modifier: select the contour instead
2. `EditorDocument.ts`: Add `selectAllPoints()` method
3. `ContourEditor.ts`: When clicking spline without modifier, call `selectAllPoints()`

### Parallel Work (Phase 2)

**2a. Spline Shadow/Outline** (`ContourRenderer.ts`)
- In `renderContour()`, draw shadow pass first:
  ```typescript
  // Shadow pass
  draw.strokeSmoothPolygon([...points], {
    color: 0x000000,
    width: (SPLINE_WIDTH + 2) / zoom,
    alpha: 0.5,
  });
  // Main pass
  draw.strokeSmoothPolygon([...points], { ... });
  ```

**2b. Invalid Contour UI** (`ContourPanel.tsx`, `EditorDocument.ts`)
1. `EditorDocument.ts`: Add method to get validation error strings
   ```typescript
   getValidationErrorMessage(contourIndex: number): string | null
   ```
2. `ContourPanel.tsx`: Update `ContourList` to show ⚠️ emoji for invalid
3. `ContourPanel.tsx`: Update `ContourProperties` to show error details

**2c. Debug Render Mode** (`EditorController.ts`, `EditorSurfaceRenderer.ts`)
1. `EditorController.ts`: Add B key handler to toggle debug mode
2. `EditorSurfaceRenderer.ts`: Add `debugMode` property, pass to `setRenderMode()`

### Sequential Work (Phase 2)

**2d. Exclude Invalid from Rendering** (depends on 2b)
- `EditorController.ts`: Filter in `getTerrainContours()`:
  ```typescript
  return this.document.getContours()
    .filter((_, i) => this.document.isContourValid(i))
    .map((c) => createContour(...));
  ```

### Parallel Work (Phase 3)

**3a. File System Access API** (`EditorController.ts`, `ui/EditorToolbar.tsx`) ✅ COMPLETE
1. ✅ Add `private fileHandle: FileSystemFileHandle | null = null`
2. ✅ Add `openFileSystem()` to open with File System Access API and store handle
3. ✅ Add `saveToFileSystem()` using handle.createWritable()
4. ✅ Add `saveAsToFileSystem()` using showSaveFilePicker()
5. ✅ Modify keyboard shortcuts: Cmd+S uses handle if available, with fallback
6. ✅ Add Cmd+Shift+S for Save As
7. ✅ Update toolbar with Save As button
8. ✅ Add TypeScript type declarations for File System Access API
9. ✅ Clear file handle on New terrain
10. ✅ IndexedDB persistence for file handle (remembers last opened file across sessions)
11. ✅ Startup prompt to open terrain file if no remembered handle
12. ✅ Open/Save As default to last used folder via `startIn` option

**3b. Hierarchy Computation** (`EditorDocument.ts`)
1. Add `buildContainmentHierarchy()` method using `isSplineInsideSpline()`
2. Cache hierarchy, invalidate on terrain change
3. Add `getContourParent(index)` and `getContourChildren(index)` methods

### Sequential Work (Phase 3)

**3c. Copy/Paste Contours** (depends on 3b for paste position logic)
1. `EditorDocument.ts`: Add `PasteContourCommand`
2. `EditorController.ts`: Add `copyContourToClipboard()` and `pasteContourFromClipboard()`
3. `ContourEditor.ts`: Add Cmd+C, Cmd+V, Cmd+D handlers

**3d. Hierarchy Tree View** (depends on 3b)
- `ContourPanel.tsx`: Replace flat list with recursive tree component
- Add expand/collapse state
- Indent child contours

**3e. Cascading Contour Movement** (depends on 3b)
1. `EditorDocument.ts`: Add `MoveContoursCommand` for multiple contours
2. `ContourEditor.ts`: Modify `startDrag()` to identify all descendant contours
3. Modify drag logic to move all identified contours together

---

## Implementation Details

### 1. Zoom-Independent Line Thickness

```typescript
// ContourRenderer.ts - renderContour method
private renderContour(
  draw: Draw,
  contour: EditorContour,
  contourIndex: number,
  pointRadius: number,
  isContourSelected: boolean,
  isContourValid: boolean,
  selectedPoints: Set<number>,
): void {
  const zoom = this.game.camera.z;
  const splineWidth = SPLINE_WIDTH / zoom;
  const connectionWidth = CONNECTION_WIDTH / zoom;
  // ... use these instead of constants
}
```

### 2. Click Behavior Change

```typescript
// ContourEditor.ts - onMouseDown, around line 114
if (hoverInfo?.splineSegment) {
  const io = this.game.io;
  const cmdOrCtrl = io.isKeyDown("MetaLeft") || io.isKeyDown("MetaRight") ||
                    io.isKeyDown("ControlLeft") || io.isKeyDown("ControlRight");

  if (cmdOrCtrl) {
    // Add point (current behavior)
    this.handleSplineClick(...);
  } else {
    // Select the contour and all its points
    this.document.selectAllPoints(hoverInfo.contourIndex);
  }
  return;
}
```

### 3. Hierarchy Computation

```typescript
// EditorDocument.ts - new method
interface ContourHierarchyNode {
  index: number;
  children: number[];
}

buildContainmentHierarchy(): Map<number, number | null> {
  const parentMap = new Map<number, number | null>();
  const contours = this.terrainDefinition.contours;

  for (let i = 0; i < contours.length; i++) {
    parentMap.set(i, null);

    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      if (isSplineInsideSpline(contours[i].controlPoints, contours[j].controlPoints)) {
        // i is inside j - but we want the immediate parent (smallest container)
        const currentParent = parentMap.get(i);
        if (currentParent === null ||
            isSplineInsideSpline(contours[j].controlPoints, contours[currentParent].controlPoints)) {
          parentMap.set(i, j);
        }
      }
    }
  }

  return parentMap;
}
```

### 4. File System Access API

```typescript
// EditorController.ts - new methods
private fileHandle: FileSystemFileHandle | null = null;

async saveToFileSystem(): Promise<boolean> {
  if (!this.fileHandle) {
    return this.saveAsToFileSystem();
  }

  try {
    const writable = await this.fileHandle.createWritable();
    await writable.write(this.saveToJson());
    await writable.close();
    this.document.markClean();
    return true;
  } catch (e) {
    console.error("Failed to save:", e);
    return false;
  }
}

async saveAsToFileSystem(): Promise<boolean> {
  try {
    const handle = await window.showSaveFilePicker({
      types: [{
        description: "Terrain Files",
        accept: { "application/json": [".json", ".terrain.json"] },
      }],
      suggestedName: "terrain.json",
    });
    this.fileHandle = handle;
    return this.saveToFileSystem();
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      console.error("Failed to save:", e);
    }
    return false;
  }
}
```

### 5. Cascading Movement

```typescript
// ContourEditor.ts - modified startDrag
private startDrag(contourIndex: number, mousePos: V2d): void {
  const contour = this.document.getContour(contourIndex);
  if (!contour) return;

  // Get all descendant contours to move together
  const contoursToMove = [contourIndex, ...this.document.getDescendantContours(contourIndex)];

  const startPositions = new Map<string, V2d>(); // "contourIndex:pointIndex" -> position

  for (const ci of contoursToMove) {
    const c = this.document.getContour(ci);
    if (!c) continue;
    for (let pi = 0; pi < c.controlPoints.length; pi++) {
      const pt = c.controlPoints[pi];
      startPositions.set(`${ci}:${pi}`, V(pt.x, pt.y));
    }
  }

  this.dragState = {
    contoursToMove,
    startPositions,
    startMousePos: V(mousePos.x, mousePos.y),
    hasMoved: false,
  };
}
```

---

## Verification Plan

### Manual Testing Checklist

1. **Undo/Redo**
   - [ ] Cmd+Z undoes last action
   - [ ] Cmd+Shift+Z redoes
   - [ ] Cmd+Y does NOT redo (removed)
   - [ ] Undo stack is unlimited (test 50+ operations)

2. **Selection**
   - [ ] Click spline selects entire contour (all points highlighted)
   - [ ] Cmd+click on spline adds a new point
   - [ ] Escape clears selection
   - [ ] Spacebar clears selection
   - [ ] Dragging selected contour moves all points

3. **Visual**
   - [ ] Line thickness consistent at different zoom levels
   - [ ] Selected contour clearly visible (thicker, glow)
   - [ ] Splines visible on sand (shadow/outline)
   - [ ] Invalid contours bright red and prominent

4. **Invalid Contours**
   - [ ] Warning emoji in contour list
   - [ ] Red color swatch
   - [ ] Error details when selected
   - [ ] Not rendered in terrain preview

5. **File Operations** ✅ IMPLEMENTED
   - [x] Save overwrites opened file (with File System Access)
   - [x] Save As prompts for new location
   - [x] Fallback to download if API unavailable (Safari/Firefox)
   - [x] Open stores file handle for subsequent saves
   - [x] New terrain clears file handle
   - [x] File handle persisted in IndexedDB across sessions
   - [x] Startup prompts to open file (or restores last opened file)
   - [x] Open/Save As dialogs default to last used folder

6. **Copy/Paste**
   - [ ] Cmd+C copies selected contour
   - [ ] Cmd+V pastes at offset
   - [ ] Cmd+D duplicates with offset

7. **Hierarchy**
   - [ ] Contours shown as tree in panel
   - [ ] Nested contours indented under parents
   - [ ] Moving parent moves children

8. **Debug Mode**
   - [ ] B key toggles debug visualization
   - [ ] Shows terrain height data

### Automated Tests

Add to existing e2e tests:
- Validation logic unit tests
- Hierarchy computation unit tests
- Command undo/redo correctness tests

---

## Open Questions (Resolved)

- **Click behavior**: Clicking spline selects contour; Cmd/Ctrl+click adds points ✓
- **Hierarchy view**: Geometric containment tree ✓
- **Cascading moves**: Always enabled ✓

## Remaining Investigation

- ~~**File System Access API**: Verify browser support on localhost during implementation.~~ ✅ RESOLVED - Implemented with automatic fallback to download/file-input for browsers without support (Safari, Firefox). Chrome/Edge use native file pickers.
