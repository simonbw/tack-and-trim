# Level Editor Design Document

## Overview

This document outlines the planned features and improvements for the Tack & Trim terrain editor. The editor currently supports basic contour editing with undo/redo, but needs enhancements for usability, visual clarity, and workflow efficiency.

---

## 1. Undo/Redo Improvements

### Current State
- Unlimited undo/redo stack exists via command pattern
- Keyboard shortcuts need verification

### Planned Changes
- **Redo shortcut**: Use `Cmd+Shift+Z` (not `Cmd+Y`)
- Ensure undo stack remains truly unlimited (no cap)

### Files to Modify
- `src/editor/EditorController.ts` - keyboard shortcut handling

---

## 2. Contour Selection Model

### Current State
- Single contour can be selected at a time
- Points within the selected contour can be multi-selected
- Clicking empty space clears selection

### Planned Changes

#### 2.1 Select Entire Curve
- Clicking on a contour's spline line (not a control point) should select the entire contour
- All control points should be visually indicated as selected
- Dragging should move all points together as a unit
- This creates a "contour-level selection" vs "point-level selection"

#### 2.2 Deselection
- **Escape key**: Deselect current contour/points
- **Spacebar**: Also deselect (alternative key)
- Clicking empty space already clears selection (keep this)

#### 2.3 Click Behavior Change
- **Clicking on spline line**: Selects the contour (not add a point)
- **Cmd/Ctrl+click on spline**: Adds a new point (modifier required)
- This prevents accidental point additions and makes selection more intuitive

#### 2.4 Selection Constraint
- Only allow adding new points to the currently selected contour
- This prevents accidental point additions to wrong contours

### Files to Modify
- `src/editor/ContourEditor.ts` - selection logic and keyboard handling
- `src/editor/EditorDocument.ts` - selection state (may need "all points selected" concept)

---

## 3. Point Deletion

### Current State
- Points can be deleted (minimum 3 points enforced)
- Delete key handling exists

### Planned Changes
- Ensure delete key works for selected points
- Consider adding a toolbar button for discoverability
- Keep minimum 3 points validation with clear error feedback

### Files to Modify
- `src/editor/ContourEditor.ts` - keyboard handling
- `src/editor/ui/EditorToolbar.tsx` - optional delete button

---

## 4. File System Access

### Current State
- Save downloads JSON to browser downloads folder
- Copy to clipboard available
- No direct file system write

### Planned Investigation
- Research **File System Access API** for localhost permissions
- This API allows web apps to read/write files directly with user permission
- Would enable true "Save" (overwrite) and "Save As" (new location) workflows

### Proposed UX
- **Save (Cmd+S)**: If file was opened from filesystem, save directly back
- **Save As (Cmd+Shift+S)**: Prompt for new location
- **Fallback**: If API unavailable, fall back to download behavior

### Files to Modify
- `src/editor/EditorController.ts` - file operations
- `src/editor/io/TerrainLoader.ts` - may need file handle storage
- `src/editor/ui/EditorToolbar.tsx` - Save vs Save As buttons

---

## 5. Copy/Paste Contours

### Current State
- No contour-level clipboard
- Only full terrain JSON copy exists

### Planned Changes

#### 5.1 Copy (Cmd+C)
- Copy selected contour to clipboard as JSON
- Store enough data to reconstruct: control points, height, name, hill params

#### 5.2 Paste (Cmd+V)
- Paste contour at mouse position (or offset from original)
- Create new contour with unique name (e.g., "Contour 1 (Copy)")
- Auto-select the pasted contour

#### 5.3 Duplicate (Cmd+D)
- Shortcut for copy+paste with offset
- New contour appears slightly offset from original

### Files to Modify
- `src/editor/ContourEditor.ts` - keyboard shortcuts
- `src/editor/EditorDocument.ts` - paste command
- `src/editor/EditorController.ts` - clipboard handling

---

## 6. Visual Improvements

### 6.1 Zoom-Independent Line Thickness

#### Current State
- Spline lines are 2px world units
- Very thin when zoomed out, very thick when zoomed in

#### Planned Changes
- Calculate line thickness based on zoom level
- Target: consistent apparent thickness regardless of zoom
- Formula: `screenThickness / camera.zoom`

#### Files to Modify
- `src/editor/ContourRenderer.ts` - `renderContour()` method

### 6.2 Selected Contour Visibility

#### Current State
- Selected contour is yellow
- Can be hard to distinguish

#### Planned Changes
Options to implement (choose one or combine):
- **Thicker line**: 2x or 3x normal thickness
- **Glow/outline**: Render twice - once thick and dark, once normal on top
- **Animated dash pattern**: Marching ants effect
- **Brighter saturation**: More vivid yellow/orange

Recommended: **Thicker line + slight glow**

#### Files to Modify
- `src/editor/ContourRenderer.ts`

### 6.3 Spline Visibility on Sand

#### Current State
- Yellow/brown splines hard to see on yellow-brown sand

#### Planned Changes
- Add dark outline/shadow behind all spline lines
- Render order: shadow first (dark, slightly thicker), then colored line
- Shadow color: semi-transparent black or dark brown

#### Files to Modify
- `src/editor/ContourRenderer.ts`

---

## 7. Invalid Contour Handling

### Current State
- Invalid contours (self-intersecting or intersecting others) render red
- No detailed error message
- Still passed to land renderer

### Planned Changes

#### 7.1 Visual Indication
- **Bright red color**: Keep and enhance (more saturated)
- **Thicker line**: Make invalid contours visually prominent
- **Pulsing/flashing**: Optional animated warning

#### 7.2 Legend/Panel Updates
- Color swatch in ContourPanel shows bright red
- Add warning emoji next to invalid contour name
- Show "Invalid" badge

#### 7.3 Error Details
- When invalid contour is selected, show explanation in ContourPanel:
  - "Self-intersecting at X segments"
  - "Intersects with: [Contour A], [Contour B]"
- Optionally highlight intersection points in viewport

#### 7.4 Exclude from Rendering
- Invalid contours should NOT be passed to TerrainInfo
- Filter them out in `EditorController.getTerrainContours()`
- This prevents corrupted terrain rendering

### Files to Modify
- `src/editor/ContourRenderer.ts` - enhanced invalid visuals
- `src/editor/ui/ContourPanel.tsx` - error display
- `src/editor/EditorController.ts` - filter invalid contours
- `src/editor/EditorDocument.ts` - expose validation details

---

## 8. Debug Render Mode

### Current State
- Game has debug mode (B key) showing terrain data
- Editor does not expose this

### Planned Changes
- Add keyboard shortcut (B) to toggle debug visualization
- Show: height values, contour boundaries, influence field data
- Match the visualization available in the main game

### Files to Modify
- `src/editor/EditorController.ts` - keyboard handling
- `src/editor/EditorSurfaceRenderer.ts` - debug render mode

---

## 9. Contour Hierarchy View

### Current State
- Contours stored as flat array
- Geometric containment can be computed but not displayed
- No visual hierarchy

### Planned Changes

#### 9.1 Hierarchy Computation
- Use existing `isSplineInsideSpline()` to build containment tree
- Recompute on terrain changes (can be cached)

#### 9.2 UI Display (Geometric Containment Tree)
- Show contours in ContourPanel as indented tree based on geometric containment
- Parent contours (outer) contain child contours (inner) visually
- Expand/collapse capability for complex terrains
- This makes the spatial relationships immediately clear

#### Example Display:
```
▼ Ocean Floor (-50ft)
  ▼ Continental Shelf (-20ft)
    ▼ Shore (0ft)
      ▼ Beach (2ft)
        Island Peak (10ft)
```
Note: Hierarchy determined by which contour geometrically contains which, not by height values.

### Files to Modify
- `src/editor/EditorDocument.ts` - hierarchy computation
- `src/editor/ui/ContourPanel.tsx` - tree view UI

---

## 10. Cascading Contour Movement

### Current State
- Moving a contour moves only that contour
- Child contours (geometrically contained) stay in place

### Planned Changes
- **Always cascade**: When moving a contour, automatically move all geometrically contained contours
- Use hierarchy computation from Section 9
- This maintains relative positions of nested contours (e.g., moving an island moves its peak)

### Implementation Notes
- Identify all descendants before move starts using containment tree
- Apply same delta to all descendants
- Create compound command for undo (moves all affected contours atomically)

### Files to Modify
- `src/editor/ContourEditor.ts` - drag handling
- `src/editor/EditorDocument.ts` - compound move command

---

## 11. Code Quality

### Principle
Editor code should be held to the same standards as game engine code.

### Guidelines
- Follow existing patterns from `src/core/`
- Use proper TypeScript types (no `any`)
- Add appropriate error handling
- Keep consistent naming conventions
- Document complex algorithms
- Consider performance (caching, avoiding redundant computation)

---

## Implementation Priority

### Phase 1: Core Usability
1. Undo/redo shortcut fix
2. Contour selection improvements (select all, deselect keys)
3. Zoom-independent line thickness
4. Selected contour visibility enhancement

### Phase 2: Visual Polish
5. Spline visibility (outline/shadow)
6. Invalid contour handling (all aspects)
7. Debug render mode

### Phase 3: Advanced Features
8. File System Access API integration
9. Copy/paste contours
10. Hierarchy view
11. Cascading contour movement

---

## Verification Plan

### Manual Testing
- Open editor at `src/editor.html`
- Test each feature interactively
- Verify undo/redo works for all operations
- Test at various zoom levels
- Create invalid contours and verify feedback
- Test file save/load round-trip

### Automated Testing
- Extend existing e2e tests if applicable
- Unit tests for hierarchy computation
- Unit tests for validation logic

---

## Open Questions

1. **File System Access API**: Need to verify browser support and localhost permissions during implementation

## Confirmed Decisions

- **Click behavior**: Clicking spline selects contour; Cmd/Ctrl+click adds points
- **Hierarchy view**: Geometric containment tree (which contours are inside which)
- **Cascading moves**: Always enabled (moving parent moves children)
