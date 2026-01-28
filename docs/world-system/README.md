# World Rendering System

GPU-accelerated world simulation with terrain, water, and wind systems.

## Documentation Index

### Core Documentation
- **[architecture.md](./architecture.md)** - System design and technical architecture
- **[api.md](./api.md)** - Public API reference and usage examples
- **[class-breakdown.md](./class-breakdown.md)** - Class structure and responsibilities
- **[implementation-plan.md](./implementation-plan.md)** - Master implementation roadmap

### Implementation Phases
- **[phase-0.md](./phase-0.md)** - ✅ Stub APIs (Complete)
- **[phase-1.md](./phase-1.md)** - ✅ Core Infrastructure (Complete)
- **[phase-2.md](./phase-2.md)** - Terrain System (Next)
- **[phase-3.md](./phase-3.md)** - Water System
- **[phase-4.md](./phase-4.md)** - Wind System
- **[phase-5.md](./phase-5.md)** - Rendering Integration
- **[phase-6.md](./phase-6.md)** - Optimization & Polish

### Reference
- **[architecture-old.md](./architecture-old.md)** - Previous design (archived)

## Quick Start

### Current Status (Phase 1 Complete)

The foundational infrastructure is complete and ready for Phase 2:

**VirtualTexture System** (`core/graphics/webgpu/virtual-texture/`):
- Generic GPU tile streaming with LOD support
- LRU caching and deferred computation
- Reusable for any tile-based data

**Query System** (`game/world/query/`):
- Three independent managers: Terrain, Water, Wind
- Type-safe GPU-accelerated sampling
- Tag-based discovery, zero `any` types

**Test Coverage**:
- E2E test demonstrates one-frame latency behavior
- TypeScript compilation: ✅ zero errors
- All stub APIs replaced with real infrastructure

### Using Queries

```typescript
import { WaterQuery } from "./game/world/query";
import { V } from "./core/Vector";

// Create query
const query = new WaterQuery(() => [boatPosition]);
game.addEntity(query);

// Wait one frame for results
await new Promise(resolve => setTimeout(resolve, 16));

// Access results
for (const [point, result] of query) {
  console.log(`Water at ${point}: height=${result.surfaceHeight}`);
}
```

### Next Steps

**Phase 2** (Terrain System) will add:
- TerrainVirtualTexture with SDF generation
- Real terrain height/normal queries
- Integration with terrain editor

See [phase-2.md](./phase-2.md) for details.
