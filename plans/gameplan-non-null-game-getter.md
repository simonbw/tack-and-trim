# Gameplan: Non-null `game` Getter for Entities

## Goal
Change `this.game` from `Game | undefined` to a getter that returns `Game` (and throws if accessed before entity is added). Add an `isAdded` helper for places that legitimately need to check if an entity is in the game.

## Current State
- `Entity` interface has `game: Game | undefined` (line 29)
- `BaseEntity.game` is typed as `Game | undefined` (line 19)
- `isDestroyed` getter exists: `get isDestroyed() { return this.game == null; }`
- 55+ places use `this.game!` (non-null assertion)
- 14 places use `if (!this.game)` as a guard
- 12 places use `this.game?.` optional chaining

## Changes

### 1. Update Entity Interface (`src/core/entity/Entity.ts`)

```typescript
// Before (line 29):
game: Game | undefined;

// After:
game: Game;

// Add new property:
readonly isAdded: boolean;
```

### 2. Update BaseEntity (`src/core/entity/BaseEntity.ts`)

**Change the `game` property from a direct field to a getter/setter pair:**

```typescript
// Before:
game: Game | undefined = undefined;

// After:
private _game?: Game;

get game(): Game {
  if (!this._game) {
    throw new Error(`Entity ${this.constructor.name} accessed 'game' before being added`);
  }
  return this._game;
}

set game(value: Game | undefined) {
  this._game = value;
}

get isAdded(): boolean {
  return this._game != null;
}
```

**Update `isDestroyed` getter:**
```typescript
// Before:
get isDestroyed() { return this.game == null; }

// After:
get isDestroyed() { return this._game == null; }
```

**Update internal references in BaseEntity to use `_game` or `isAdded`:**
- Line 36: `if (this.game)` → `if (this._game)` (checking before entity is added)
- Line 80: `get isDestroyed() { return this.game == null; }` → `get isDestroyed() { return this._game == null; }`
- Line 85: `if (this.game)` → `if (this._game)` (checking before calling removeEntity)
- Line 119: `if (this.game && !child.game)` → `if (this._game && !child.isAdded)` (child is typed as `Entity`, use interface property)
- Line 221: `this.game?.dispatch(...)` → `if (this._game) this._game.dispatch(...)`

### 3. Update Game.ts (`src/core/Game.ts`)

The setter will handle these - no changes needed since `entity.game = this` and `entity.game = undefined` will work with the setter.

### 4. Remove all `this.game!` non-null assertions (55+ occurrences)

Simply remove the `!` - the getter now returns `Game` not `Game | undefined`.

**Files to update:**
- `src/game/InitializingOverlay.tsx`
- `src/game/MainMenu.tsx`
- `src/game/GameController.ts` (19 usages)
- `src/game/Buoy.ts`
- `src/game/PhysicsValidator.ts`
- `src/game/FoamParticle.ts`
- `src/game/SprayParticle.ts`
- `src/game/surface-rendering/SurfaceRenderer.ts`
- `src/game/wind-visualization/WindVisualization.ts`
- `src/game/BoatSpray.ts`
- `src/game/world-data/datatiles/DataTileComputePipeline.ts`
- `src/game/tutorial/TutorialManager.ts`
- `src/game/world-data/influence/InfluenceFieldManager.ts`
- `src/core/AutoPauser.ts`
- `src/core/sound/SoundInstance.ts`
- `src/core/sound/PositionalSoundListener.ts`
- `src/game/world-data/wind/WindInfo.ts`
- `src/core/graphics/Camera2d.ts`
- `src/game/boat/BoatGrounding.ts`
- `src/game/boat/Keel.ts`
- `src/game/boat/Hull.ts`
- `src/game/boat/Rudder.ts`
- `src/game/boat/PlayerBoatController.ts`
- `src/core/util/stats-overlay/StatsOverlay.tsx`
- `src/game/WindIndicator.ts`
- `src/game/world-data/water/WaterInfo.ts`
- `src/game/world-data/terrain/TerrainInfo.ts`

### 5. Replace `if (!this.game)` guards with `if (!this.isAdded)` (14 occurrences)

**Files to update:**
- `src/game/wind-visualization/WindVisualization.ts:43`
- `src/game/boat/Anchor.ts:140,149,181`
- `src/game/boat/sail/Sail.ts:265,310`
- `src/game/boat/sail/TellTail.ts:83`
- `src/game/WindIndicator.ts:70`
- `src/core/sound/SoundInstance.ts:48,56,64,72`
- `src/core/sound/PositionalSound.ts:28`

### 6. Replace `if (this.game)` positive checks with `if (this.isAdded)` (~6 occurrences)

- `src/game/boat/Anchor.ts:298`
- `src/core/entity/BaseEntity.ts:36,85,119` (use `_game` directly here)

### 7. Replace `this.game?.` optional chaining (12 occurrences)

Evaluate each - most can become `this.game.` since they're in contexts where the entity must be added:

- `src/game/world-data/datatiles/DataTileComputePipeline.ts:191`
- `src/game/CameraController.ts:31,34`
- `src/game/world-data/influence/InfluenceFieldManager.ts:331`
- `src/game/world-data/water/WaterInfo.ts:365,406`
- `src/game/WindIndicator.ts:75`
- `src/game/boat/sail/Sail.ts:252,316`
- `src/game/world-data/water/Wake.ts:59,123`
- `src/core/entity/BaseEntity.ts:221` (use `_game` directly)

## Verification

1. Run `npm run tsgo` - should have no type errors
2. Run `npm test` - e2e tests should pass
3. Manual test - start the game, sail around, verify no runtime errors

## Summary

| Change Type | Count | Complexity |
|-------------|-------|------------|
| Entity interface update | 1 file | Simple |
| BaseEntity refactor | 1 file | Medium |
| Remove `this.game!` | 27 files, 55+ occurrences | Simple (just remove `!`) |
| Replace `if (!this.game)` | 8 files, 14 occurrences | Simple |
| Replace `if (this.game)` | ~4 files, ~6 occurrences | Simple |
| Replace `this.game?.` | 8 files, 12 occurrences | Simple |

## Benefits
- No more `this.game!` everywhere - cleaner code
- Fail-fast behavior when `game` is accessed before entity is added
- Clear `isAdded` API for legitimate "am I in the game?" checks
- TypeScript will catch incorrect usage at compile time
