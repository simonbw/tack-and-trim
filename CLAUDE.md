# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm start` - Start development server with asset watching and Parcel dev server
- `npm run build` - Build production version using Parcel
- `npm run tsc` - Run TypeScript type checking (no emit)
- `npm run tsc-watch` - Run TypeScript type checking in watch mode
- `npm run prettier` - Format source code with Prettier
- `npm run generate-manifest` - Generate asset type definitions from resources folder

## Core Architecture

This is a custom 2D game engine built on TypeScript, with three main technology pillars:

### Technologies
- **Pixi.js** - 2D rendering engine for graphics and sprites
- **p2.js** - 2D physics engine (planning to replace due to performance limitations)
- **Parcel** - Zero-config bundler and dev server

### Entity-Component System
The engine follows an Entity-based architecture where everything in the game extends `BaseEntity` and implements the `Entity` interface:

- **Game class** (`src/core/Game.ts:29`) - Top-level controller managing the game loop, entities, physics, rendering, and input
- **Entity interface** (`src/core/entity/Entity.ts:27`) - Core interface for all game objects with lifecycle hooks
- **EntityList** - Manages entity collections with tag-based querying
- **Event System** - Entities respond to game events like `onTick`, `onRender`, `onAdd`, `onDestroy`

### Key Systems
- **Physics**: Custom p2.js world with collision detection, bodies, springs, and constraints
- **Rendering**: Layered sprite system with camera controls
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