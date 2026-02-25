# Terrain Editor

Standalone terrain editor for creating level terrain using contour-based definitions.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      EditorController                            │
│  - Orchestrates editor entities                                  │
│  - File I/O (save/load JSON)                                    │
│  - Keyboard shortcuts (Ctrl+S, Ctrl+O, Ctrl+N)                  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ owns
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
┌─────────────────┐ ┌─────────────┐ ┌──────────────────┐
│  EditorDocument │ │ContourEditor│ │ ContourRenderer  │
│  - State        │ │ - Mouse     │ │ - Spline draw    │
│  - Selection    │ │   picking   │ │ - Control points │
│  - Undo/redo    │ │ - Dragging  │ │ - Height colors  │
└─────────────────┘ └─────────────┘ └──────────────────┘
           │                               │
           │                               │
           ▼                               ▼
┌─────────────────┐               ┌──────────────────┐
│ EditorCamera    │               │EditorSurface     │
│ Controller      │               │Renderer          │
│ - Pan/zoom      │               │ - Water/terrain  │
│ - Fit to view   │               │   visualization  │
└─────────────────┘               └──────────────────┘
```

## Entry Point

`EditorMain.ts` creates a `Game` instance and adds `EditorController`. The editor runs the same engine as the main game but with different entities.

Access via: `src/editor.html`

## Key Components

### EditorDocument

State management using the Command pattern for undo/redo:

- `terrainDefinition` - The terrain data being edited
- `selection` - Currently selected contour and points
- `undoStack` / `redoStack` - Command history
- Notifies listeners via `DocumentChangeListener` interface

### EditorController

Main orchestrator entity:

- Loads default terrain on startup
- Adds child entities (camera, renderer, editor UI)
- Handles file operations (save JSON, load file, new terrain)
- Listens to document changes to update TerrainResources

### ContourEditor

Mouse interaction handler:

- Point picking with distance threshold
- Spline edge picking for adding points
- Drag operations with MovePointsCommand on release
- Multi-select with Shift key

### ContourRenderer

Visualization:

- Catmull-Rom splines through control points
- Control point handles (filled for selected)
- Height-based colors (blue = underwater, tan = above)

### EditorCameraController

Camera navigation:

- Pan: Middle-drag or Space+drag
- Zoom: Mouse wheel (centered on cursor)
- Fit to terrain: Home key
- Keyboard: WASD/arrows to pan, =/- to zoom

### EditorSurfaceRenderer

Renders water and terrain surfaces for visual context.

## Commands (Undo/Redo)

| Command                     | Description               |
| --------------------------- | ------------------------- |
| `MovePointCommand`          | Move single point         |
| `MovePointsCommand`         | Move multiple points      |
| `AddPointCommand`           | Add point to contour      |
| `DeletePointsCommand`       | Delete selected points    |
| `AddContourCommand`         | Add new contour           |
| `DeleteContourCommand`      | Delete contour            |
| `SetContourPropertyCommand` | Change height, name, etc. |

## File Format

Levels are stored as JSON (see `io/LevelFileFormat.ts`):

```typescript
{
  version: 1,
  defaultDepth: -50,
  waves: {
    sources: [{
      amplitude: 0.5,
      wavelength: 60,
      direction: 1.2,
      phaseOffset: 0,     // optional
      speedMult: 1.0,     // optional
      sourceDist: 1e10,   // optional
      sourceOffsetX: 0,   // optional
      sourceOffsetY: 0    // optional
    }]
  },
  contours: [{
    name: "Island Shore",
    height: 0,
    controlPoints: [[x, y], ...]
  }]
}
```

The editor preserves the `waves` section through load/save cycles but does not yet provide UI for editing wave configuration.

## Controls

| Action        | Input                                 |
| ------------- | ------------------------------------- |
| Pan           | Middle-drag, Space+drag, WASD, Arrows |
| Zoom          | Scroll wheel, =/- keys                |
| Select point  | Click                                 |
| Multi-select  | Shift+Click                           |
| Move points   | Drag                                  |
| Add point     | Click on spline                       |
| Delete points | Delete/Backspace                      |
| Undo          | Ctrl/Cmd+Z                            |
| Redo          | Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y          |
| Save          | Ctrl/Cmd+S                            |
| Open          | Ctrl/Cmd+O                            |
| New           | Ctrl/Cmd+N                            |
| Fit to view   | Home                                  |
