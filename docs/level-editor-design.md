# Tack & Trim Level Editor - Design Document

## Executive Summary

This document outlines the design for a rebuilt level editor for Tack & Trim that addresses architectural issues, improves UX, and adds essential features for creating medium-to-large scale terrains (20-100 contours).

**Key Goals:**
- Clean separation between editor UI and game engine
- Modern React-based UI with polished interactions
- Better visual feedback during editing (real-time preview, validation, measurements)
- Advanced selection and manipulation tools (box select, alignment, distribution)
- Support "sketch first, refine later" workflow

**Approach:**
- Hybrid architecture: Use engine for rendering/simulation, React/HTML/CSS for all UI
- Clear separation of concerns with well-defined interfaces
- Incremental feature delivery with solid foundation first

## Problems with Current Editor

### Architecture Issues
1. **Tight coupling to entity system** - Editor logic is embedded in game entities, making it hard to test and reason about
2. **Mixed concerns** - EditorController does too much (file I/O, coordination, clipboard, keyboard shortcuts)
3. **Entity lifecycle complexity** - Using entity add/remove for editor components is overkill
4. **No clear state management** - Document state is scattered across multiple entities

### UI/UX Issues
1. **Minimal UI** - Basic toolbar with limited discoverability
2. **Poor visual feedback** - Hard to see validation errors, no measurements, limited preview
3. **Mouse interaction complexity** - Hit testing logic is complex and brittle
4. **No advanced selection** - Can't box select, no alignment tools, no distribution
5. **Limited context** - No minimap, no zoom indicator, no coordinate display

### Missing Features
1. **Box selection** - Can't select multiple points or contours at once
2. **Alignment tools** - No way to align points or contours
3. **Distribution tools** - No way to space points evenly
4. **Measurements** - No distance/angle display during editing
5. **Real-time validation** - Errors only shown after action, not during
6. **Undo history UI** - Can undo but can't see what you're undoing

## Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────┐
│                     React Application                        │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────┐  │
│  │  Toolbar       │  │  Properties    │  │   Canvas     │  │
│  │  - Tools       │  │  Panel         │  │   Container  │  │
│  │  - File ops    │  │  - Selection   │  │              │  │
│  └────────────────┘  └────────────────┘  └──────┬───────┘  │
│                                                   │          │
│  ┌────────────────────────────────────────────┐  │          │
│  │       Editor State (React Context)         │  │          │
│  │  - Document (contours, selection, undo)    │  │          │
│  │  - Tools (active tool, tool state)         │  │          │
│  │  - View (camera, zoom, grid settings)      │  │          │
│  └────────────────────────────────────────────┘  │          │
│                                                   │          │
└───────────────────────────────────────────────────┼──────────┘
                                                    │
                          ┌─────────────────────────▼──────┐
                          │     Engine Integration         │
                          │  ┌──────────────────────────┐  │
                          │  │  EditorCanvas            │  │
                          │  │  - Creates Game instance │  │
                          │  │  - Manages render loop   │  │
                          │  │  - Bridges React ↔ Game  │  │
                          │  └──────────────────────────┘  │
                          │                                │
                          │  ┌──────────────────────────┐  │
                          │  │  Game Instance           │  │
                          │  │  - Camera                │  │
                          │  │  - Renderer (Draw API)   │  │
                          │  │  - SurfaceRenderer       │  │
                          │  └──────────────────────────┘  │
                          └────────────────────────────────┘
```

### Core Principles

1. **React owns state** - All editor state lives in React (not game entities)
2. **Engine is a renderer** - Game instance is just a rendering backend
3. **Unidirectional data flow** - React → Engine (not bidirectional)
4. **Canvas only for visuals** - All interaction (mouse, keyboard) handled by React
5. **Tools are functions** - Tool behavior is pure logic, not entities

## Core Systems

### 1. Document Model

The document model manages terrain data, selection, and undo/redo.

```typescript
interface EditorDocument {
  // Terrain data
  terrain: {
    defaultDepth: number;
    contours: EditorContour[];
  };

  // Selection state
  selection: {
    contours: Set<number>;        // Selected contour indices
    points: Map<number, Set<number>>; // Selected points per contour
  };

  // Undo/redo
  undoStack: Command[];
  redoStack: Command[];
}

interface EditorContour {
  id: string;                     // Stable ID for tracking
  name?: string;
  height: number;
  controlPoints: V2d[];
}
```

**Key Changes from Current:**
- Stable IDs for contours (not array indices)
- Can select multiple contours at once
- Simplified point selection (no "select all points in contour" state)

### 2. Tool System

Tools handle user interaction and produce commands.

```typescript
interface Tool {
  // Tool metadata
  id: string;
  name: string;
  icon: string;
  cursor: string;

  // Lifecycle
  onActivate(context: ToolContext): void;
  onDeactivate(context: ToolContext): void;

  // Interaction
  onMouseDown(event: MouseEvent, context: ToolContext): void;
  onMouseMove(event: MouseEvent, context: ToolContext): void;
  onMouseUp(event: MouseEvent, context: ToolContext): void;
  onKeyDown(event: KeyboardEvent, context: ToolContext): void;

  // Rendering (draws tool-specific overlays)
  render(draw: DrawAPI, context: ToolContext): void;
}

interface ToolContext {
  document: EditorDocument;
  camera: Camera;
  dispatch: (command: Command) => void;
}
```

**Built-in Tools:**
1. **Select Tool** - Click to select, drag to box select, handles for moving
2. **Pen Tool** - Click to add points to new or existing contours
3. **Edit Tool** - Specialized for editing contours (add/remove points on spline)
4. **Pan Tool** - Camera navigation
5. **Measure Tool** - Click two points to measure distance/angle

### 3. Command System

Commands encapsulate all mutations for undo/redo.

```typescript
interface Command {
  description: string;
  execute(doc: EditorDocument): void;
  undo(doc: EditorDocument): void;
}

// Example commands
class MovePointsCommand implements Command { ... }
class AddContourCommand implements Command { ... }
class DeleteContoursCommand implements Command { ... }
class AlignPointsCommand implements Command { ... }
class DistributePointsCommand implements Command { ... }
```

**Key Changes from Current:**
- Commands operate on document directly (not through entity mutation)
- Batch commands for complex operations
- Commands are serializable (for future collaboration features)

### 4. Rendering System

The rendering system uses the game engine but is controlled by React.

```typescript
interface EditorRenderer {
  // Core rendering
  renderTerrain(terrain: TerrainDefinition): void;
  renderContours(contours: EditorContour[], camera: Camera): void;
  renderSelection(selection: Selection, contours: EditorContour[]): void;

  // Overlays
  renderGrid(camera: Camera, settings: GridSettings): void;
  renderMeasurements(measurements: Measurement[]): void;
  renderValidationErrors(errors: ValidationError[]): void;

  // Tool-specific
  renderToolOverlay(tool: Tool, context: ToolContext): void;
}
```

**Rendering Layers (back to front):**
1. Terrain surface (water/land via SurfaceRenderer)
2. Grid (optional)
3. Contour splines (non-selected: subtle, selected: highlighted)
4. Control points (non-selected: small, selected: large with handles)
5. Validation errors (red overlays)
6. Measurements and annotations
7. Tool overlay (current tool's visual feedback)
8. Selection box (during box select)

### 5. Interaction System

All mouse/keyboard interaction is handled by React, not the canvas.

```typescript
interface InteractionManager {
  // Setup
  attachToCanvas(canvas: HTMLCanvasElement): void;
  setActiveTool(tool: Tool): void;

  // Hit testing (utilities for tools)
  hitTestPoint(worldPos: V2d, contours: EditorContour[]): PointHit | null;
  hitTestSpline(worldPos: V2d, contours: EditorContour[]): SplineHit | null;
  hitTestBox(worldBox: Box2d, contours: EditorContour[]): BoxHit;

  // Coordinate conversion
  screenToWorld(screenPos: V2d, camera: Camera): V2d;
  worldToScreen(worldPos: V2d, camera: Camera): V2d;
}
```

**Key Concept:**
- Canvas has `pointer-events: none` for actual hit testing
- Transparent overlay div handles all mouse events
- Events are transformed to world coordinates and passed to active tool
- This allows HTML UI to work naturally (buttons, panels, etc.)

## UI Design

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Toolbar                                           [File Menu]│
│ [◉Select] [✎Pen] [✂Edit] [⊕Pan] [📏Measure] [Undo] [Redo] │
├─────────────────────┬───────────────────────────────────────┤
│ Properties Panel    │                                       │
│                     │                                       │
│ Selected Contour:   │                                       │
│ ┌─────────────────┐ │         Canvas Area                  │
│ │ Island Shore    │ │                                       │
│ └─────────────────┘ │                                       │
│                     │                                       │
│ Height: [0 ft]      │                                       │
│ Points: 12          │                                       │
│                     │                                       │
│ [Align] [Distribute]│                                       │
│                     │                                       │
│ ┌─────────────────┐ │                                       │
│ │ Contour List    │ │                                       │
│ │ • Ocean Floor   │ │                                       │
│ │ • Island Shore  │ │                                       │
│ │ • Beach         │ │                                       │
│ │ • Hills         │ │                                       │
│ └─────────────────┘ │                                       │
│                     │                                       │
│                     │                                       │
├─────────────────────┴───────────────────────────────────────┤
│ Status: 2 contours selected • X: 1234.5 Y: -567.8 • Zoom: 1x│
└─────────────────────────────────────────────────────────────┘
```

### Key UI Components

#### 1. Toolbar
- Tool buttons (select, pen, edit, pan, measure)
- Undo/redo buttons with history dropdown
- File menu (new, open, save, export)
- View controls (zoom, fit to view, grid toggle)

#### 2. Properties Panel
- **Selection info** - Shows what's selected
- **Contour properties** - Name, height, point count
- **Transform tools** - Align, distribute, flip, rotate
- **Contour list** - All contours with visibility toggle

#### 3. Canvas Overlay
- **Real-time measurements** - Distance/angle during drag
- **Snap indicators** - Visual feedback when snapping
- **Validation warnings** - Inline error indicators
- **Context tooltips** - Hover info

#### 4. Status Bar
- Selection count
- Current mouse coordinates
- Current zoom level
- Dirty state indicator

### Visual Feedback Enhancements

1. **During Dragging:**
   - Ghost preview of final position
   - Snap lines when aligning with other points
   - Distance and angle measurements
   - Grid snap indicator

2. **Validation:**
   - Real-time self-intersection detection (red overlay)
   - Too-few-points warning (yellow outline)
   - Invalid hierarchy warning (purple overlay)

3. **Selection:**
   - Bounding box with corner handles for selected contours
   - Edge midpoint handles for adding points
   - Multi-selection shows combined bounding box
   - Selected points are larger with drag handles

## Feature Roadmap

### Phase 1: Foundation (Week 1-2)
**Goal:** Get basic editor working with new architecture

- [ ] React app scaffolding with TypeScript
- [ ] EditorCanvas component (bridges React → Game)
- [ ] Basic document model with undo/redo
- [ ] Simple tool system (just Select tool)
- [ ] Render contours using existing ContourRenderer
- [ ] File operations (open, save)
- [ ] Basic property panel

**Success Criteria:** Can open a terrain file, select contours, move points, save changes

### Phase 2: Core Tools (Week 2-3)
**Goal:** Essential editing capabilities

- [ ] Pen tool (create new contours)
- [ ] Edit tool (add/remove points on splines)
- [ ] Pan tool (camera navigation)
- [ ] Box selection
- [ ] Multi-point dragging
- [ ] Keyboard shortcuts

**Success Criteria:** Can create terrain from scratch using tools

### Phase 3: Visual Feedback (Week 3-4)
**Goal:** Better feedback during editing

- [ ] Real-time validation with visual indicators
- [ ] Measurements during drag operations
- [ ] Grid system with snap-to-grid
- [ ] Enhanced selection visuals (bounding boxes, handles)
- [ ] Hover preview for tool actions
- [ ] Status bar with coordinates and zoom

**Success Criteria:** User always knows what will happen before it happens

### Phase 4: Advanced Manipulation (Week 4-5)
**Goal:** Professional-grade editing tools

- [ ] Alignment tools (align left, right, top, bottom, center)
- [ ] Distribution tools (distribute horizontally/vertically)
- [ ] Transform tools (flip, rotate)
- [ ] Measure tool (persistent measurements)
- [ ] Snap to points/angles
- [ ] Constrain drag to axis (shift+drag)

**Success Criteria:** Can precisely position and space points

### Phase 5: Polish (Week 5-6)
**Goal:** Production-ready editor

- [ ] Undo history UI (see/navigate undo stack)
- [ ] Keyboard shortcuts panel (help overlay)
- [ ] Improved contour list (search, filter, reorder)
- [ ] Export options (PNG preview, different file formats)
- [ ] Settings panel (grid size, snap distance, colors)
- [ ] Performance optimization (large terrain handling)

**Success Criteria:** Editor feels polished and professional

### Future Enhancements (Post-Launch)
- Layers system for organizing contours
- Templates/presets for common shapes
- Minimap for navigation
- Collaborative editing (operational transform)
- Animation timeline for dynamic terrain
- Procedural generation tools

## Technical Decisions

### Tech Stack

**UI Layer:**
- React 18 (or Preact if bundle size matters)
- TypeScript (strict mode)
- CSS Modules or Styled Components
- Zustand or Context API for state management

**Rendering Layer:**
- Existing game engine (Game, Draw API, Camera)
- SurfaceRenderer for terrain preview
- Custom contour rendering (reuse existing spline code)

**Build:**
- Vite (faster than Parcel for development)
- Or keep Parcel if already working well

### Key Patterns

**1. Separation of Concerns**
```
UI (React)              Logic (TS)                Engine (Game)
├─ Toolbar              ├─ Document               ├─ Camera
├─ Properties           ├─ Tools                  ├─ Renderer
├─ Canvas Container     ├─ Commands               └─ SurfaceRenderer
└─ Status Bar           └─ Validators
```

**2. State Management**
- Single source of truth: `EditorState` object
- React Context for global state (document, tools, view)
- Local state for UI-only concerns (dropdown open, etc.)
- Commands for all document mutations

**3. Tool Lifecycle**
```typescript
// Tool activation
activeTool.onDeactivate()  // Clean up old tool
newTool.onActivate()        // Set up new tool
setActiveTool(newTool)      // Update state

// Event flow
MouseEvent → InteractionManager → ActiveTool → Command → Document → Re-render
```

**4. Rendering Loop**
```typescript
// React controls when to render
function EditorCanvas() {
  const rafRef = useRef<number>();
  const gameRef = useRef<Game>();

  useEffect(() => {
    function renderLoop() {
      gameRef.current?.draw();  // Engine renders
      rafRef.current = requestAnimationFrame(renderLoop);
    }
    renderLoop();
    return () => cancelAnimationFrame(rafRef.current!);
  }, []);

  // React doesn't re-render on every frame
  // Only when state changes
}
```

### File Structure

```
src/editor-v2/
├── index.tsx                    # Entry point
├── EditorApp.tsx                # Main React component
├── EditorCanvas.tsx             # Canvas integration component
│
├── state/
│   ├── EditorContext.tsx        # React context provider
│   ├── useDocument.ts           # Document state hook
│   ├── useTools.ts              # Tool state hook
│   └── useView.ts               # View state hook
│
├── model/
│   ├── Document.ts              # Document model
│   ├── Contour.ts               # Contour type
│   ├── Selection.ts             # Selection utilities
│   └── Validation.ts            # Validation logic
│
├── commands/
│   ├── Command.ts               # Base command interface
│   ├── MovePointsCommand.ts
│   ├── AddContourCommand.ts
│   ├── AlignCommand.ts
│   └── ... (other commands)
│
├── tools/
│   ├── Tool.ts                  # Base tool interface
│   ├── SelectTool.ts
│   ├── PenTool.ts
│   ├── EditTool.ts
│   ├── PanTool.ts
│   └── MeasureTool.ts
│
├── interaction/
│   ├── InteractionManager.ts   # Mouse/keyboard handling
│   ├── HitTesting.ts            # Hit test utilities
│   └── CoordinateTransform.ts   # Screen ↔ world conversion
│
├── rendering/
│   ├── EditorRenderer.ts        # Main rendering coordinator
│   ├── ContourRenderer.ts       # Contour visualization
│   ├── SelectionRenderer.ts     # Selection visuals
│   ├── GridRenderer.ts          # Grid overlay
│   └── OverlayRenderer.ts       # Measurements, errors, etc.
│
├── ui/
│   ├── Toolbar.tsx
│   ├── PropertiesPanel.tsx
│   ├── ContourList.tsx
│   ├── StatusBar.tsx
│   └── components/              # Shared UI components
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Panel.tsx
│       └── ...
│
└── utils/
    ├── FileIO.ts                # Load/save operations
    ├── Geometry.ts              # Geometric utilities
    └── Keyboard.ts              # Keyboard shortcut manager
```

## Open Questions

### For Discussion

1. **Canvas interaction method**
   - Option A: Transparent overlay div (recommended)
   - Option B: Canvas mouse events with manual hit testing
   - Option C: Mix of both (canvas for drag, HTML for buttons)

2. **State management library**
   - Option A: React Context + useReducer (simple, built-in)
   - Option B: Zustand (lightweight, good DX)
   - Option C: Redux Toolkit (overkill but robust)

3. **Undo/redo implementation**
   - Option A: Command pattern (current approach, works well)
   - Option B: Immutable snapshots (simpler but memory-heavy)
   - Option C: Event sourcing (overkill but enables collaboration)

4. **Grid system**
   - Should grid be part of terrain or editor-only?
   - Fixed grid size or user-adjustable?
   - Grid in world units (feet) or screen pixels?

5. **Validation timing**
   - Validate on every change (might be slow)?
   - Validate on idle (debounced)?
   - Validate on demand (when saving)?

6. **Performance concerns**
   - How many contours until we need optimization?
   - Should we use spatial indexing for hit testing?
   - Virtual scrolling for contour list?

### Technical Risks

1. **React ↔ Engine bridge complexity**
   - Risk: Synchronization bugs between React state and game rendering
   - Mitigation: Unidirectional flow, clear ownership boundaries

2. **Hit testing performance**
   - Risk: Slow hit testing with many contours/points
   - Mitigation: Spatial indexing (quadtree), early rejection tests

3. **Undo memory usage**
   - Risk: Large undo stacks consume memory
   - Mitigation: Limit stack size, use delta compression for commands

4. **Real-time validation cost**
   - Risk: Validation too slow for interactive editing
   - Mitigation: Debounce validation, incremental validation, Web Workers

## Success Metrics

**Functional Goals:**
- Can edit 100-contour terrain without lag
- All operations are undoable
- No data loss on save/load
- Validation catches all invalid states

**UX Goals:**
- New users can create simple terrain in < 5 minutes
- Advanced features are discoverable
- No dead ends (can always undo back to safety)
- Visual feedback is immediate (< 16ms)

**Code Quality Goals:**
- < 5000 lines for core editor (excluding UI components)
- < 3 levels of component nesting
- 80%+ test coverage for model/commands/tools
- Zero runtime errors in normal usage

## Next Steps

1. Review this document and discuss open questions
2. Create proof-of-concept for React ↔ Engine integration
3. Implement Phase 1 foundation
4. User testing with Phase 1 build
5. Iterate based on feedback
