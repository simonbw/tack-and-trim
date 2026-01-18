# Mission System Implementation Plan

## Current State

### Relevant Files

| File | Purpose |
|------|---------|
| `src/game/tutorial/TutorialManager.ts` | Step-based progression orchestrator |
| `src/game/tutorial/TutorialStep.ts` | Step/objective interface definition |
| `src/game/tutorial/tutorialSteps.ts` | Step definitions with completion checks |
| `src/game/tutorial/TutorialPopup.tsx` | Preact UI for tutorial overlay |
| `src/game/Buoy.ts` | Physical world object with water physics |
| `src/game/GameController.ts` | Game initialization and event handling |
| `src/config/CustomEvent.ts` | Custom game event type definitions |
| `src/config/layers.ts` | Render layer definitions |
| `src/core/ReactEntity.ts` | Base class for Preact UI entities |

### Current Architecture

- **Entity-based system**: Everything extends `BaseEntity`, uses `@on` decorators for events
- **Tutorial pattern**: Manager orchestrates flow, Step defines objectives, Popup renders UI
- **No persistence**: Game state is not currently saved between sessions
- **Event-driven**: Custom events dispatched via `game.dispatch()` for cross-system communication

---

## Desired Changes

Implement a mission system with:

1. **Mission Spots** - Physical locations in the world that players can interact with
2. **Mission Definitions** - Data-driven mission/objective configurations
3. **Mission Manager** - Orchestrates active mission flow
4. **Unlock System** - Conditions that gate mission availability
5. **UI Components** - Preview, active HUD, and completion screens
6. **Persistence** - Save completed missions and unlocks to localStorage

---

## Files to Create

### Core Types & Definitions

```
src/game/mission/
├── MissionTypes.ts          - Core interfaces (Mission, Objective, UnlockCondition, etc.)
├── MissionRegistry.ts       - Static registry of all mission definitions
├── missions/                - Individual mission definition files
│   └── index.ts             - Barrel export for all missions
```

### Runtime System

```
src/game/mission/
├── MissionManager.ts        - Orchestrates active mission lifecycle
├── MissionContext.ts        - Runtime context passed to objective checks
├── MissionSpot.ts           - World entity for mission start locations
├── MissionPersistence.ts    - localStorage save/load for progress
```

### Objectives

```
src/game/mission/objectives/
├── ObjectiveChecker.ts      - Base interface for objective validation
├── ReachObjective.ts        - "Sail to location" checker
├── CheckpointObjective.ts   - "Pass through waypoints in order" checker
├── TimeObjective.ts         - "Complete within time limit" checker
├── SpeedObjective.ts        - "Achieve/maintain speed" checker
```

### World Entities

```
src/game/mission/
├── Waypoint.ts              - Visual marker for objectives (in-world)
├── Checkpoint.ts            - Gate/ring to pass through
```

### UI Components

```
src/game/mission/ui/
├── MissionPreviewPopup.tsx  - Shows when near a mission spot (screen-space)
├── MissionCompletePopup.tsx - Success/failure screen (screen-space)
├── MissionPreviewPopup.css
├── MissionCompletePopup.css
├── PauseMenu.tsx            - Pause menu with mission info (screen-space)
├── PauseMenu.css
```

### In-World UI Entities

```
src/game/mission/
├── WorldLabel.ts            - Text label rendered in world space near objects
├── OffscreenIndicator.ts    - Arrow pointing to off-screen objectives
```

### Config Updates

```
src/config/CustomEvent.ts    - Add mission events
src/config/layers.ts         - Add mission marker layer (optional)
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/game/GameController.ts` | Initialize MissionManager on game start, spawn MissionSpots |
| `src/config/CustomEvent.ts` | Add mission event types |
| `src/game/tutorial/TutorialManager.ts` | Dispatch event when tutorial completes (already does this) |

---

## Detailed Implementation

### Phase 1: Core Types & Infrastructure

#### 1.1 `src/game/mission/MissionTypes.ts`

```typescript
// Core mission definition
interface Mission {
  id: string;
  name: string;
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  category: "training" | "racing" | "exploration" | "challenge";

  // Where this mission starts (world coordinates)
  spotPosition: V2d;

  // What must be true to unlock this mission
  unlockConditions: UnlockCondition[];

  // The objectives to complete
  objectives: ObjectiveDefinition[];

  // Optional time limit in seconds
  timeLimit?: number;

  // What completing this mission unlocks
  rewards?: MissionReward;
}

// Unlock condition types
type UnlockCondition =
  | { type: "tutorialComplete" }
  | { type: "missionComplete"; missionId: string }
  | { type: "missionCount"; count: number; category?: string }
  | { type: "always" }; // For starter missions

// Objective types
type ObjectiveDefinition =
  | { type: "reach"; position: V2d; radius: number; label?: string }
  | { type: "checkpoint"; waypoints: V2d[]; labels?: string[] }
  | { type: "gate"; start: V2d; end: V2d; label?: string }
  | { type: "speed"; targetKnots: number; duration: number }
  | { type: "heading"; targetAngle: number; tolerance: number; duration: number }
  | { type: "survival"; noCollisions?: boolean };

// Rewards for completion
interface MissionReward {
  unlocksAchievement?: string;
  // Future: cosmetics, upgrades, etc.
}

// Runtime state for an active mission
interface ActiveMissionState {
  missionId: string;
  startTime: number;
  objectiveStates: ObjectiveState[];
  currentObjectiveIndex: number;
  failed: boolean;
  failReason?: string;
}

// Persisted save data
interface MissionSaveData {
  completedMissions: Record<string, MissionCompletion>;
  tutorialComplete: boolean;
}

interface MissionCompletion {
  completedAt: number;
  bestTime?: number;
  bonusObjectivesCompleted?: string[];
}
```

#### 1.2 `src/game/mission/MissionContext.ts`

Similar to TutorialContext - bundles game state for objective checking:

```typescript
interface MissionContext {
  boat: Boat;
  windInfo: WindInfo;
  waterInfo: WaterInfo;
  missionStartPosition: V2d;
  missionStartTime: number;
  currentTime: number;
  elapsedTime: number;
}
```

#### 1.3 `src/config/CustomEvent.ts` (modify)

Add mission events:

```typescript
export type CustomEvents = {
  // Existing...
  gameStart: {};
  tutorialStepComplete: { stepIndex: number; stepTitle: string };
  tutorialComplete: {};

  // New mission events
  missionUnlocked: { missionId: string };
  missionStarted: { missionId: string };
  missionObjectiveComplete: { missionId: string; objectiveIndex: number };
  missionComplete: { missionId: string; time: number };
  missionFailed: { missionId: string; reason: string };
  missionQuit: { missionId: string };
};
```

---

### Phase 2: Persistence Layer

#### 2.1 `src/game/mission/MissionPersistence.ts`

```typescript
const STORAGE_KEY = "tack-and-trim-missions";

export class MissionPersistence {
  static load(): MissionSaveData { ... }
  static save(data: MissionSaveData): void { ... }
  static markMissionComplete(missionId: string, time: number): void { ... }
  static isMissionComplete(missionId: string): boolean { ... }
  static isTutorialComplete(): boolean { ... }
  static markTutorialComplete(): void { ... }
}
```

---

### Phase 3: Mission Definitions

#### 3.1 `src/game/mission/MissionRegistry.ts`

```typescript
export class MissionRegistry {
  private static missions: Map<string, Mission> = new Map();

  static register(mission: Mission): void { ... }
  static get(id: string): Mission | undefined { ... }
  static getAll(): Mission[] { ... }
  static getUnlocked(saveData: MissionSaveData): Mission[] { ... }
  static isUnlocked(mission: Mission, saveData: MissionSaveData): boolean { ... }
}
```

#### 3.2 `src/game/mission/missions/` - Example missions

Start with 3-4 simple missions:

- `first-sail.ts` - "Sail 100 feet from the starting point" (always unlocked)
- `buoy-run.ts` - "Sail to the red buoy and back" (requires first-sail)
- `triangle-course.ts` - "Complete the triangle course" (requires buoy-run)

---

### Phase 4: World Entities

#### 4.1 `src/game/mission/MissionSpot.ts`

Physical beacon in the world:

```typescript
export class MissionSpot extends BaseEntity {
  layer = "main" as const;
  body: DynamicBody; // For water physics like Buoy

  private missionId: string;
  private state: "locked" | "available" | "active" | "completed";
  private playerInRange: boolean = false;

  // Check if boat is within interaction radius
  @on("tick")
  onTick() { ... }

  // Render beacon with state-appropriate visuals
  @on("render")
  onRender({ draw }: { draw: Draw }) { ... }

  // Handle interaction key press
  @on("keyDown")
  onKeyDown(keyCode: number) { ... }
}
```

#### 4.2 `src/game/mission/Waypoint.ts`

Visual marker for objectives:

```typescript
export class Waypoint extends BaseEntity {
  layer = "main" as const;

  private position: V2d;
  private radius: number;
  private isActive: boolean;
  private isCompleted: boolean;
  private label?: string;

  @on("render")
  onRender({ draw }: { draw: Draw }) { ... }
}
```

#### 4.3 `src/game/mission/Checkpoint.ts`

Gate/line to pass through:

```typescript
export class Checkpoint extends BaseEntity {
  private start: V2d;
  private end: V2d;
  private passed: boolean = false;

  // Check if boat crossed the line this tick
  checkCrossing(boatPosition: V2d, previousPosition: V2d): boolean { ... }
}
```

---

### Phase 5: Mission Manager

#### 5.1 `src/game/mission/MissionManager.ts`

Core orchestrator (similar pattern to TutorialManager):

```typescript
export class MissionManager extends BaseEntity {
  id = "missionManager";

  private activeMission: ActiveMissionState | null = null;
  private context: MissionContext | null = null;
  private missionSpots: MissionSpot[] = [];
  private waypoints: Waypoint[] = [];

  // UI references
  private previewPopup: MissionPreviewPopup | null = null;
  private hud: MissionHUD | null = null;
  private completePopup: MissionCompletePopup | null = null;

  @on("afterAdded")
  onAfterAdded(): void {
    // Load save data
    // Spawn mission spots for all missions
    // Subscribe to mission events
  }

  startMission(missionId: string): void { ... }

  private setupObjectives(mission: Mission): void { ... }

  private checkObjectives(): void { ... }

  private completeCurrentObjective(): void { ... }

  private completeMission(): void { ... }

  private failMission(reason: string): void { ... }

  quitMission(): void { ... }

  restartMission(): void { ... }

  @on("tick")
  onTick(dt: number): void {
    // Update context
    // Check time limit
    // Check current objective
  }

  // Listen for tutorial completion to unlock missions
  @on("tutorialComplete")
  onTutorialComplete(): void {
    MissionPersistence.markTutorialComplete();
    this.refreshMissionSpots();
  }
}
```

---

### Phase 6: Objective Checkers

#### 6.1 `src/game/mission/objectives/ObjectiveChecker.ts`

```typescript
export interface ObjectiveChecker {
  check(context: MissionContext): ObjectiveCheckResult;
  reset(): void;
}

export type ObjectiveCheckResult =
  | { status: "incomplete" }
  | { status: "complete" }
  | { status: "failed"; reason: string };
```

#### 6.2 Individual checkers

Each objective type gets its own checker class:

- `ReachObjectiveChecker` - Distance check to target position
- `CheckpointObjectiveChecker` - Track which waypoints have been passed
- `GateObjectiveChecker` - Line crossing detection
- `SpeedObjectiveChecker` - Velocity magnitude check with duration tracking
- `SurvivalObjectiveChecker` - Listen for collision events

---

### Phase 7: UI Components

#### 7.1 `src/game/mission/ui/MissionPreviewPopup.tsx`

Shows when player is near a mission spot:

```
┌─────────────────────────────────┐
│  ⚓ First Sail                  │
│  ★☆☆☆☆                         │
│                                 │
│  Sail 100 feet from the dock    │
│  to prove you're ready for      │
│  bigger challenges.             │
│                                 │
│  [F] Start Mission              │
└─────────────────────────────────┘
```

#### 7.2 `src/game/mission/ui/MissionCompletePopup.tsx`

Success/failure screens with Retry/Leave options.

#### 7.3 `src/game/mission/ui/PauseMenu.tsx`

Pause menu that appears when pressing `Esc`:

```
┌─────────────────────────────────┐
│          PAUSED                 │
│                                 │
│  [Resume]                       │
│  [Settings]                     │
│  [Quit to Menu]                 │
│                                 │
│  ─────────────────────────────  │
│  Current Mission: First Sail    │
│  Time: 1:23                     │
│                                 │
│  [Restart Mission]              │
│  [End Mission]                  │
└─────────────────────────────────┘
```

The mission section only appears if a mission is active.

#### 7.4 `src/game/mission/WorldLabel.ts`

Renders text in world space (not screen space). Used for mission names near spots.

```typescript
export class WorldLabel extends BaseEntity {
  layer = "main" as const;

  constructor(
    private position: V2d,
    private text: string,
    private options?: { offset?: V2d; fadeDistance?: number }
  ) { ... }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    // Render text at world position
    // Optional: fade based on distance from camera/boat
  }
}
```

#### 7.5 `src/game/mission/OffscreenIndicator.ts`

Shows an arrow at screen edge pointing toward off-screen objectives.

```typescript
export class OffscreenIndicator extends BaseEntity {
  layer = "hud" as const;

  constructor(private getTargetPosition: () => V2d | null) { ... }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const target = this.getTargetPosition();
    if (!target) return;

    // Check if target is off-screen
    // If so, render arrow at screen edge pointing toward it
    // Include distance indicator
  }
}
```

---

### Phase 8: Integration

#### 8.1 `src/game/GameController.ts` (modify)

```typescript
@on("gameStart")
onGameStart() {
  // ... existing code ...

  // Start the mission system (after tutorial manager)
  this.game!.addEntity(new MissionManager());
}
```

---

## Execution Order

### Parallel Work (no dependencies)

These can be implemented independently:

- **MissionTypes.ts** - Pure type definitions
- **MissionPersistence.ts** - localStorage wrapper, no game dependencies
- **CustomEvent.ts updates** - Just adding new event types
- **CSS files** - Can be created empty and filled in later

### Sequential Work (has dependencies)

```
1. Core Types (MissionTypes.ts, MissionContext.ts)
   ↓
2. Persistence Layer (MissionPersistence.ts)
   ↓
3. Mission Registry (MissionRegistry.ts)
   ↓
4. Objective Checkers (ObjectiveChecker.ts, then individual checkers)
   ↓
5. World Entities (Waypoint.ts, WorldLabel.ts, MissionSpot.ts)
   ↓
6. Screen-space UI (MissionPreviewPopup, MissionCompletePopup, PauseMenu)
   ↓
7. Mission Manager (MissionManager.ts) - ties everything together
   ↓
8. Mission Definitions (missions/*.ts) - requires registry and types
   ↓
9. GameController Integration - final wiring
   ↓
10. Off-screen Indicators (OffscreenIndicator.ts) - polish layer
```

---

## Implementation Chunks

For practical implementation, group into these work chunks:

### Chunk 1: Foundation
- MissionTypes.ts
- MissionContext.ts
- CustomEvent.ts updates
- MissionPersistence.ts

### Chunk 2: Registry & Objectives
- MissionRegistry.ts
- ObjectiveChecker.ts
- ReachObjective.ts (simplest, good for testing)

### Chunk 3: World Entities
- Waypoint.ts
- WorldLabel.ts
- MissionSpot.ts (with world-space label integration)

### Chunk 4: Preview UI
- MissionPreviewPopup.tsx + CSS

### Chunk 5: Mission Manager
- MissionManager.ts (core flow)

### Chunk 6: First Mission
- missions/first-sail.ts
- GameController.ts integration
- End-to-end test of full flow

### Chunk 7: Completion & Pause Flow
- MissionCompletePopup.tsx + CSS
- PauseMenu.tsx + CSS (with mission info section)
- Mission completion/failure handling
- Restart/quit functionality via pause menu

### Chunk 7.5: Off-screen Indicators
- OffscreenIndicator.ts
- Integration with active mission waypoints

### Chunk 8: Additional Objectives
- CheckpointObjective.ts
- Checkpoint.ts (gate entity)
- GateObjective.ts
- SpeedObjective.ts

### Chunk 9: More Missions
- Additional mission definitions
- Progression tree tuning

---

## Testing Strategy

1. **After Chunk 1**: Verify types compile, persistence saves/loads correctly
2. **After Chunk 5**: Can start a mission from a spot, see HUD appear
3. **After Chunk 6**: Full flow - approach spot, start mission, complete objective, see completion
4. **After Chunk 7**: Retry and quit work correctly
5. **After Chunk 9**: Multiple missions unlock in sequence

---

## Design Decisions

1. **Interaction key**: `F` - Same key as anchor. Thematically consistent ("tying up" at a location).

2. **Mission spot visual**: Buoy with flag - Fits the nautical aesthetic and is distinct from regular buoys.

3. **Tutorial → Mission transition**: Let players discover naturally through exploration. No explicit direction to first mission.

4. **Pause behavior**: `Esc` pauses the game and shows main pause menu. If a mission is active, the pause menu also shows mission info with options to restart or end the mission.

5. **In-mission UI**: Minimal screen-space HUD. Instead:
   - **World-space labels**: Mission name appears near the mission spot when approaching
   - **Off-screen indicators**: Arrows pointing toward objective locations that are off-screen
   - This keeps the sailing experience immersive rather than UI-heavy
