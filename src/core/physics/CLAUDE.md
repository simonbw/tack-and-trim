# Physics Engine

Custom rigid body physics engine (not a wrapper around another library).

## Architecture

- **World** - Central container managing bodies, constraints, springs, and collision
- **Bodies** - DynamicBody, StaticBody, KinematicBody with shared Body base
- **Shapes** - Circle, Convex, Particle, Line, Plane, Heightfield attached to bodies
- **Collision** - Broadphase (spatial hashing) → Narrowphase → Contact generation

## Key Patterns

### Island Splitting

Connected bodies form "islands" that can sleep together. See `world/Island.ts`.

### Solver Pipeline

1. Broadphase finds potential pairs
2. Narrowphase generates ContactEquations
3. GSSolver iterates to resolve constraints

### Substepping

`World.step(dt)` supports splitting the constraint-solve + position-integrate
phase into `N = WorldOptions.substeps` iterations at `h = dt / N`. Broadphase,
narrowphase, and contact/friction equation generation run once per step;
entity-applied forces are folded into velocity once at the full `dt`; then
the substep loop refreshes constraint Jacobians (`constraint.update()`),
solves at `h`, and advances positions at `h`. This stiffens ropes and other
long constraint chains without multiplying collision detection cost. Default
is `1` (legacy behavior).

### Adding New Collision Types

1. Create shape in `shapes/`
2. Add narrowphase handler in `collision/narrowphase/shape-on-shape/`
3. Register in the shape-pair dispatch table

## Common Tasks

- **Raycast**: `world.raycast(from, to, options)` - see RaycastOptions for filtering
- **Body sleeping**: Configure via World's sleepingMode (NO_SLEEPING, BODY_SLEEPING, ISLAND_SLEEPING)
