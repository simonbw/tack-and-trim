# Tutorial System Gameplan

## Current State

The game launches directly into gameplay in `src/game/index.tsx`:

```typescript
const boat = game.addEntity(new Boat());
game.addEntity(new PlayerBoatController(boat));
game.addEntity(new CameraController(boat, game.camera));
```

**Key findings:**
- **Boat entity** (`src/game/boat/Boat.ts:18`) has `id = "boat"` - can be retrieved via `game.entities.getById("boat")`
- **Anchor** (`src/game/boat/Anchor.ts:28`) has `getState()` returning `"stowed" | "deploying" | "deployed" | "retrieving"`
- **Sail** (`src/game/boat/Sail.ts:65`) has `hoistAmount` (0-1) and `getHoistAmount()` method
- **Sheet** (`src/game/boat/Sheet.ts:35`) has `getSheetPosition()` returning 0-1 (0 = trimmed in, 1 = eased out)
- **Hull body** (`boat.hull.body`) provides position and angle for tracking movement/heading
- **ReactEntity** (`src/core/ReactEntity.ts`) provides HTML overlay rendering via Preact
- **Custom events** defined in `src/config/CustomEvent.ts` with automatic handler mapping

**Relevant files:**
- `src/game/boat/Boat.ts` - Main boat entity with all components
- `src/game/boat/Anchor.ts:81` - `getState()` method
- `src/game/boat/Sail.ts:202-204` - `getHoistAmount()` method
- `src/game/boat/Sheet.ts:128` - `getSheetPosition()` method
- `src/game/wind/WindInfo.ts` - Wind direction info for detecting upwind/downwind
- `src/core/ReactEntity.ts` - Base class for HTML overlay entities

## Desired Changes

Create a self-contained tutorial system that guides players through basic sailing mechanics via popup text boxes with objectives. The tutorial should:

1. Be completely self-contained in `src/game/tutorial/` folder
2. Not require any modifications to existing boat/sail/anchor classes
3. Observe boat state each tick to detect objective completion
4. Use clean UI with styled text boxes showing instructions and objectives
5. Progress automatically when objectives are completed

### Tutorial Steps

| Step | Title | Objective | Completion Condition |
|------|-------|-----------|---------------------|
| 1 | Raise Your Anchor | Press F to raise anchor | `anchor.getState() === "stowed"` |
| 2 | Raise Your Sails | Press R to raise sails | `rig.sail.hoistAmount > 0.9` |
| 3 | Get Moving | Sail 50 feet from start | `distance(currentPos, startPos) > 50` |
| 4 | Steering | Turn 90 degrees using A/D | `|headingChange| > π/2` |
| 5 | Trim Your Sails | Trim mainsheet with W/S when sailing upwind | `mainsheet.position changed while pointing upwind` |
| 6 | Tacking | Tack and return near start | `crossed wind + near startPos` |

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         index.tsx                                │
│  - Creates all game entities as before                           │
│  - Adds TutorialManager after boat is created                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     TutorialManager                              │
│  - Holds array of TutorialStep definitions                       │
│  - Tracks currentStepIndex                                       │
│  - Creates/destroys TutorialPopup for each step                 │
│  - Checks completion conditions each tick                        │
│  - Dispatches tutorialStepComplete events                        │
│  - Stores state needed for step conditions (startPos, etc)      │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐    ┌─────────────────────────────────────┐
│   TutorialPopup     │    │         TutorialStep                 │
│  extends ReactEntity│    │  (interface/type, not class)         │
│  - Renders text box │    │  - title: string                     │
│  - Shows title      │    │  - description: string               │
│  - Shows objective  │    │  - objective: string                 │
│  - Shows key hint   │    │  - keyHint?: string                  │
│  - Progress dots    │    │  - checkComplete: (ctx) => boolean   │
│  - Auto-positions   │    │  - onStart?: (ctx) => void           │
└─────────────────────┘    └─────────────────────────────────────┘
```

### Event Flow

1. **Game loads** → `TutorialManager.onAdd()` reads boat entity, starts step 1
2. **Step starts** → Manager creates `TutorialPopup` with step info, calls `onStart()` if defined
3. **Each tick** → Manager calls `checkComplete()` for current step
4. **Objective met** → Manager dispatches `tutorialStepComplete`, destroys popup, advances to next step
5. **All steps done** → Manager dispatches `tutorialComplete`, destroys self

### CSS Styling

The tutorial popup should:
- Appear in top-center of screen
- Have semi-transparent dark background with rounded corners
- Show title prominently, description below, objective highlighted
- Show keyboard key hints in styled "key caps"
- Show progress indicator (dots for each step)
- Animate in/out smoothly

## Files to Modify

### New Files

- `src/game/tutorial/TutorialManager.ts` - Main tutorial controller entity
  - Extends `BaseEntity`
  - Holds step definitions and current state
  - Retrieves boat via `game.entities.getById("boat")`
  - Creates/manages `TutorialPopup` instance
  - Checks completion conditions in `onTick()`
  - Dispatches tutorial events

- `src/game/tutorial/TutorialPopup.tsx` - Tutorial UI overlay entity
  - Extends `ReactEntity`
  - Receives step data as constructor props
  - Renders styled text box with title, description, objective
  - Shows key hints and progress indicator
  - Handles entrance/exit animations

- `src/game/tutorial/TutorialPopup.css` - Styling for tutorial popup
  - Centered positioning
  - Semi-transparent background
  - Typography hierarchy
  - Key cap styling
  - Progress dots
  - Animations

- `src/game/tutorial/tutorialSteps.ts` - Step definitions
  - Array of `TutorialStep` objects
  - Each step has title, description, objective, completion check
  - Keeps step logic separate from manager

- `src/game/tutorial/TutorialStep.ts` - Type definitions
  - `TutorialStep` interface
  - `TutorialContext` type (references to boat, wind, positions, etc.)
  - Helper types for completion conditions

- `src/game/tutorial/index.ts` - Barrel export
  - Exports `TutorialManager` and any public types

### Modified Files

- `src/config/CustomEvent.ts` - Add tutorial events
  ```typescript
  export type CustomEvents = {
    /** Fired when a tutorial step is completed */
    tutorialStepComplete: { stepIndex: number; stepTitle: string };
    /** Fired when the entire tutorial is completed */
    tutorialComplete: {};
  };
  ```

- `src/game/index.tsx` - Add tutorial manager
  - Import `TutorialManager` from `./tutorial`
  - Add `game.addEntity(new TutorialManager())` after boat is created

## Execution Order

### Phase 1: Foundation (Sequential - dependencies)

1. **Modify `src/config/CustomEvent.ts`**
   - Add `tutorialStepComplete` and `tutorialComplete` event types
   - Must be done first as TutorialManager will reference these

### Phase 2: Type Definitions (Parallel - no dependencies between them)

2. **Create `src/game/tutorial/TutorialStep.ts`**
   - Define `TutorialStep` interface
   - Define `TutorialContext` type with boat references

### Phase 3: Core Implementation (Sequential - tutorialSteps needs TutorialStep)

3. **Create `src/game/tutorial/tutorialSteps.ts`**
   - Define all 6 tutorial steps with completion conditions
   - Import types from TutorialStep.ts

4. **Create `src/game/tutorial/TutorialPopup.css`**
   - Define all popup styling

5. **Create `src/game/tutorial/TutorialPopup.tsx`**
   - Implement ReactEntity subclass for UI
   - Import CSS

### Phase 4: Manager (Sequential - needs TutorialPopup and tutorialSteps)

6. **Create `src/game/tutorial/TutorialManager.ts`**
   - Import TutorialPopup and tutorialSteps
   - Implement step progression logic
   - Handle completion checking

7. **Create `src/game/tutorial/index.ts`**
   - Barrel export for clean imports

### Phase 5: Integration (Sequential - needs all above)

8. **Modify `src/game/index.tsx`**
   - Import and add TutorialManager after boat creation

## Detailed Type Definitions

```typescript
// TutorialStep.ts

import type { Boat } from "../boat/Boat";
import type { WindInfo } from "../wind/WindInfo";
import type { V2d } from "../../core/Vector";

/** Context passed to step completion checks and callbacks */
export interface TutorialContext {
  boat: Boat;
  windInfo: WindInfo;
  // State tracked by manager
  stepStartPosition: V2d;
  stepStartHeading: number;
  stepStartMainsheetPosition: number;
  stepStartTack: "port" | "starboard"; // Which tack we started on
  tutorialStartPosition: V2d; // Where boat was when tutorial began
}

/** Definition of a single tutorial step */
export interface TutorialStep {
  /** Step title shown prominently */
  title: string;
  /** Explanation text */
  description: string;
  /** Current objective shown highlighted */
  objective: string;
  /** Optional keyboard hint (e.g., "F", "A/D") */
  keyHint?: string;
  /** Called each tick - return true when objective is complete */
  checkComplete: (ctx: TutorialContext) => boolean;
  /** Optional setup when step starts */
  onStart?: (ctx: TutorialContext) => void;
}
```

## Detailed Step Definitions

```typescript
// tutorialSteps.ts (pseudocode)

export const tutorialSteps: TutorialStep[] = [
  {
    title: "Raise Your Anchor",
    description: "Your boat is anchored. Let's get moving!",
    objective: "Press F to raise the anchor",
    keyHint: "F",
    checkComplete: (ctx) => ctx.boat.anchor.getState() === "stowed",
  },
  {
    title: "Raise Your Sails",
    description: "With the anchor up, you need wind power.",
    objective: "Press R to raise your sails",
    keyHint: "R",
    checkComplete: (ctx) => ctx.boat.rig.sail.getHoistAmount() > 0.9,
  },
  {
    title: "Get Moving",
    description: "Your sails will catch the wind. Let the boat move!",
    objective: "Sail 50 feet from your starting position",
    checkComplete: (ctx) => {
      const distance = ctx.boat.getPosition().distanceTo(ctx.stepStartPosition);
      return distance > 50;
    },
  },
  {
    title: "Steering",
    description: "The tiller controls your direction. Push left to turn right!",
    objective: "Turn at least 90 degrees",
    keyHint: "A / D",
    checkComplete: (ctx) => {
      const headingChange = Math.abs(
        normalizeAngle(ctx.boat.hull.body.angle - ctx.stepStartHeading)
      );
      return headingChange > Math.PI / 2;
    },
  },
  {
    title: "Trim Your Sails",
    description: "Trimming adjusts how tight your sail is to the wind.",
    objective: "Trim the mainsheet while pointing upwind",
    keyHint: "W / S",
    checkComplete: (ctx) => {
      const isUpwind = isPointingUpwind(ctx.boat, ctx.windInfo);
      const trimChanged = Math.abs(
        ctx.boat.mainsheet.getSheetPosition() - ctx.stepStartMainsheetPosition
      ) > 0.1;
      return isUpwind && trimChanged;
    },
  },
  {
    title: "Tacking",
    description: "Tacking turns through the wind to change direction.",
    objective: "Tack and sail back toward your starting point",
    keyHint: "A / D",
    checkComplete: (ctx) => {
      const currentTack = getCurrentTack(ctx.boat, ctx.windInfo);
      const tackChanged = currentTack !== ctx.stepStartTack;
      const nearStart = ctx.boat.getPosition().distanceTo(ctx.tutorialStartPosition) < 30;
      return tackChanged && nearStart;
    },
  },
];
```

## UI Component Structure

```tsx
// TutorialPopup.tsx (pseudocode)

const TutorialPopupContent = ({ step, stepIndex, totalSteps }) => (
  <div class="tutorial-popup">
    <div class="tutorial-header">
      <h2 class="tutorial-title">{step.title}</h2>
    </div>
    <p class="tutorial-description">{step.description}</p>
    <div class="tutorial-objective">
      <span class="objective-label">Objective:</span>
      <span class="objective-text">{step.objective}</span>
    </div>
    {step.keyHint && (
      <div class="tutorial-keyhint">
        Press <kbd>{step.keyHint}</kbd>
      </div>
    )}
    <div class="tutorial-progress">
      {range(totalSteps).map(i => (
        <span class={`progress-dot ${i <= stepIndex ? 'completed' : ''}`} />
      ))}
    </div>
  </div>
);
```

## CSS Styling Overview

```css
/* TutorialPopup.css - key styles */

.tutorial-popup {
  position: fixed;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 20, 40, 0.9);
  border: 2px solid rgba(100, 150, 200, 0.5);
  border-radius: 12px;
  padding: 20px 30px;
  min-width: 300px;
  max-width: 450px;
  color: #e0e8f0;
  font-family: sans-serif;
  animation: slideIn 0.3s ease-out;
}

.tutorial-title {
  color: #4a9eff;
  margin: 0 0 10px 0;
}

.tutorial-objective {
  background: rgba(74, 158, 255, 0.15);
  padding: 10px 15px;
  border-radius: 6px;
  margin: 15px 0;
}

kbd {
  background: linear-gradient(180deg, #555 0%, #333 100%);
  border: 1px solid #666;
  border-radius: 4px;
  padding: 2px 8px;
  font-family: monospace;
  box-shadow: 0 2px 0 #222;
}

.progress-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #333;
  border: 1px solid #555;
}

.progress-dot.completed {
  background: #4a9eff;
  border-color: #4a9eff;
}
```

## Summary

This tutorial system is designed to be:

1. **Self-contained** - All code in `src/game/tutorial/`, only touches `CustomEvent.ts` and `index.tsx`
2. **Non-invasive** - Reads boat state, doesn't modify any existing classes
3. **Extensible** - Easy to add/remove/reorder steps in `tutorialSteps.ts`
4. **Clean UI** - Professional-looking popup with good visual hierarchy
5. **Event-driven** - Uses custom events for external systems to react to tutorial progress

The TutorialManager acts as the coordinator, checking completion conditions each tick and managing the UI popup lifecycle. Step definitions are data-driven, making it easy to tune objectives and add new steps.
