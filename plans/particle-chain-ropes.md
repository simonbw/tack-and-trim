# Particle Chain Rope System

Replace the current Sheet implementation (RopeSpring3D + VerletRope) with a particle chain rope system using lightweight DynamicBody particles connected by upper-limit-only DistanceConstraint3D constraints. This is the foundation for later adding blocks, winches, and shader-based rope rendering.

## Current State

### Sheet.ts (`src/game/boat/Sheet.ts`)
- Owns a `RopeSpring3D` for physics (one-way spring, only pulls when taut)
- Owns a `VerletRope` for visuals (CPU verlet integration, purely cosmetic)
- Physics and visuals are decoupled — the verlet rope positions don't affect physics
- Spring can inject energy when rest length changes quickly during trimming
- Sheet is a `BaseEntity` with `springs = [this.spring]` — auto-added to world

### VerletRope (`src/game/rope/VerletRope.ts`)
- 2D-only simulation (x, y positions; z is lerped at render time)
- Verlet integration with gravity, distance constraint satisfaction
- Endpoints locked to provided world positions each frame
- Rendered via quadratic Bezier tessellation in BoatRenderer

### RopeSpring3D (`src/core/physics/springs/RopeSpring3D.ts`)
- Force model: `F = -k*(dist - L) - d*relVel` (only when dist > L)
- Full 3D torque via `applyForce3D` on 6DOF bodies
- `maxForce` clamp can truncate damping before stiffness (energy injection risk)

### Anchor rode (existing particle chain — `src/game/boat/Anchor.ts:187-265`)
- **Already implements the pattern we need.** Uses `DynamicBody` + `Particle` shape + `DistanceConstraint3D` with `upperLimitEnabled=true, lowerLimitEnabled=false`.
- Particles created with `sixDOF` for z-axis physics.
- Length changes by updating `upperLimit` on ALL constraints uniformly.
- Particles and constraints are added/removed from `game.world` directly (not via entity `bodies`/`constraints` arrays, because they're dynamic).

### BoatRenderer sheet rendering (`src/game/boat/BoatRenderer.ts:643-684`)
- Gets rope points from `sheet.getRopePoints()` (VerletRope positions)
- Interpolates z linearly from zA to zB
- `subdivideSmooth()` → `tessellatePolylineToStrip()` → `submitTrianglesWithZ()`

### Consumers of Sheet
- `Boat.ts` — creates mainsheet (boom→hull) and jib sheets (clew→hull port/starboard)
- `PlayerBoatController.ts` — calls `sheet.adjust(input, dt)`, `sheet.release()`, `sheet.isAtMaxLength()`
- `BoatRenderer.ts` — calls `sheet.getRopePoints()`, `getOpacity()`, `getZA()`, `getZB()`, `getRopeThickness()`, `getRopeColor()`
- `SailDamage.ts` — receives a sheet reference but doesn't call any methods on it (just stores it)

### Key Physics Context
- Gravity is **not** built into the physics engine — entities apply their own gravity forces per tick
- The GS solver handles constraints iteratively (default 10 iterations, tolerance 1e-7)
- Island splitting partitions connected bodies into independent groups for solving
- `DistanceConstraint3D` already has `upperLimitEnabled`/`lowerLimitEnabled` with correct Jacobian for 3D torque

## Desired Changes

### Goal
Replace the spring+visual-rope approach with a single unified particle chain where the particle positions ARE the rope geometry. The distance constraints connecting particles provide both the physics coupling (force transmission between bodies) and the visual rope shape (catenary/sag).

### Why
1. **Energy stability** — distance constraints are solved by the GS impulse solver, which is dissipative by nature (can't inject energy). Springs with force clamping can.
2. **Unified physics+visuals** — no more separate visual sim that can diverge from physics reality.
3. **Foundation for blocks/winches** — a particle chain naturally splits into segments at redirect points. The anchor rode already proves this pattern works.
4. **True 3D** — particles with 6DOF give real z-positions instead of linearly-interpolated visual z.

### Constraints
- Must preserve the existing Sheet public API (or update all consumers)
- Must work with existing 6DOF hull body, boom body, and jib clew body
- Particle bodies and constraints must be added/removed from the world dynamically (like the anchor rode), since sheets are child entities created in Boat's constructor before `onAdd`
- Must not break the existing anchor rode system
- Rope particles should not collide with anything (no collision shapes needed, or use collisionFilter)

## Files to Modify

### New Files

- **`src/game/rope/Rope.ts`** — Core rope class. Owns particle bodies, constraints, and manages the chain.
  - Constructor takes: endpoint body A, local anchor A (3D), endpoint body B, local anchor B (3D), particle count, total length
  - Creates `PARTICLE_COUNT` DynamicBody particles with Particle shape and sixDOF enabled
  - Creates `PARTICLE_COUNT + 1` DistanceConstraint3D constraints:
    - bodyA → particle[0] (upper-limit only)
    - particle[i] → particle[i+1] for interior pairs (upper-limit only)
    - particle[last] → bodyB (upper-limit only)
  - Particles get gravity each tick (small z-gravity for sag, configurable)
  - `setLength(length)` updates the upper limit on ALL interior constraints uniformly. The endpoint constraints (bodyA→first, last→bodyB) keep upper limit = 0 (pinned). This distributes length evenly across the free chain.
  - `getPoints(): V2d[]` returns particle world positions (plus endpoint positions from bodies) for rendering
  - `getPointsWithZ(): {points: [number, number][], z: number[]}` returns positions + z-values for 3D rendering
  - `attach(world)` / `detach(world)` add/remove particles+constraints from the physics world
  - Applies per-particle gravity forces in a `tick` method (called by Sheet)
  - Applies per-particle damping (linear velocity damping on each particle body)

### Modified Files

- **`src/game/boat/Sheet.ts`** — Rewrite to use `Rope` instead of `RopeSpring3D` + `VerletRope`
  - Replace `spring: RopeSpring3D` and `visualRope: VerletRope` with `rope: Rope`
  - Remove `springs = [this.spring]` — no more springs on this entity
  - `adjust()` / `release()` / `setPosition()` update `rope.setLength()`
  - `getRopePoints()` delegates to `rope.getPoints()`
  - New `getRopePointsWithZ()` for 3D-aware rendering
  - `onTick` calls `rope.tick(dt)` for gravity/damping instead of `visualRope.update()`
  - `onAdd` calls `rope.attach(this.game.world)` to add particles to physics world
  - `onDestroy` calls `rope.detach(this.game.world)` to clean up

- **`src/game/boat/BoatRenderer.ts`** (minor) — Update `renderSheet()` to use `getRopePointsWithZ()` instead of manually lerping z between zA and zB. The rest of the rendering pipeline (subdivideSmooth → tessellatePolylineToStrip → submitTrianglesWithZ) stays the same.

- **`src/game/boat/Boat.ts`** — No API changes needed if Sheet's constructor signature stays compatible. May need minor adjustments if Sheet constructor changes (e.g., removing `getHullBody` callback if no longer needed).

- **`src/game/boat/BoatConfig.ts`** — Possibly add `particleCount` to `SheetConfig`. The existing config fields (minLength, maxLength, stiffness, etc.) map naturally: `stiffness`/`springDamping`/`maxForce` become constraint stiffness/relaxation parameters; the rest stay as-is.

### Unchanged Files (for reference)
- `src/core/physics/constraints/DistanceConstraint3D.ts` — Used as-is (already has upper/lower limit support)
- `src/core/physics/body/DynamicBody.ts` — Used as-is (already supports sixDOF)
- `src/core/physics/shapes/Particle.ts` — Used as-is
- `src/game/boat/Rig.ts` — No changes (boom body remains the same)
- `src/game/boat/sail/Sail.ts` — No changes (jib clew body remains the same)
- `src/game/boat/PlayerBoatController.ts` — No changes (Sheet API preserved)

## Execution Order

### Phase 1: Create Rope class (independent — no existing code changes)

Create `src/game/rope/Rope.ts`:

1. Define `RopeConfig` interface:
   - `particleCount: number` (default 6)
   - `particleMass: number` (lightweight, ~0.1 lbs)
   - `gravity: number` (z-axis gravity for sag, ~10 ft/s²)
   - `damping: number` (linear damping on particles, ~0.5)
   - `constraintStiffness: number` (maps to Equation stiffness, ~1e6 for rigid)
   - `constraintRelaxation: number` (maps to Equation relaxation, ~4)

2. Implement `Rope` class:
   - Constructor: takes bodyA, localAnchorA (3D), bodyB, localAnchorB (3D), totalLength, config
   - `attach(world)`: creates particles + constraints, adds to world
   - `detach(world)`: removes particles + constraints from world
   - `tick(dt)`: applies gravity + damping to each particle
   - `setLength(length)`: updates constraint upper limits on interior segments
   - `getPoints()`: collects [bodyA anchor, ...particle positions, bodyB anchor]
   - `getPointsWithZ()`: same but includes z-values from 6DOF positions
   - `getTension()`: returns constraint force magnitude at the taut end (for future use)
   - Interior particle initialization: spread evenly along straight line between endpoints

3. Particle setup pattern (following Anchor.ts):
   ```
   new DynamicBody({
     mass: particleMass,
     position: [px, py],
     fixedRotation: true,
     damping: 0,  // we apply damping manually for control
     allowSleep: false,
     sixDOF: {
       rollInertia: 1,
       pitchInertia: 1,
       zMass: particleMass,
       zDamping: 0,
       rollPitchDamping: 0,
       zPosition: pz,
     },
   });
   particle.addShape(new Particle());
   ```

4. Constraint setup:
   ```
   const c = new DistanceConstraint3D(bodyI, bodyJ, {
     localAnchorA: anchorA,
     localAnchorB: anchorB,
     distance: segmentLength,
   });
   c.upperLimitEnabled = true;
   c.lowerLimitEnabled = false;
   c.upperLimit = segmentLength;
   ```

5. The first constraint (bodyA → particle[0]) and last constraint (particle[last] → bodyB) use the provided local anchors on the endpoint bodies and [0,0,0] on the particle side.

### Phase 2: Rewrite Sheet to use Rope (depends on Phase 1)

1. Replace Sheet internals:
   - Remove `RopeSpring3D` and `VerletRope` imports
   - Replace with `Rope` import
   - Constructor: create `Rope` instance instead of spring + visual rope
   - Remove `springs` property (no more spring-based physics)

2. Lifecycle management:
   - `onAdd()`: call `this.rope.attach(this.game.world)` — this is when we have access to `this.game`
   - `onDestroy()`: call `this.rope.detach(this.game.world)`
   - `onTick()`: call `this.rope.tick(dt)` instead of `visualRope.update()`

3. Preserve public API:
   - `adjust(input, dt)` → updates position → calls `rope.setLength(this.getSheetLength())`
   - `release()` → sets position to 1 → calls `rope.setLength(maxLength)`
   - `setPosition(pos)` → updates position → calls `rope.setLength()`
   - `getRopePoints()` → delegates to `rope.getPoints()`
   - `getOpacity()`, `getZA()`, `getZB()` → keep as-is for BoatRenderer compat
   - `getRopeThickness()`, `getRopeColor()` → keep as-is
   - Add `getRopePointsWithZ()` → delegates to `rope.getPointsWithZ()`

4. Update SheetConfig:
   - Add optional `particleCount?: number` (default 6)
   - Keep `stiffness`/`springDamping`/`maxForce` fields but map them to constraint parameters
   - Or simplify: remove spring-specific fields, since constraints are inherently stiff

### Phase 3: Update BoatRenderer (depends on Phase 2)

1. Update `renderSheet()`:
   - Use `sheet.getRopePointsWithZ()` to get real z-values from particle positions
   - Remove the manual `lerp(zA, zB, t)` z-interpolation
   - Rest of the pipeline unchanged: `subdivideSmooth()` → `tessellatePolylineToStrip()` → `submitTrianglesWithZ()`

### Phase 4: Update Boat.ts if needed (depends on Phase 2)

1. If Sheet constructor signature changed, update the three sheet creation sites in Boat.ts
2. Most likely: remove `getHullBody` parameter (was for spring force application; constraints handle this natively)
3. May need to pass `particleCount` in config

## Design Notes

### Why not reuse VerletRope?
VerletRope is a visual-only simulation. Its particle positions don't participate in the physics world — they can't exert forces on the boom or hull. By using real physics particles, we get force transmission for free through the constraint solver.

### Particle count
6 interior particles is a good starting point (8 total points including endpoints). This gives enough visual resolution for a natural catenary while keeping the constraint count low. The anchor rode uses `RODE_PARTICLE_COUNT` (likely 8-12) for a much longer rope.

### Gravity model
The VerletRope currently uses `V(0, 3)` as gravity — a very weak 2D downward pull for visual sag. For true 3D particles, we apply z-force: `particle.applyForce3D(0, 0, -gravity * mass, 0, 0, 0)`. The gravity value needs tuning — it should produce visible sag when slack but not overpower the constraint solver when taut.

### Z-height initialization
Particles should be initialized with z-values interpolated between the endpoint z-heights (zA, zB). When the rope is taut, constraints keep them in a straight line. When slack, gravity pulls the interior particles down, creating a natural 3D catenary.

### Collision filtering
Rope particles should NOT collide with anything — not the hull, not each other, not the water. They're purely for force transmission and visual shape. Use `collisionGroup = 0` and `collisionMask = 0` on the particle shapes (or just don't add collision shapes — a DynamicBody without shapes won't participate in collision but WILL participate in constraints).

Wait — checking Anchor.ts: it does `particle.addShape(new Particle())`. The Particle shape has zero area and zero bounding radius. Need to verify whether the broadphase even generates pairs for Particle shapes. If it does, we should set collision masks to avoid wasting cycles.

### Energy comparison
- **Springs**: apply force each frame proportional to displacement. Force accumulates. Can overshoot.
- **Constraints**: solver applies impulses bounded by `[minForce*dt, maxForce*dt]`. Dissipative by construction (Gauss-Seidel). Can't overshoot unless maxForce is too low for the scenario.

### Future block integration point
The Rope class should be designed so that a future `RopeSegment` concept can split the particle chain. The key extensibility: `setLength()` currently distributes length evenly. A block would instead adjust only the constraint adjacent to the block point. The Rope class doesn't need to know about blocks yet, but its internal structure (array of particles, array of constraints) should be cleanly accessible for a future `Block` class to manipulate.
