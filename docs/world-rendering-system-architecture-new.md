# World Rendering System Architecture

## Purpose of This Document

This documentation is part of a deliberate refactoring strategy. Over time, the world rendering and data systems accumulated complexity and vestiges of abandoned approaches. Rather than incrementally cleaning up the existing code, we're taking a different approach:

1. **Document thoroughly** - Capture everything the current system does, how it works, and why.
2. **Delete the existing code** - With the system fully documented and the old code safely preserved in git, we can delete the existing implementation entirely.
3. **Design fresh** - Using this documentation as a specification, design a cleaner architecture that incorporates lessons learned but without the accumulated cruft.
4. **Rebuild from scratch** - Implement the new design with consistent patterns and cleaner code.

### Old and New Documents

- `world-rendering-system-architecture-old.md` — describes exactly how the old system works
- `world-rendering-system-architecture-new.md` — describes how we want the new system to work

**THIS IS THE NEW VERSION.** Reference the old document for implementation details of the current system.

---

# Table of Contents

1. [Design Considerations](#design-considerations)
2. [Architecture Overview](#architecture-overview)
3. [Query Infrastructure](#query-infrastructure)
4. [Terrain System](#terrain-system)
5. [Wave System](#wave-system)
6. [Wind System](#wind-system)
7. [Surface Rendering](#surface-rendering)

---

# Design Considerations

These are lessons learned from the old implementation and key decisions for the new system.

## 1. Point-Based Queries Instead of Tiles

**Problem with tiles**: The current tile system has resolution mismatches with camera zoom. When zoomed in, tile resolution is too low and things look blocky. When zoomed out, we compute hundreds of tiles at higher resolution than needed. We also compute data for regions that may never be queried.

**Proposed solution**: Instead of computing rectangular tiles, upload a buffer of specific query points and compute only those. This would:

- Eliminate resolution mismatches entirely
- Never compute data that isn't needed
- Require maintaining a point → buffer-index mapping

**Open question**: How does rendering work? Rendering needs dense 2D data for textures. Options:
- Rendering uses a separate system from gameplay queries
- Rendering requests points on a grid matching its texture resolution
- Some hybrid approach

## 2. Static vs Dynamic Data

The new system should distinguish between:

- **Static data** (terrain): Computed once, cached, invalidated only when modified (for editor or gameplay)
- **Dynamic data** (water, eventually wind): Computed per-frame or on-demand

## 3. Eliminating CPU Fallback Code

**Goal**: If we use point-based queries, we can ensure all needed points are always computed on GPU, eliminating the need for CPU fallback entirely. This is a huge win for maintainability—no more keeping CPU and GPU implementations in sync.

## 4. Wetness System Simplification

The current wetness system is complex (ping-pong textures, snapped viewports, reprojection) and still has artifacts. Open to simpler approaches. Key constraint: wetness is purely visual, no gameplay effect.

## 5. Remove Pre-computed Influence Fields

Decision: Remove the `InfluenceFieldManager` entirely. Wind should be written similarly to the wave system, possibly sharing code. Terrain influence on wind/water should be computed inline, not pre-cached.

## 6. Coordinate Space Conventions

**Problem**: Viewport/rect handling has been error-prone.

**Solution**:
- Use "rect" not "viewport" where appropriate
- Names must indicate coordinate space: `worldRect`, `screenRect`, `textureRect`
- Provide helper functions to translate between spaces
- Most margins should be 1-2 texels, not percentages

## 7. Wave Shadow System

The wave shadow system is working well and should be preserved. Core idea: compute shadow geometry for each island and wave source, use that geometry when determining wave energy at any point.

## 8. Wind System is Placeholder

Current wind is simple simplex noise. Will be redesigned after the water system is solid, using similar patterns and possibly sharing code.

---

# Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      Game Entities                          │
│              (Boat, Particles, Camera, etc.)                │
└─────────────────────────┬───────────────────────────────────┘
                          │ query points
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Query Infrastructure                       │
│         (Point-based GPU compute + async readback)          │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
    ┌──────────┐    ┌──────────┐    ┌──────────┐
    │ Terrain  │    │  Waves   │    │   Wind   │
    │ (static) │    │(dynamic) │    │(dynamic) │
    └──────────┘    └──────────┘    └──────────┘
          │               │               │
          └───────────────┼───────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Surface Rendering                          │
│    (Composites world data into final visual output)         │
└─────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Simulation independent of camera**: Game physics should work the same regardless of where the camera is, or if there's no camera at all.

2. **Query what you need**: Don't compute data speculatively. Entities request the specific points they need.

3. **GPU-first, no CPU fallback**: All world data computation happens on GPU. No duplicate CPU implementations to maintain.

4. **Static data is cached**: Terrain computed once and cached. Dynamic data (waves, wind) computed on-demand.

5. **Rendering is separate**: The visual rendering system consumes world data but has its own concerns (resolution, margins, textures).

---

# Query Infrastructure

*TODO: Design the point-based query system*

## Core Concept

Entities that need world data (boat needing wave heights, particles needing wind velocity) submit query points to the system. The system:

1. Collects all query points for the frame
2. Uploads them to GPU
3. Runs compute shaders to evaluate each point
4. Reads back results asynchronously
5. Provides results to entities (with one frame latency)

## Open Questions

- How do entities register query points? Interface design?
- How is the point → result mapping maintained?
- How does rendering get dense texture data if queries are sparse points?
- Should there be different "query pools" for different data types (terrain vs water vs wind)?

---

# Terrain System

*TODO: Flesh out terrain system design*

## Overview

Terrain is static data defined by contours (closed Catmull-Rom splines at specific heights). It's computed once and cached, with invalidation when the map is modified.

## Key Components

- **Contour definitions**: Spline control points + height
- **Containment tree**: Hierarchy of which contours contain which others
- **Height computation**: Tree traversal + inverse-distance weighting
- **Coastline extraction**: Height=0 contours, used by wave shadow system

## Caching Strategy

- Compute terrain heights to a texture/buffer once at load
- Invalidate and recompute when terrain is modified (editor, gameplay)
- Point queries sample from cached data

---

# Wave System

*TODO: Flesh out wave system design*

## Overview

Dynamic water simulation using Gerstner waves with shadow-based diffraction around terrain.

## Key Components

### Wave Mathematics
- Gerstner wave formula (trochoid surface)
- Multiple wave components (swell + chop)
- Phase, amplitude, wavelength, direction per component

### Shadow Geometry (preserved from old system)
- Coastline extraction from terrain
- Silhouette point computation (where coastline tangent ∥ wave direction)
- Shadow polygon construction (silhouette pairs + leeward arc)
- Shadow texture rasterization for O(1) lookups

### Depth Effects
- Shoaling: waves grow taller in shallow water (Green's Law)
- Damping: bottom friction attenuates waves in shallow water

### Wake Effects
- Local disturbances from boats
- Segment-based wake particles

---

# Wind System

*TODO: Design wind system properly*

## Current State (Placeholder)

Simple simplex noise variation on a base wind vector. Not representative of final design.

## Future Direction

Should be designed similarly to the wave system:
- Base wind field with variation
- Terrain influence computed inline (not pre-cached)
- Possibly share infrastructure/patterns with wave system
- Shadow-like effects for wind blocking by terrain?

---

# Surface Rendering

*TODO: Flesh out rendering design*

## Overview

The visual output pipeline. Composites world data into the final image displayed to the player.

## Key Components

### Water Rendering
- Sample wave heights for normal computation
- Depth-based coloring (shallow → deep gradient)
- Fresnel reflections
- Foam at shoreline
- Specular highlights

### Terrain Rendering
- Height-based coloring or texturing
- Contour visualization (debug mode)

### Wetness Effect
- Visual darkening of sand when wet
- Needs redesign—current ping-pong system is complex
- Purely visual, no gameplay effect

### Compositing
- Fullscreen shader combining all layers
- Lighting model (sun direction, ambient, diffuse, specular)

## Rendering vs Simulation

Rendering has different needs than gameplay simulation:
- Needs dense 2D texture data (not sparse points)
- Cares about camera viewport and zoom level
- Can tolerate lower precision / approximations
- Only needs data that will be visible

How rendering gets its data (when simulation uses point queries) is an open question.
