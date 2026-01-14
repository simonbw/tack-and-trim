# Main Menu System Gameplan

## Current State

The game initializes everything directly in `src/game/index.tsx`:

```typescript
async function main() {
  const game = new Game({ ticksPerSecond: 240 });
  await game.init(...);

  // Preload assets
  const preloader = game.addEntity(GamePreloader);
  await preloader.waitTillLoaded();
  preloader.destroy();

  // Add all systems and entities directly:
  game.addEntity(new StatsOverlay([...]));  // persistenceLevel = 100
  game.addEntity(new AutoPauser());         // persistenceLevel = 100
  game.addEntity(new WaterInfo());          // persistenceLevel = 0
  game.addEntity(new WaterRenderer());      // persistenceLevel = 0
  game.addEntity(new WindInfo());           // persistenceLevel = 0
  // ... boat, camera, buoys, etc (all persistenceLevel = 0)
}
```

**Key findings:**
- No game state management exists - everything spawns immediately
- `persistenceLevel` property on entities controls `clearScene()` behavior (entities with `persistenceLevel <= threshold` are removed)
- `ReactEntity` provides HTML overlay rendering via Preact (used by preloader, stats overlay)
- `Camera2d` has `smoothZoom(targetZ, smooth)` and `smoothCenter(pos, vel, stiffness)` for smooth transitions
- Custom events use automatic handler mapping: `game.dispatch('eventName', data)` → `entity.onEventName(data)`

**Relevant files:**
- `src/game/index.tsx` - Entry point, spawns all entities
- `src/config/CustomEvent.ts` - Custom event type definitions (currently just example)
- `src/core/entity/BaseEntity.ts:21` - `persistenceLevel` default is 0
- `src/core/Game.ts:338` - `clearScene(persistenceThreshold)` removes entities
- `src/core/ReactEntity.ts` - HTML overlay rendering via Preact
- `src/game/CameraController.ts` - Camera following logic

## Desired Changes

Create a main menu system with:
1. **Title screen** - Displays "Tack & Trim" title with "Press Enter to Start" prompt
2. **Water background** - Water continues rendering during menu (ambient feel)
3. **Event-based transitions** - Menu dispatches events, doesn't spawn entities itself
4. **GameController** - High-level persistent entity that manages game state and responds to events
5. **Camera zoom transition** - When starting, camera zooms from wide shot to follow the boat

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         index.tsx                                │
│  - Creates Game instance                                         │
│  - Adds persistent entities (GameController, systems)           │
│  - GameController takes over from there                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      GameController                              │
│  persistenceLevel = 100                                          │
│  - Spawns MainMenu on init                                       │
│  - Spawns water/wind systems (they persist through transitions) │
│  - Listens for gameStart event → spawns boat, buoys, etc        │
│  - Manages camera zoom transition                                │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────────┐    ┌─────────────────────────────────────┐
│     MainMenu        │    │         Gameplay Entities            │
│  persistenceLevel=0 │    │  - Boat, PlayerBoatController        │
│  - Shows title      │    │  - CameraController                  │
│  - Listens for keys │    │  - Buoys                             │
│  - dispatch(start)  │    │  - WindParticles, WindIndicator     │
│  - destroys self    │    │  All persistenceLevel = 0            │
└─────────────────────┘    └─────────────────────────────────────┘
```

### Event Flow

1. **Game loads** → `GameController.onAdd()` spawns `MainMenu` + water/wind systems
2. **User presses Enter/Space** → `MainMenu` dispatches `gameStart` event, destroys itself
3. **GameController receives `gameStart`** → Spawns boat, buoys, camera controller; starts camera zoom transition

## Files to Modify

### New Files

- `src/game/GameController.ts` - High-level game state manager
  - `persistenceLevel = 100` (survives scene clears)
  - Spawns and manages game phases (menu → gameplay)
  - Handles `onGameStart` event to spawn gameplay entities
  - Manages camera zoom transition when starting

- `src/game/MainMenu.tsx` - Main menu entity
  - Extends `ReactEntity` for HTML overlay
  - Renders title "Tack & Trim" and "Press Enter to Start"
  - Listens for Enter/Space key events
  - Dispatches `gameStart` event and destroys self

- `src/game/MainMenu.css` - Styling for main menu
  - Centered title with nautical styling
  - Animated "Press Enter" prompt
  - Semi-transparent to show water underneath

### Modified Files

- `src/config/CustomEvent.ts` - Add new events
  ```typescript
  export type CustomEvents = {
    /** Fired when player starts the game from main menu */
    gameStart: {};
  };
  ```

- `src/game/index.tsx` - Simplify to only create GameController
  - Remove direct entity spawning
  - Only add: `GameController`, `StatsOverlay`, `AutoPauser`, `PhysicsValidator`
  - Let `GameController` handle all game-specific entity spawning

- `src/game/CameraController.ts` - Support zoom transitions
  - Add `setZoomTarget(z: number)` method
  - Optionally: add initial "zoom in" animation support

## Execution Order

### Phase 1: Foundation (Sequential - dependencies)

1. **Modify `src/config/CustomEvent.ts`**
   - Add `gameStart` event type
   - This must be done first as other files will reference it

### Phase 2: New Entities (Parallel - no dependencies between them)

2. **Create `src/game/MainMenu.css`**
   - Define menu styling

3. **Create `src/game/MainMenu.tsx`**
   - Implement menu entity with ReactEntity
   - Import CSS
   - Handle key input, dispatch event

4. **Create `src/game/GameController.ts`**
   - Implement game state management
   - Define entity spawning logic
   - Handle camera zoom transition

### Phase 3: Integration (Sequential - depends on Phase 2)

5. **Modify `src/game/CameraController.ts`**
   - Add `setZoomTarget()` method for external zoom control
   - Keep existing functionality intact

6. **Modify `src/game/index.tsx`**
   - Remove direct gameplay entity spawning
   - Add only persistent entities + GameController
   - GameController takes over entity management

### Phase 4: Polish (Optional)

7. **Add camera zoom-in animation**
   - Start zoomed out when game starts
   - Smoothly zoom in to normal gameplay level
