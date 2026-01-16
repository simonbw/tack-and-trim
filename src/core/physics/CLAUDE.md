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

### Adding New Collision Types
1. Create shape in `shapes/`
2. Add narrowphase handler in `collision/narrowphase/shape-on-shape/`
3. Register in the shape-pair dispatch table

## Common Tasks

- **Raycast**: `world.raycast(from, to, options)` - see RaycastOptions for filtering
- **Body sleeping**: Configure via World's sleepingMode (NO_SLEEPING, BODY_SLEEPING, ISLAND_SLEEPING)
