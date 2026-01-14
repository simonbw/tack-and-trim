# CLAUDE.md

This file provides guidance to Claude Code when working with this 2D sailing game and its custom engine.

## Project Overview

**Tack & Trim** is a 2D top-down sailing simulator built on a custom TypeScript game engine. Players control a dinghy, managing sails and rudder to navigate realistic wind and water physics.

### Key Game Systems (`src/game/`)

- **Boat** (`boat/`) - Hull, keel, rudder, mainsail, jib, and rigging with physics-based sail simulation
- **Wind** (`Wind.ts`, `WindParticles.ts`) - Global wind field with procedural variation using simplex noise
- **Water** (`water/`) - Gerstner wave simulation with currents and wake effects
- **Controls** - Steering (A/D), sail trim (W/S for main, Q/E for jib), rowing (Space), anchor (F)

## Development Commands

- `npm start` - Start development server with asset watching and Parcel dev server
- `npm run build` - Build production version using Parcel
- `npm run tsgo` - Run TypeScript type checking (no emit)
- `npm run tsgo-watch` - Run TypeScript type checking in watch mode
- `npm run prettier` - Format source code with Prettier
- `npm run generate-manifest` - Generate asset type definitions from resources folder
- `npm test` - Run e2e tests (verifies game compiles and runs without errors)

## Engine Architecture

This is a custom 2D game engine built on TypeScript, with three main technology pillars:

### Technologies

- **Custom WebGL2 Renderer** - Immediate-mode 2D rendering with batched draw calls
- **Parcel** - Zero-config bundler and dev server

### Entity-Component System

The engine follows an Entity-based architecture where everything in the game extends `BaseEntity` and implements the `Entity` interface:

- **Game class** (`src/core/Game.ts:29`) - Top-level controller managing the game loop, entities, physics, rendering, and input
- **Entity interface** (`src/core/entity/Entity.ts:27`) - Core interface for all game objects with lifecycle hooks
- **EntityList** - Manages entity collections with tag-based querying
- **Event System** - Entities respond to game events like `onTick`, `onRender`, `onAdd`, `onDestroy`

### Key Systems

- **Physics**: Simulate rigid bodies with collision detection, springs, and constraints
- **Rendering**: Custom WebGL2 renderer with `Draw` API for shapes, sprites, and paths
- **Input**: Centralized IO manager for keyboard, mouse, and gamepad input
- **Audio**: Web Audio API integration with positional sound support
- **Asset Management**: Automatic type generation for resources in `resources/` folder

### Project Structure

- `src/core/` - Engine code (Game, Entity, physics, graphics, IO, utilities)
- `src/game/` - Game-specific code and entities
- `src/config/` - Configuration files (layers, collision groups, constants)
- `resources/` - Assets (images, audio, fonts) with auto-generated TypeScript definitions
- `bin/generate-asset-types.ts` - Asset processing script that creates type-safe resource imports

### Entity Lifecycle

Entities have multiple lifecycle hooks:

- `onAdd()` - Called when added to game, before physics/rendering setup
- `onAfterAdded()` - Called after all setup is complete
- `onTick(dt)` - Called every physics tick (120fps by default)
- `onRender(dt)` - Called every render frame for visual updates
- `onDestroy()` - Called when entity is removed

### Asset System

The `bin/generate-asset-types.ts` script watches the `resources/` folder and generates:

- Individual `.d.ts` files for each asset
- `resources.ts` manifest with typed asset collections
- Type-safe helper functions like `imageName()` and `soundName()`

### Physics Integration

Entities can have:

- `body` - Single physics body
- `bodies` - Multiple physics bodies
- `springs` - Physics springs
- `constraints` - Physics constraints

All automatically added/removed from the physics world when entities are added/destroyed.

### Custom Events

Define custom events in `src/config/CustomEvent.ts` and dispatch them with `game.dispatch()`. Entities can handle custom events via the `handlers` property.

### Entity Finding

- Use `tags` array on entities for categorization
- Query with `game.entities.getTagged("tagName")`
- Use unique `id` for single entities: `game.entities.getById("entityId")`

### Profiler

Use the `profiler` singleton from `src/core/util/Profiler.ts` to measure performance:

```typescript
import { profiler } from "./util/Profiler";

// Wrap code to measure
profiler.start("myOperation");
// ... code to measure ...
profiler.end("myOperation");

// Or use measure() for cleaner scoping
profiler.measure("myOperation", () => {
  // ... code to measure ...
});

// Just count calls without timing overhead
profiler.count("frequentEvent");
```

The game loop automatically profiles: `frame`, `tick-loop`, `tick`, `physics`, and `render`.

## Development Practice

You never need to run the dev server.
You never need to ask the user if they want you to run the dev server.
The user always has the dev server running and can test things out if you want them to.
Don't try to access their running dev server yourself.

### Code Style

- Use built-in classes for math operations. For vector math, use `V2d` and utility functions from `src/core/util/MathUtil.ts`.
- Only use `onAdd()` if you need access to `this.game` during initialization. Otherwise, do all initialization in the constructor.
