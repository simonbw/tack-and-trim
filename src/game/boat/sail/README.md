# Sail System

This directory contains the sail simulation for Tack & Trim. Each sail
is a 2D-mesh cloth solved with Verlet integration in 3D, with
aerodynamic forces applied per-triangle from a sample of the wind
field.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                           Sail.ts                               │
│  Main entity: owns the cloth, drives sim, applies wind forces,  │
│  reports reaction forces back to the boat                       │
└──────────────┬──────────────────────────────────┬───────────────┘
               │ uses                             │ rendered by
               ▼                                  ▼
┌─────────────────────────────┐   ┌──────────────────────────────┐
│  SailMesh.ts                │   │  ClothRenderer.ts            │
│  Generates triangular cloth │   │  Per-vertex normals + custom │
│  mesh in UV space + the     │   │  cel-shaded GPU pipeline     │
│  structural/shear/bend      │   │  (SailShader.ts)             │
│  constraint topology        │   └──────────────────────────────┘
└──────────────┬──────────────┘
               │ data
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  ClothSolver.ts / ClothSolverSync.ts                             │
│  3D Verlet integrator, distance-constraint projection iterations,│
│  pre-allocated typed arrays — zero allocation after warmup       │
└──────────────┬───────────────────────────────────────────────────┘
               │ wind forces from
               ▼
┌──────────────────────────────────────────────────────────────────┐
│  sail-aerodynamics.ts                                            │
│  Per-triangle wind force from relative wind, lift/drag from thin │
│  airfoil theory with stall                                       │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  ClothWorkerPool.ts + cloth-worker.ts + cloth-worker-protocol.ts │
│  Optional web worker pool: SAB-backed handoff so the cloth       │
│  solver runs off the main thread. Falls back to ClothSolverSync  │
│  when SharedArrayBuffer is unavailable                           │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  TellTail.ts                                                     │
│  Visual indicator: small streamer attached to the leech that     │
│  shows the player how flow is leaving the sail. Visual only.     │
└──────────────────────────────────────────────────────────────────┘
```

## File Descriptions

### Sail.ts

Top-level entity. Owns the `ClothSolver`, samples wind via a
`WindQuery`, calls into `sail-aerodynamics.ts` to compute per-triangle
forces, and exposes reaction forces (tack, head, clew) so the boat's
rigging can be driven by them. Also handles hoist/furl animation,
sail-to-sail wind shadowing inputs, and registration with the cloth
worker pool.

### SailMesh.ts

Generates the rest geometry of a triangular cloth: vertex UV positions,
z-heights, triangle indices, and the constraint lists that wire the
mesh together (structural along edges, shear across diagonals, bend
across skip-one neighbours).

### ClothSolver.ts / ClothSolverSync.ts

3D Verlet cloth solver. `ClothSolver` is the SAB-backed variant used by
the worker pool; `ClothSolverSync` is the fallback that runs on the
main thread when SharedArrayBuffer is unavailable. Both keep their state
in pre-allocated `Float64Array`/`Float32Array` buffers and project
distance constraints over multiple iterations per substep.

### sail-aerodynamics.ts

Pure functions for force calculations:

- `getSailLiftCoefficient()` — lift vs angle of attack with a
  thin-airfoil pre-stall slope and an exponential post-stall decay
- `computeDragCoefficient()` — base + induced + stall-penalty drag
- Per-triangle wind force using **relative wind** (true wind minus
  surface velocity) so the force naturally damps as the cloth catches
  up to the wind — no separate dashpot needed

### ClothWorkerPool.ts, cloth-worker.ts, cloth-worker-protocol.ts

Optional off-main-thread cloth simulation. The pool spawns one worker
per sail; positions are exchanged through SharedArrayBuffer
double-buffering. The wrapper class `SailWorkerHandle.ts` hides the
worker/sync split from `Sail.ts`.

### ClothRenderer.ts + SailShader.ts

CPU computes per-vertex normals (averaged face normals) each frame and
submits positions+normals through a custom GPU pipeline that does
cel-shaded lighting per fragment.

### TellTail.ts

Small particle streamer entity attached to the sail leech that gives
visual feedback about flow direction. Not coupled to the cloth — a
purely visual cue.

## Physics Model

### Mesh Topology

A triangular cloth in normalized UV space:

- **Foot** lies along the u-axis (along the boom).
- **Luff** lies along the v-axis (up the mast).
- Rows taper from `footColumns` vertices at v=0 to a single vertex at
  v=1 (the head).
- Three constraint sets keep it stiff: structural (edges), shear
  (diagonals), bend (skip-one).

### Aerodynamic Forces

Forces are computed per-triangle using thin airfoil theory.

**Lift coefficient**, pre-stall (α < 15°): `Cl = 2π · sin(α)`.

**Post-stall** (α > 15°): exponential decay
`Cl = Cl_peak · e^(-3(α - α_stall))`.

**Drag coefficient**: `Cd = 0.02 (base) + 0.1·α² (induced) +
stall_penalty`.

Forces applied per triangle:

- Lift perpendicular to flow direction, magnitude `Cl · q · A`
- Drag opposing flow direction, magnitude `Cd · q · A`
- `q = ½ρv²` (relative wind), `A` = triangle area scaled by hoist

Total triangle force is distributed 1/3 to each vertex.

### Hoist / Furl

`Sail` exposes a `FurlMode` that the cloth worker uses to scale
triangle area (so partially furled sails generate proportionally less
force) and constraint stiffness. `hoistAmount` (0–1) animates between
states.

## Configuration

Tunables (most exposed via `//#tunable` comments at the top of the
file) include:

| Parameter            | Default | Description                                |
| -------------------- | ------- | ------------------------------------------ |
| `CLOTH_ITERATIONS`   | 20      | Constraint projection iterations per step  |
| `CLOTH_SUBSTEPS`     | 4       | Solver substeps per game tick              |
| `CONSTRAINT_DAMPING` | 0.2     | Dashpot factor along constraint directions |
| `CLOTH_MASS`         | 8.0 lbs | Total cloth mass                           |
| `STALL_ANGLE`        | 15°     | Angle of attack at which stall begins      |

## Usage

`Sail` is constructed with anchor accessors (head/tack/clew positions
in world space), the rest geometry config, and registers with the
`ClothWorkerPool` singleton. Per-tick it:

1. Samples wind via its `WindQuery` at the sail's center.
2. Lets the cloth solver step (in a worker if available).
3. Reads back per-triangle reaction forces and applies them to the
   boat's rigging anchors.
4. Updates `ClothRenderer` so the next render frame draws the new
   geometry.
