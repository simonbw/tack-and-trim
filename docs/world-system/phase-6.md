# Phase 6: Integration & Polish

**Status**: Not Started
**Start Date**: TBD
**Completion Date**: TBD
**Estimated Duration**: 3-4 days
**Depends On**: Phase 1-5 (All previous phases)

---

## Goal

Tie everything together with WorldManager, create the LevelDefinition format, add polish and debugging tools, and finalize documentation.

---

## Components Checklist

- [ ] `WorldManager.ts` - Orchestrator entity
- [ ] Level definition format and validation
- [ ] Example levels
- [ ] Debug visualization tools
- [ ] Performance optimization
- [ ] Documentation updates

---

## Implementation Tasks

### WorldManager
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "worldManager"` and `tickLayer = "environment"`
- [ ] Accept LevelDefinition in constructor
- [ ] Create all child systems in correct order
- [ ] Wire up dependencies (coastlines, etc.)
- [ ] Implement `getBaseWind()` accessor
- [ ] Implement `onTick()` - collect water modifiers
- [ ] Handle initialization errors gracefully

**Entity Structure**:
```typescript
export class WorldManager extends BaseEntity {
  readonly id = "worldManager";
  readonly tickLayer = "environment";

  private terrainSystem!: TerrainSystem;
  private waterSystem!: WaterSystem;
  private windSystem!: WindSystem;
  private queryInfrastructure!: QueryInfrastructure;

  constructor(private level: LevelDefinition) {
    super();
  }

  @on("add")
  onAdd() {
    const device = this.game.renderer.getDevice();

    // 1. Query infrastructure (must be first)
    this.queryInfrastructure = this.addChild(new QueryInfrastructure(device));

    // 2. Terrain
    this.terrainSystem = this.addChild(new TerrainSystem(this.level.terrain));

    // 3. Water (depends on terrain for coastlines)
    const coastlines = this.terrainSystem.getCoastlines();
    this.waterSystem = this.addChild(new WaterSystem({
      waveSources: this.level.waveSources,
      tideConfig: this.level.tide || { range: 0, frequency: 0 },
      modifierBufferSize: 16384,
    }, coastlines));

    // 4. Wind
    const baseWindVec = new V2d(
      this.level.baseWind.speed * Math.cos(this.level.baseWind.direction),
      this.level.baseWind.speed * Math.sin(this.level.baseWind.direction)
    );
    this.windSystem = this.addChild(new WindSystem({
      baseWind: baseWindVec,
      noiseConfig: {
        noiseScale: 0.01,
        timeScale: 0.1,
        variation: 0.2,
      },
    }));
  }

  @on("tick")
  onTick(dt: number) {
    // Collect water modifiers from tagged entities
    const modifierEntities = this.game.entities.getTagged("waterModifier") as (Entity & WaterModifier)[];
    this.waterSystem.updateModifiers(modifierEntities);
  }

  getBaseWind(): V2d {
    return this.windSystem.getBaseWind();
  }
}
```

### LevelDefinition Format
- [ ] Define TypeScript interface
- [ ] Create JSON schema for validation
- [ ] Implement validation function
- [ ] Add helpful error messages for invalid data
- [ ] Create serialization/deserialization helpers

**Interface**:
```typescript
export interface LevelDefinition {
  name: string;
  description?: string;
  terrain: TerrainDefinition;
  waveSources: WaveSourceConfig[];
  baseWind: {
    direction: number; // radians (0 = east, π/2 = north)
    speed: number;     // ft/s
  };
  tide?: {
    range: number;     // ft (peak to trough)
    frequency: number; // cycles per second
  };
}

interface WaveSourceConfig {
  direction: number;      // radians
  baseAmplitude: number;  // ft
  wavelength: number;     // ft
}
```

**Validation**:
```typescript
function validateLevelDefinition(level: any): LevelDefinition {
  if (!level.terrain) throw new Error("Level missing terrain");
  if (!level.waveSources) throw new Error("Level missing waveSources");
  if (!level.baseWind) throw new Error("Level missing baseWind");

  // Validate terrain
  if (!Array.isArray(level.terrain.contours)) {
    throw new Error("Terrain contours must be an array");
  }

  // Validate wave sources
  for (const wave of level.waveSources) {
    if (wave.wavelength <= 0) {
      throw new Error(`Invalid wavelength: ${wave.wavelength}`);
    }
  }

  return level as LevelDefinition;
}
```

### Example Levels
- [ ] Create simple test level (single island, one wave source)
- [ ] Create complex level (multiple islands, multiple wave sources)
- [ ] Create tutorial level (calm water, simple terrain)
- [ ] Create challenge level (complex coastline, multiple wave sources)

**Simple Island**:
```json
{
  "name": "Simple Island",
  "description": "A single circular island for testing",
  "terrain": {
    "defaultDepth": -50,
    "contours": [
      {
        "height": 0,
        "controlPoints": [
          [100, 100], [150, 100], [200, 150], [200, 200],
          [150, 250], [100, 250], [50, 200], [50, 150]
        ]
      },
      {
        "height": 10,
        "controlPoints": [
          [120, 140], [140, 130], [160, 140], [160, 160],
          [140, 170], [120, 160]
        ]
      }
    ]
  },
  "waveSources": [
    {
      "direction": 0,
      "baseAmplitude": 2,
      "wavelength": 50
    }
  ],
  "baseWind": {
    "direction": 0.785,
    "speed": 15
  },
  "tide": {
    "range": 3,
    "frequency": 0.0001
  }
}
```

### Debug Visualization Tools
- [ ] WorldDebugOverlay entity
- [ ] Toggle for showing system boundaries
- [ ] FPS and performance stats
- [ ] Query point visualization
- [ ] VirtualTexture tile boundaries
- [ ] Water modifier bounds
- [ ] Shadow intensity overlay

**Debug Overlay**:
```typescript
class WorldDebugOverlay extends BaseEntity {
  private showTiles = false;
  private showQueries = false;
  private showModifiers = false;
  private showStats = true;

  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    if (!this.enabled) return;

    if (this.showStats) {
      this.renderStats(draw);
    }

    if (this.showTiles) {
      this.renderTileBoundaries(draw);
    }

    if (this.showQueries) {
      this.renderQueryPoints(draw);
    }

    if (this.showModifiers) {
      this.renderModifierBounds(draw);
    }
  }

  private renderStats(draw: Draw) {
    const terrain = TerrainSystem.fromGame(this.game);
    const water = WaterSystem.fromGame(this.game);
    const query = QueryInfrastructure.fromGame(this.game);

    draw.text(`Query Points: ${query.getPointCount()}`, { x: 10, y: 10 });
    draw.text(`Active Modifiers: ${water.getModifierCount()}`, { x: 10, y: 30 });
    draw.text(`Terrain Tiles: ${terrain.getTileCount()}`, { x: 10, y: 50 });
  }
}
```

### Performance Optimization
- [ ] Profile all GPU passes with timestamps
- [ ] Identify bottlenecks
- [ ] Optimize hot paths
- [ ] Implement configurable quality settings
- [ ] Add performance budgets and warnings

**Quality Settings**:
```typescript
interface QualitySettings {
  maxTiles: number;         // VirtualTexture tile limit
  maxQueryPoints: number;   // Query buffer size
  maxModifiers: number;     // Water modifier limit
  renderResolution: number; // 0.5-2.0 multiplier
  shadowResolution: number; // Shadow VT tile size
}

const QUALITY_PRESETS = {
  low: {
    maxTiles: 256,
    maxQueryPoints: 4096,
    maxModifiers: 8192,
    renderResolution: 0.75,
    shadowResolution: 64,
  },
  medium: {
    maxTiles: 512,
    maxQueryPoints: 8192,
    maxModifiers: 16384,
    renderResolution: 1.0,
    shadowResolution: 128,
  },
  high: {
    maxTiles: 1024,
    maxQueryPoints: 16384,
    maxModifiers: 32768,
    renderResolution: 1.5,
    shadowResolution: 128,
  },
};
```

### Documentation Updates
- [ ] Update world-system-api.md with final API
- [ ] Add JSDoc comments to all public classes
- [ ] Create example usage in CLAUDE.md
- [ ] Write migration guide for existing water/wind code
- [ ] Update architecture docs with any changes

**Migration Guide Topics**:
- Replacing old water system with WaterQuery
- Replacing old wind system with WindQuery
- Converting existing wake particles to WaterModifier
- Updating level files to new format
- Performance tuning guide

---

## Testing Checklist

### Integration Tests
- [ ] Load test levels successfully
- [ ] WorldManager initializes all systems
- [ ] Systems communicate correctly (coastlines, modifiers)
- [ ] Query infrastructure handles all query types
- [ ] Rendering works with all systems active

### End-to-End Tests
- [ ] Complete game loop with all systems
- [ ] Spawn boat with water/wind queries
- [ ] Create wake modifiers
- [ ] Verify physics uses query results
- [ ] Test level switching

### Performance Tests
- [ ] Profile 5-minute gameplay session
- [ ] Check for memory leaks
- [ ] Verify 60fps target met
- [ ] Monitor GPU memory usage
- [ ] Test with quality settings

### Edge Cases
- [ ] Empty level (no terrain)
- [ ] Level with no waves
- [ ] Very large levels
- [ ] Many simultaneous queries
- [ ] Many water modifiers (stress test)

---

## Files Created

```
src/game/world/
  └── WorldManager.ts            [ ] ~300 lines

resources/levels/
  ├── test-simple.json           [ ]
  ├── test-complex.json          [ ]
  ├── tutorial.json              [ ]
  └── level-schema.json          [ ]

src/game/debug/
  └── WorldDebugOverlay.ts       [ ] ~400 lines

docs/
  └── world-system-migration.md [ ]

tests/world/
  └── integration.test.ts        [ ]
  └── performance.test.ts        [ ]
```

---

## Demo Milestone

Complete game integration:
- [ ] Load example level via WorldManager
- [ ] Add SurfaceRenderer for visuals
- [ ] Spawn boat with queries
- [ ] Sail around, create wake
- [ ] Toggle debug overlays
- [ ] Show performance stats
- [ ] Switch between quality presets

---

## Polish Checklist

### Error Handling
- [ ] Validate level data on load
- [ ] Graceful GPU device loss handling
- [ ] Clear error messages for common mistakes
- [ ] Fallback rendering on GPU errors

### User Experience
- [ ] Loading screen during initialization
- [ ] Progress indicator for tile streaming
- [ ] Quality auto-detect based on hardware
- [ ] Settings persistence

### Code Quality
- [ ] All public APIs documented
- [ ] Consistent naming conventions
- [ ] No TODO comments in production code
- [ ] Clean up debug logging

### Performance
- [ ] All GPU passes < 2ms each
- [ ] Total frame time < 16ms (60fps)
- [ ] Memory usage stable over time
- [ ] Texture memory under budget

---

## Blockers & Dependencies

### Prerequisites
- [x] Phase 1-5 complete (all systems)

### Blockers
- None (final integration phase)

---

## Notes & Decisions

### Key Integration Points
- WorldManager creates systems in specific order (query infra first)
- Water modifiers collected via tags each frame
- Coastlines extracted from terrain and passed to water system
- Base wind exposed for UI/debugging

### Configuration
- JSON-based level format (human-readable, easy to edit)
- Validation on load (fail fast with clear errors)
- Quality presets for different hardware
- All constants configurable

### Future Work (Post-MVP)
- Level editor integration
- Procedural level generation
- Dynamic level streaming (large worlds)
- Multiplayer synchronization
- Save/load system integration

---

## Completion Criteria

Phase 6 is complete when:
- [ ] WorldManager implemented and tested
- [ ] Example levels created and loading
- [ ] Debug tools functional
- [ ] Performance optimized (60fps)
- [ ] All documentation updated
- [ ] Migration guide written
- [ ] No known bugs
- [ ] Code reviewed and approved
- [ ] **System ready for production use**

---

## Final Checklist

### System Integration
- [ ] All phases complete
- [ ] All tests passing
- [ ] Performance targets met
- [ ] Documentation complete

### Production Readiness
- [ ] Error handling robust
- [ ] Memory leaks fixed
- [ ] GPU validation clean
- [ ] Quality settings working

### Developer Experience
- [ ] API documented
- [ ] Examples provided
- [ ] Migration path clear
- [ ] Debug tools available

### **🎉 Ship It!**
- [ ] Merge to main branch
- [ ] Tag release
- [ ] Update CHANGELOG
- [ ] Celebrate! 🚢
