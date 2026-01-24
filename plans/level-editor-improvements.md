# Level Editor Improvements - Phase 2

Previous improvements (hierarchy, copy/paste, tree view, cascading movement, File System API) are complete.

---

## New Issues

### 1. Keyboard Focus Problems

**Problem**: Keyboard shortcuts interfere with normal input behavior.
- Pressing Cmd+S saves the file but also triggers "S" key action (moves camera down)
- Cannot type in input boxes to rename contours - keyboard events are being captured by the editor

**Root Cause**: The editor's keyboard handling doesn't check if an input element has focus, and doesn't properly handle modifier keys to prevent the base key from triggering.

**Files to Investigate**:
- `src/editor/EditorController.ts` - keyboard shortcut handling
- `src/editor/ContourEditor.ts` - keyboard event handlers
- `src/editor/EditorCameraController.ts` - camera movement keys (WASD)

**Solution**:
1. Check `document.activeElement` before handling keyboard events - skip if focused on input/textarea
2. For modifier shortcuts like Cmd+S, ensure the base "S" key handler checks that no modifier is held

### 2. Continuous Zoom with +/- Keys

**Problem**: The +/- keys zoom by a fixed amount on each press. Should continuously zoom while held, like the game's camera controller.

**Files to Modify**:
- `src/editor/EditorCameraController.ts` - implement held-key zoom behavior

**Solution**:
- Track key down/up state for +/- keys
- In tick/update loop, apply zoom delta while keys are held
- Match behavior from main game's camera controller

### 3. Destroyed Texture Error on Wave Recompute

**Problem**: Recomputing waves produces the error:
```
"500Destroyed texture [Texture "Swell Influence Texture"] used in a submit."
```

**Root Cause**: A texture is being destroyed while still referenced in a pending GPU command buffer submission.

**Files to Investigate**:
- `src/game/world-data/influence/InfluenceFieldManager.ts`
- Swell/wave-related rendering code

**Solution**: Ensure texture destruction is deferred until after any pending GPU submissions complete, or properly synchronize texture lifecycle with render passes.

### 4. Zoom Out Limit Too Restrictive

**Problem**: Cannot zoom out far enough to see the entire terrain.

**Files to Modify**:
- `src/editor/EditorCameraController.ts` - adjust `MIN_ZOOM` constant or zoom bounds

**Solution**: Decrease the minimum zoom level to allow wider view.

### 5. Contour Height Precision

**Problem**: Cannot set contour heights to fractional values (e.g., 2.5 feet). Need precision to the tenth of a foot.

**Files to Modify**:
- `src/editor/ui/ContourPanel.tsx` - height input field configuration

**Solution**: Change the height input step from 1 to 0.1, and ensure the underlying data model supports decimal values.

### 6. Show Origin and Axes

**Problem**: No visual reference for the coordinate system. Player starts at (0,0) but there's no way to see where that is.

**Files to Modify**:
- `src/editor/ContourRenderer.ts` - add axis rendering

**Solution**:
- Draw X and Y axes through the origin
- Use distinct colors (e.g., red for X, green for Y)
- Extend axes across the visible viewport
- Optionally add a small marker or label at the origin

---

## Execution Order

### Phase 1: Quick Fixes (independent)

1. **Zoom out limit** - Single constant change
2. **Continuous +/- zoom** - Localized to EditorCameraController
3. **Contour height precision** - Change input step to 0.1

### Phase 2: Keyboard Focus (requires investigation)

4. **Input focus handling** - Need to audit all keyboard handlers
5. **Modifier key handling** - Ensure Cmd+S doesn't trigger S

### Phase 3: New Features

6. **Origin and axes** - Draw X/Y axes through (0,0)

### Phase 4: Bug Fix (requires debugging)

7. **Destroyed texture error** - Needs GPU synchronization investigation
