# Boat Definition Editor

Dev tool for authoring and tuning `BoatConfig` objects. Standalone page like the terrain editor (`src/boat-editor.html`), reusing the game engine for rendering.

## Two Phases

### Phase 1: Config Editor + 3D Preview

Edit numeric config values with sliders/inputs, see the boat update live in a 3D orbit view. This is the core tool — useful immediately for tuning hull shapes, sail geometry, and rigging layout.

### Phase 2: Physics Debugger

Run the boat physics in the editor with simulated wind/water. Step through individual ticks and visualize forces (lift, drag, righting moment, buoyancy) as arrows overlaid on the boat. This is the tool for making the physics *feel* right, but it's significantly more complex since it needs to run the full physics loop, buoyancy system, and sail simulation standalone.

---

## Phase 1: Config Editor + 3D Preview

### Architecture

Follow the terrain editor pattern (Command + Listener):

```
BoatEditorController (BaseEntity)
├── BoatEditorDocument         — BoatConfig state, undo/redo, dirty tracking
├── BoatEditorCameraController — orbit via pitch/roll, zoom, preset views
├── BoatPreviewEntity          — renders the boat from the document's config
├── BoatEditorUI               — property panels, file I/O buttons
└── WaterPlaneEntity           — flat water surface for reference
```

### 3D Orbit Camera

The tilt projection system already gives us 3D-looking rendering by feeding pitch/roll into `TiltTransform`. An "orbit camera" just means letting the user control those angles directly:

- **Drag to orbit**: mouse drag → pitch and yaw (mapped to the tilt transform angles)
- **Scroll to zoom**: camera zoom
- **Preset views**: buttons for "Top", "Side", "Bow", "3/4" that animate to specific angle combos
- No actual 3D camera needed — just controlling the inputs to the existing projection

The boat sits on a flat shaded water plane so you can see the waterline, draft, and freeboard.

### Property Panels

One collapsible panel per `BoatConfig` section. Each property is a labeled slider (with min/max/step) or number input. Changing a value creates an `EditPropertyCommand` for undo/redo.

| Panel | Key Properties |
|-------|---------------|
| **Hull** | mass, draft, deckHeight, skinFrictionCoefficient, colors |
| **Hull Shape** | vertex editor (see below) |
| **Keel** | draft, chord, color |
| **Rudder** | position, length, draft, chord, maxSteerAngle |
| **Rig** | mastPosition, boomLength, boomMass |
| **Mainsail** | liftScale, dragScale, optimalAngle, numNodes, sailHeight |
| **Jib** | sail params + forestay attachment |
| **Sheets** | boomAttachRatio, min/maxLength, trimSpeed |
| **Tilt/Buoyancy** | inertia, damping, righting moment, max angles, zHeights |
| **Anchor** | bowAttachPoint, maxRodeLength, mass, drag |
| **Bilge/Damage** | thresholds, repair rates |

### Hull Shape Editing

The hull currently has three hand-placed vertex rings (deck, waterline, bottom). Two approaches worth considering — could support both:

**A) Direct vertex editing (current model)**
- Top-down view shows the three rings as draggable points, color-coded
- Enforce port/starboard symmetry (edit one side, mirror to the other)
- Good for fine-tuning weird shapes

**B) Parametric hull generation (new)**
- Define hull from parameters: length, beam, bow shape (sharp→blunt), stern shape, rocker, deadrise angle
- Generate all three rings procedurally
- Much easier to explore the design space — you're tweaking 6-8 meaningful params instead of placing 30+ vertices
- Can still allow manual vertex overrides on top

Parametric feels like the better default for a dev tool. You'd define a hull generator function:

```typescript
function generateHullVertices(params: HullShapeParams): {
  vertices: V2d[];        // deck ring
  waterlineVertices: V2d[];
  bottomVertices: V2d[];
}
```

Where `HullShapeParams` might be:
- `length` — overall length
- `beam` — max width
- `bowFineness` — 0 (blunt) to 1 (sharp/pointy)
- `sternFineness` — 0 (transom) to 1 (double-ender)
- `bowRocker` — upward curve of the bow
- `deadriseAngle` — V-shape of the bottom
- `waterlineRatio` — how much narrower the waterline is than the deck
- `bottomRatio` — how much narrower the bottom is than the waterline
- `vertexCount` — resolution

This could live in the game code too (not just the editor), so configs could store either explicit vertices or parametric params.

### Visual Overlays

Static indicators that update live as you edit values:

- **Waterline**: the water plane intersection, always visible
- **Center of gravity**: dot on the boat (derived from mass distribution + keel weight)
- **Draft line**: side view showing how deep the keel/rudder extend
- **Measurements**: length, beam, freeboard, draft as labeled dimensions
- **Theoretical hull speed**: `1.34 × √(waterline length in ft)` displayed as a number

### File I/O

- **Load preset**: dropdown of existing configs (StarterDinghy, StarterBoat, etc.)
- **Export JSON**: serialize the full `BoatConfig` to a JSON file
- **Export TypeScript**: generate a `const myBoat: BoatConfig = { ... }` file
- **Import JSON**: load a previously saved config
- Use File System Access API like the terrain editor, with IndexedDB fallback for file handles

### Undo/Redo

Same Command pattern as terrain editor:

```typescript
interface BoatEditorCommand {
  execute(): void;
  undo(): void;
  description: string;  // "Change hull mass to 450"
}
```

Slider drags should coalesce — dragging a slider from 400→500 is one undo step, not 100 steps.

---

## Phase 2: Physics Debugger (Future)

This is substantially more complex — needs the physics loop, buoyancy, sail sim, wind, and water surface running in an isolated/controllable way.

### Core Idea

Run the boat in a controlled physics sandbox where you can:
- Set wind speed/direction with a dial
- Play/pause/step the simulation
- Step forward one tick at a time (1/120s)
- See force vectors overlaid on the boat at each tick

### Force Visualization

At each tick, capture and render as colored arrows:
- **Sail forces** (lift + drag per sail) — applied at center of effort
- **Hydrodynamic forces** (keel lift/drag, rudder lift/drag, hull drag) — at their application points
- **Buoyancy forces** — at each buoyancy sample point
- **Righting moment** — as a torque arc
- **Net force + torque** — summary arrow at center of mass

### Stepping Interface

- Play/pause button
- Step forward 1 tick / 10 ticks / 100 ticks
- Speed slider (0.1x to 10x)
- Timeline scrubber showing recent history (last N ticks), letting you scrub back to see what happened
- Each tick's state (position, velocity, forces) logged to a ring buffer

### What Makes This Hard

- Need to instantiate boat physics without the full game world (or with a minimal stub world)
- Buoyancy needs water surface data — either fake a flat surface or run the water sim too
- Sail cloth sim needs wind field — simplest to use uniform wind
- Force capture requires instrumenting the physics code to record intermediate values that are currently computed and immediately consumed
- The timeline/scrubber means storing snapshots of state

### Possible Simplification

Start with just "play with uniform wind + flat water" and a force overlay — no stepping, no timeline. That's already useful for tuning. The step debugger can come later as the physics get more complex.

---

## Implementation Order

1. **Standalone page scaffolding** — `src/boat-editor.html`, entry point, minimal Game init
2. **BoatEditorDocument** — wraps a `BoatConfig` with undo/redo
3. **BoatPreviewEntity** — renders a boat from a config (statically, no physics)
4. **Orbit camera** — pitch/yaw control via mouse drag on tilt transform
5. **Property panels** — one panel per config section, wired to document commands
6. **Hull shape generator** — parametric hull from ~8 params
7. **Visual overlays** — waterline, measurements, center of gravity
8. **File I/O** — load presets, export/import JSON and TypeScript
9. *(Phase 2)* Physics sandbox with force visualization
10. *(Phase 2)* Tick stepping and timeline
