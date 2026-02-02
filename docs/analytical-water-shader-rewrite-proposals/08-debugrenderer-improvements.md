# DebugRenderer System Improvements Proposal

## Summary

Modernize debug visualization system by treating modes as proper entities rather than plain objects. Eliminates custom lifecycle management and GPU shader orchestration in favor of entity-based patterns.

## Current System (main branch)

**Architecture**: Interface-based modes with custom lifecycle
```typescript
interface DebugRenderMode {
  id: string;
  name: string;
  render(ctx: DebugRenderContext): void;
  onActivate?(ctx: DebugRenderContext): void;
  onDeactivate?(ctx: DebugRenderContext): void;
  destroy?(): void;
}
```

**Components**:
- `DebugRenderer.ts` - Entity + orchestration
- `DebugRenderMode.ts` - Interface definition
- `DebugShaderManager.ts` - GPU shader orchestration (289 lines)
- `DebugHUD.tsx` - Separate ReactEntity
- Complex context object threading

## Proposed System (from analytical-water-shader-rewrite)

**Architecture**: Modes as entity subclasses
```typescript
abstract class DebugRenderMode extends BaseEntity {
  abstract getModeName(): JSX.Element | string | null;
  getHudInfo(): JSX.Element | string | null { return null; }
  getCursorInfo(): JSX.Element | string | null { return null; }
}
```

**Components**:
- `DebugRenderer.tsx` - Unified entity + UI (121 lines)
- `DebugRenderMode.ts` - Base class (16 lines)
- Concrete modes (e.g., `WindDebugRenderMode.ts`)
- No separate HUD entity, no shader manager

## Key Improvements

### 1. Modes as Child Entities

**Before**: Plain objects with manual lifecycle
```typescript
private modes: DebugRenderMode[] = [...];
private cycleMode(direction: 1 | -1): void {
  modes[oldIndex].onDeactivate?.(ctx);
  modes[newIndex].onActivate?.(ctx);
}
```

**After**: Parent-child entity pattern
```typescript
private currentMode: DebugRenderMode | null = null;
setActiveMode(index: number): void {
  if (this.currentMode) {
    this.currentMode.destroy();  // Entity cleanup
  }
  this.currentMode = this.addChild(
    this.modeConstructors[index]()
  );
}
```

### 2. Elimination of Context Objects

**Before**: Complex context passed everywhere
```typescript
interface DebugRenderContext {
  game: Game;
  draw: Draw;
  viewport: { left, top, width, height };
  cursorWorldPos: V2d | null;
}
mode.render(ctx);
```

**After**: Direct access via entity inheritance
```typescript
class WindDebugRenderMode extends DebugRenderMode {
  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    const viewport = this.game.camera.getWorldViewport();
    // Direct access: this.game, draw from event
  }
}
```

### 3. React Integration Simplification

**Before**: Separate HUD entity with state sync
```typescript
private hud: DebugHUD | null = null;
private updateHUD(): void {
  this.hud?.setState({
    modeName: mode.name,
    subModeInfo: mode.getHudInfo?.(ctx) ?? null,
  });
}
```

**After**: DebugRenderer itself extends ReactEntity
```typescript
class DebugRenderer extends ReactEntity {
  constructor() {
    super(() => this.renderHud(), true);
  }

  renderHud() {
    const modeName = this.currentMode?.getModeName();
    const modeContent = this.currentMode?.getHudInfo();
    return <div className="debug-hud">{/* ... */}</div>;
  }
}
```

### 4. GPU Shader Management Removed

**Removed**: `DebugShaderManager.ts` (289 lines)
- Fullscreen shader for visualization overlays
- Uniform buffer management
- Bind group handling

**Why**: New approach uses:
- Entity-based rendering via `@on("render")` handlers
- Existing query systems (`WindQuery`, `WaterQuery`)
- Immediate-mode `Draw` API
- Simpler and more flexible

### 5. Query System Integration

**New Pattern**:
```typescript
class WindDebugRenderMode extends DebugRenderMode {
  private windQuery: WindQuery;

  constructor() {
    super();
    this.windQuery = this.addChild(
      new WindQuery(() => this.getQueryPoints())
    );
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    for (const [point, result] of this.windQuery) {
      // Draw wind vectors
    }
  }
}
```

Leverages GPU-based query system with automatic lifecycle.

## Benefits

### 1. Architectural Consistency
- Modes are proper entities following established patterns
- Uses same parent-child pattern as rest of game
- Aligns with engine's entity-component architecture

### 2. Reduced Complexity
- **-413 net lines of code** (632 deleted, 219 added)
- Removed files: DebugShaderManager, DebugHUD, interface definition
- Simpler mental model

### 3. Automatic Resource Management
- Parent-child relationships handle cleanup
- No manual `destroy()` callbacks needed
- Child entities (queries) cleaned up automatically

### 4. Better Encapsulation
- Modes own their child entities
- Direct access to game systems via inheritance
- Each mode is self-contained

### 5. Improved Testability
- Modes are concrete classes
- Can be instantiated and tested independently
- Standard entity lifecycle

### 6. Modern React Integration
- Single ReactEntity instead of separate HUD
- Direct JSX rendering in mode classes
- Type-safe props via methods

### 7. Leverages New GPU Systems
- Uses WindQuery/WaterQuery from new world system
- GPU compute in specialized query managers
- Debug modes just consume results

## Migration Path

### Phase 1: Add Base Class
1. Create `DebugRenderMode` abstract class extending `BaseEntity`
2. Define interface: `getModeName()`, `getHudInfo()`, `getCursorInfo()`

### Phase 2: Convert DebugRenderer
1. Make `DebugRenderer` extend `ReactEntity`
2. Add `renderHud()` method for UI
3. Update mode management to use parent-child pattern
4. Remove context object creation

### Phase 3: Implement Concrete Modes
1. Create `WindDebugRenderMode` with WindQuery integration
2. Create `WaterDebugRenderMode` with WaterQuery integration
3. Use `@on("render")` decorators

### Phase 4: Remove Old System
1. Delete `DebugShaderManager.ts`
2. Delete `DebugHUD.tsx` separate entity
3. Delete old mode interface
4. Remove context object types

### Phase 5: Testing
1. Verify mode cycling works
2. Test query integration
3. Validate UI rendering
4. Profile performance

## Code Organization Comparison

**Before**:
```
debug-renderer/
├── DebugRenderer.ts (203 lines)
├── DebugRenderMode.ts (78 lines - interface)
├── DebugShaderManager.ts (289 lines)
├── DebugHUD.tsx (separate entity)
└── modes/ (stub implementations)
```

**After**:
```
debug-renderer/
├── DebugRenderer.tsx (121 lines - unified)
├── DebugHUD.css (styling)
└── modes/
    ├── DebugRenderMode.ts (16 lines - base class)
    ├── WindDebugRenderMode.ts (82 lines - complete)
    └── WaterDebugRenderMode.ts (complete)
```

## Example Implementation

```typescript
export class WindDebugRenderMode extends DebugRenderMode {
  layer = "windDebug";
  private windQuery: WindQuery;

  constructor() {
    super();
    this.windQuery = this.addChild(
      new WindQuery(() => this.getQueryPoints())
    );
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    for (const [point, result] of this.windQuery) {
      // Draw wind visualization
      draw.fillTriangle([p1, p2, p3], {
        alpha: 0.5,
        color: 0x00ffff
      });
    }
  }

  getQueryPoints(): V2d[] {
    const viewport = this.game.camera.getWorldViewport();
    // Generate grid of sample points
  }

  getModeName(): string { return "Wind"; }
}
```

## Potential Issues

1. **Breaking change** - Existing modes need rewrite
   - **Mitigation**: Only a few debug modes exist, straightforward conversion

2. **Requires new query system** - Dependency on GPU query infrastructure
   - **Mitigation**: Part of same refactor, adopted together

## Recommendation

**STRONGLY RECOMMEND** adopting this change. The architectural consistency alone justifies the migration. The reduction of 413 lines while adding features demonstrates this is the right approach.

Key insight: **Don't fight the framework**. Embrace the entity-component system instead of creating parallel lifecycle management.

This is a textbook example of "making illegal states unrepresentable" through better architecture.

## File References

**New Implementation:**
- `src/game/debug-renderer/DebugRenderer.tsx`
- `src/game/debug-renderer/modes/DebugRenderMode.ts`
- `src/game/debug-renderer/modes/WindDebugRenderMode.ts`
- `src/game/debug-renderer/modes/WaterDebugRenderMode.ts`

**To Remove:**
- `src/game/debug-renderer/DebugShaderManager.ts`
- `src/game/debug-renderer/DebugHUD.tsx`
- Old `src/game/debug-renderer/DebugRenderMode.ts` interface
