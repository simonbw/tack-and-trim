# 6DOF Physics Engine Refactor

Extend the core physics engine to support optional 6DOF rigid bodies (x, y, z, roll, pitch, yaw) alongside existing 3DOF bodies. This eliminates the separate `BuoyantBody` integrator and unifies all boat physics into the core engine. Then add hull edge form drag to fix the spinning bug.

## Current State

### Core Physics Engine (`src/core/physics/`)

The engine is a 3DOF rigid body simulator: x, y, yaw.

- **`DynamicBody`** tracks: `position: V2d`, `angle: number`, `velocity: V2d`, `angularVelocity: number`, `force: V2d`, `angularForce: number`, `mass`, `inertia` (scalar)
- **`Equation`** base class uses `G: Float32Array(6)` — Jacobian with layout `[vx_A, vy_A, wz_A, vx_B, vy_B, wz_B]`
- **`GSSolver`** stores per-body solver state: `vlambda: V2d`, `wlambda: number`, `invMassSolve: number`, `invInertiaSolve: number`
- **Constraints**: `RevoluteConstraint` (2 eqs: x/y pivot), `DistanceConstraint` (1 eq: distance), `LockConstraint` (3 eqs: x/y/angle). All use 2D anchor points.
- **`World.step()`** order: applyForces → broadphase → narrowphase → generateEquations → solve → integrate
- **Integration**: Semi-implicit Euler in `DynamicBody.integrate()`: velocity += force/mass * dt, position += velocity * dt, angle += angularVelocity * dt

### Boat 3D Physics (`src/game/boat/`)

A separate layer on top of the 2D engine:

- **`BuoyantBody`** wraps a `DynamicBody` and manually tracks `z`, `roll`, `pitch` + their velocities. Has its own semi-implicit Euler integrator (`integrateVertical`). Force accumulators: `zForce`, `rollTorque`, `pitchTorque`.
- **`BuoyantBody.applyForce3D(fx, fy, fz, localX, localY, localZ)`** splits forces: sends `(fx, fy)` to the 2D body at `(localX, localY)`, computes roll/pitch torques from 3D cross product, accumulates fz.
- **`BuoyantBody.applyVerticalTorqueFrom()`** exists for forces that already flow through 2D constraints (sail → boom, rudder). Computes 3D torques without re-applying 2D forces.
- **`Boat.onTick()`** manually calls `buoyantBody.integrateVertical(dt)` and `resetVerticalForces()` after all child entities have applied their forces.
- **`TiltTransform`** builds a 2x3 rotation matrix from roll/pitch/yaw angles for rendering.
- **`Hull`** has zero angular damping and only skin friction — no edge-based form drag.

### Problems with the Split

1. **Constraint reactions don't generate roll/pitch torques.** When the 2D solver resolves boom/mast constraints, reaction forces create roll/pitch moments in reality, but the 3D layer never sees them.
2. **One-way coupling.** 2D drives 3D (tilt affects force computation), but 3D doesn't feed back into 2D.
3. **Manual bookkeeping.** Each component must know whether to use `applyForce3D` (direct force) or `applyVerticalTorqueFrom` (force already in constraint system). The rudder does a coordinate frame dance; the sail has a one-frame lag.
4. **Duplicate integration.** Two separate integrators with no energy conservation.
5. **Missing hull form drag.** Hull waterline edges have no flat-plate drag, only skin friction (Cf=0.003). This is why the boat spins uncontrollably when the sail opens.

## Desired Changes

- `DynamicBody` optionally supports 6DOF with **rotation matrix** orientation (not Euler angles — supports full capsizing).
- Single `applyForce3D()` method on `DynamicBody` handles all 6 DOFs.
- Constraint solver Jacobians expand from 6 to 12 components. Constraints automatically produce roll/pitch/z effects when connected to 6DOF bodies.
- Unified integration in one pass inside `World.step()`.
- `BuoyantBody` stops being an integrator and becomes a simple force-computing entity.
- After migration, add hull edge flat-plate drag to fix the spinning bug.

### Key Design Decisions

- **Rotation matrix** (3x3) for orientation, not Euler angles or quaternions. Supports full rotation without gimbal lock. Yaw extracted as `atan2(R[3], R[0])` for backward compat with `body.angle`.
- **Diagonal body-frame inertia** (3 scalars: roll, pitch, yaw). World-frame inverse inertia tensor (3x3) recomputed each step from `R * diag(1/Ix, 1/Iy, 1/Iz) * R^T` — 27 multiplies, negligible cost.
- **Collision stays 2D.** Shapes are 2D, broadphase/narrowphase unchanged. Contact equations use z=0.
- **Always 12-component G vectors.** For 3DOF bodies, extra components are 0 and inverse mass/inertia for z/roll/pitch are 0, so they contribute nothing. No branching in hot solver loop.
- **Angular velocity in world frame.** Solver operates in world frame. Body-frame inertia is transformed to world frame for the solver.

## Files to Modify

### Phase 1: Core Engine Foundation

#### Phase 1A: DynamicBody 6DOF State

- **`src/core/physics/body/DynamicBody.ts`**
  - Add `DynamicBody6DOFOptions` extending `DynamicBodyOptions`: `zPosition`, `rollInertia`, `pitchInertia`
  - Add optional fields: `_z: number`, `_zVelocity: number`, `_zForce: number`
  - Add `_orientation: Float64Array(9)` (3x3 rotation matrix, identity by default). For 3DOF bodies, this stays identity with `angle` controlling yaw as before. For 6DOF, this is the full orientation.
  - Add `_angularVelocity3: Float64Array(3)` — [wx, wy, wz] in world frame. For 3DOF bodies, only [2] (wz = yaw rate) is used; kept in sync with existing `_angularVelocity`.
  - Add `_angularForce3: Float64Array(3)` — [tx, ty, tz] torque accumulator in world frame.
  - Add `_rollInertia`, `_pitchInertia` (body-frame, diagonal). Existing `_inertia` becomes yaw inertia.
  - Add `_invWorldInertia: Float64Array(9)` — world-frame 3x3 inverse inertia tensor, recomputed each step.
  - Add `is6DOF: boolean` getter.
  - Add `z`, `zVelocity`, `roll`, `pitch` getters (roll/pitch extracted from orientation matrix).
  - Add `applyForce3D(fx, fy, fz, localX, localY, localZ)`: applies linear force to all 3 axes, computes 3D torque `r × F` (in world frame) and adds to `_angularForce3`.
  - Add `recomputeWorldInertia()`: `invI_world = R * diag(1/Ix, 1/Iy, 1/Iz) * R^T`.
  - Modify `integrate(dt)`: if 6DOF, also integrate z and orientation matrix. Orientation update: `R += skew(ω) * R * dt`, then re-orthogonalize (Gram-Schmidt). Extract yaw → `angle` for backward compat.
  - Modify `applyDamping(dt)`: if 6DOF, also damp z velocity and roll/pitch angular velocities.

- **`src/core/physics/body/Body.ts`**
  - Add abstract/optional: `is6DOF`, `z`, `zVelocity`, `angularVelocity3`, `invWorldInertia` so solver can access them generically.

#### Phase 1B: Equation & Solver Expansion

- **`src/core/physics/equations/Equation.ts`**
  - Change `G: Float32Array(6)` → `Float32Array(12)` with layout:
    ```
    [vx_A, vy_A, vz_A, wx_A, wy_A, wz_A, vx_B, vy_B, vz_B, wx_B, wy_B, wz_B]
    ```
  - Update `gmult()`: iterate 12 components. Takes 3D velocity/angular velocity vectors.
  - Update `computeGq()`: include z position and orientation in position-level evaluation.
  - Update `computeGW()`: use 3D velocity and angular velocity vectors.
  - Update `computeGWlambda()`: use 3D solver state vectors.
  - Update `computeGiMf()`: use 3D forces and 3x3 inverse inertia tensor.
  - Update `computeGiMGt()`: `G_lin^T * invM * G_lin + G_ang^T * invI_world * G_ang` for each body. The angular part is a quadratic form with the 3x3 world inertia tensor.
  - Update `addToWlambda()`: apply deltalambda to 3D vlambda and 3D wlambda using invM and invI_world.
  - Update `computeInvC()`.

- **`src/core/physics/solver/GSSolver.ts`**
  - Update `SolverBodyState`:
    ```
    vlambda: Float64Array(3)    // [vx, vy, vz]
    wlambda: Float64Array(3)    // [wx, wy, wz]
    invMassSolve: number        // scalar (same for x, y)
    invMassSolveZ: number       // 0 for 3DOF bodies
    invInertiaSolve: Float64Array(9)  // 3x3 world-frame inverse inertia tensor
    ```
  - Update `createSolverState()`: for 3DOF, set invMassSolveZ=0 and invInertiaSolve to `[0,0,0, 0,0,0, 0,0,invI_yaw]`.
  - Update final velocity application: `body.velocity += vlambda[0..1]`, `body.zVelocity += vlambda[2]`, `body.angularVelocity3 += wlambda`.
  - The iteration loop (`iterateEquation`) is unchanged in structure — the Equation methods handle the expanded math internally.

- **`src/core/physics/equations/ContactEquation.ts`**
  - Update `computeB()` where G is populated:
    ```
    G[0] = -n[0];  G[1] = -n[1];  G[2] = 0;          // Contact is 2D, no z force
    G[3..5] = -(ri_3d × n_3d)                          // 3D cross product for torque
    G[6] = n[0];   G[7] = n[1];   G[8] = 0;
    G[9..11] = (rj_3d × n_3d)
    ```
    Where `ri_3d = (ri.x, ri.y, 0)` and `n_3d = (n.x, n.y, 0)` since contacts are 2D. Cross product `(ri.x, ri.y, 0) × (nx, ny, 0) = (0, 0, ri.x*ny - ri.y*nx)`. So G[3]=0, G[4]=0, G[5]=-rixn — same as current, just with explicit zeros.

- **`src/core/physics/equations/FrictionEquation.ts`**
  - Same pattern as ContactEquation. Contacts are 2D so G[2], G[3], G[4], G[8], G[9], G[10] are 0.

- **`src/core/physics/equations/RotationalLockEquation.ts`**
  - Currently `G = [0, 0, 1, 0, 0, -1]` (yaw only).
  - Expand to: `G = [0,0,0, 0,0,1, 0,0,0, 0,0,-1]` — yaw lock stays the same.
  - Future: could add roll/pitch lock variants.

- **`src/core/physics/equations/RotationalVelocityEquation.ts`**
  - Currently `G = [0, 0, -1, 0, 0, ratio]`.
  - Expand to: `G = [0,0,0, 0,0,-1, 0,0,0, 0,0,ratio]`.

- **`src/core/physics/equations/AngleLockEquation.ts`**
  - Currently `G = [0, 0, ratio, 0, 0, -1]`.
  - Expand to: `G = [0,0,0, 0,0,ratio, 0,0,0, 0,0,-1]`.

#### Phase 1C: Constraint Updates

- **`src/core/physics/constraints/RevoluteConstraint.ts`**
  - Add optional `localPivotZA: number`, `localPivotZB: number` to options (default 0).
  - If either body is 6DOF, add a **third equation** constraining z-separation at pivot.
  - Update x/y equation Jacobian computation to use 3D cross products:
    ```
    ri_3d = (worldPivotA.x, worldPivotA.y, worldPivotZA_rotated)
    For x-equation: cross = ri_3d × (1, 0, 0) = (0, ri_z, -ri_y)
    G[3] = 0, G[4] = -ri_z, G[5] = ri_y  (roll/pitch torque from x-constraint!)
    ```
    For 3DOF bodies with z=0, this reduces to current behavior: G[3]=0, G[4]=0, G[5]=ri_y.
  - Update `computeGq` for each equation to include z-position in pivot separation.
  - **This is the key change**: when the boom constraint reacts, the 3D cross product at mast height automatically generates roll/pitch impulses on the hull.

- **`src/core/physics/constraints/DistanceConstraint.ts`**
  - Add optional `localAnchorZA`, `localAnchorZB`.
  - When both are 0 (default), behavior is identical to current.
  - When non-zero and either body is 6DOF: distance computed in 3D, G includes z components and 3D cross products for torque.

- **`src/core/physics/constraints/LockConstraint.ts`**
  - Add z-lock equation when either body is 6DOF.
  - Add roll/pitch lock equations when both bodies are 6DOF.

- **`src/core/physics/springs/LinearSpring.ts`**
  - Add optional `localAnchorZA`, `localAnchorZB`.
  - When non-zero and connected to a 6DOF body, spring force includes z-component and uses `applyForce3D`.

#### Phase 1D: World Integration

- **`src/core/physics/World.ts`**
  - In `applyForces()`: call `body.recomputeWorldInertia()` for 6DOF bodies (before damping/springs).
  - In `integrate()`: the existing call to `body.integrate(dt)` already delegates — `DynamicBody.integrate` handles 6DOF internally.
  - In `solve()`: the solver application step needs to write back 3D vlambda/wlambda to bodies. Currently it does `body.velocity.iadd(vlambda)` and `body.angularVelocity += wlambda`. Update to handle 3D vectors: `body.zVelocity += vlambda[2]`, `body.angularVelocity3[0..2] += wlambda[0..2]`.

### Phase 2: Migrate Boat Physics

#### Phase 2A: Hull as 6DOF Body

- **`src/game/boat/BoatConfig.ts`**
  - Move `rollInertia`, `pitchInertia`, `maxRoll`, `maxPitch`, `centerOfGravityZ` from `BuoyancyConfig` into `HullConfig` (these are now body properties). Keep `BuoyancyConfig` for buoyancy-specific params (`verticalMass`).

- **`src/game/boat/Hull.ts`**
  - Construct `DynamicBody` with 6DOF options: `rollInertia`, `pitchInertia` from config.
  - Remove `buoyantBody` reference and `setBuoyantBody()`.
  - Change `onTick` skin friction: call `this.body.applyForce3D(fx, fy, fz, localX, localY, 0)` instead of going through BuoyantBody.
  - Remove `tiltRoll`, `tiltPitch` fields — read directly from `this.body.roll`, `this.body.pitch`.
  - `TiltTransform` update: read orientation from `this.body.orientation` (the rotation matrix), extract angles for rendering. Or update `TiltTransform.updateFromMatrix(R, hx, hy)`.

- **`src/game/boat/BuoyantBody.ts`**
  - Remove `integrateVertical()`, `resetVerticalForces()`, all velocity/position state, all force accumulators.
  - Remove `applyForce3D()`, `applyVerticalTorqueFrom()`, `applyTorque()`.
  - What remains: convenience wrapper for buoyancy config (verticalMass for displacement, centerOfGravityZ). Or just delete the class entirely and move buoyancy config to BoatConfig.

#### Phase 2B: Simplify Force Application

- **`src/game/boat/Buoyancy.ts`**
  - Replace `bb.applyForce3D(...)` with `this.hull.body.applyForce3D(...)`.
  - Access z offset from `this.hull.body.z` instead of `bb.z`.

- **`src/game/boat/Keel.ts`**
  - Replace `this.buoyantBody.applyForce3D(...)` with `this.hull.body.applyForce3D(...)`.
  - Remove `buoyantBody` constructor param.

- **`src/game/boat/Rudder.ts`**
  - Remove the dual force application pattern. Currently: apply 2D force to rudder body + `applyVerticalTorqueFrom` to hull. After: just apply force to rudder body. The constraint solver at the pivot (which now has a z-anchor at rudder depth) automatically generates roll/pitch on the hull.
  - Remove `buoyantBody` constructor param.
  - Set `localPivotZA` on the rudder RevoluteConstraint to the rudder z-depth.

- **`src/game/boat/sail/Sail.ts`**
  - Remove the tilt torque computation (lines 442-469, `_rollTorque`, `_pitchTorque`, `lastTackZ`, `lastHeadWZ`, `lastClewWorldZ`).
  - Remove `getTiltTorque()` method.
  - Sail reaction forces are already applied to the boom body. The boom's RevoluteConstraint at the mast (now with `localPivotZA` at mast height) automatically produces roll/pitch on the hull through the solver.
  - The boom body could optionally become 6DOF too, but likely not needed — the constraint coupling is sufficient.

- **`src/game/boat/Bilge.ts`**
  - Replace `this.boat.buoyantBody.applyForce3D(...)` with `this.boat.hull.body.applyForce3D(...)`.
  - Replace `this.boat.roll` / `this.boat.pitch` with `this.boat.hull.body.roll` / `.pitch`.

- **`src/game/boat/BoatGrounding.ts`**
  - Replace BuoyantBody force calls with `hull.body.applyForce3D(...)`.

#### Phase 2C: Remove Old Tilt Integration

- **`src/game/boat/Boat.ts`**
  - Remove `buoyantBody` field and its construction.
  - Remove `integrateVertical(dt)` and `resetVerticalForces()` calls from `onTick`.
  - Remove `applyTiltTorque()` method.
  - Remove sail tilt torque accumulation (lines 333-339).
  - Update `roll`/`pitch`/`rollVelocity`/`pitchVelocity` getters to read from `hull.body`.
  - Update `TiltTransform` update: read from body's rotation matrix instead of separate roll/pitch angles.
  - Update all child entity construction to remove `buoyantBody` params.

- **`src/game/boat/TiltTransform.ts`**
  - Add `updateFromRotationMatrix(R: Float64Array, hx: number, hy: number)` that copies the top 2 rows of R directly into m00..m12 (the 2x3 matrix), and extracts sin/cos values for the cached components.
  - Keep existing `update(roll, pitch, hullAngle, hx, hy)` for backward compat with non-6DOF use cases.

- **`src/game/boat/Rig.ts`**
  - Set `localPivotZA` on the boom RevoluteConstraint to boom height (e.g., 3 ft above waterline). This makes the constraint automatically generate roll/pitch torques when sail forces push the boom.

### Phase 3: Hull Edge Form Drag

- **`src/game/boat/Hull.ts`**
  - Add hull waterline edge form drag in `onTick()`:
    - For each consecutive pair of waterline vertices, call `computeFluidForces()` with `flatPlateDrag(draft, RHO_WATER)` as the drag function and a small lift function.
    - Apply resulting forces via `this.body.applyForce3D(fx, fy, 0, localX, localY, 0)`.
    - This gives the hull massive broadside resistance during yaw rotation — the dominant yaw damping mechanism that was completely missing.
  - Import `computeFluidForces`, `flatPlateDrag` from `fluid-dynamics.ts`.
  - Use the hull's `waterlineVertices` (or fall back to `vertices`).
  - The WaterQuery already exists for skin friction — reuse it for form drag velocity lookups.

## Execution Order

### Phase 1A + 1B: Engine data structures and solver (sequential)
Must be done together — the solver depends on the new body state, and the equation changes depend on the new G layout.

1. First: Add 6DOF state to `DynamicBody` (fields, getters, `applyForce3D`, `recomputeWorldInertia`, integration). Keep all existing behavior unchanged for 3DOF bodies.
2. Then: Expand `Equation.ts` G vector to 12 components and update all compute methods.
3. Then: Update `GSSolver.ts` solver state and velocity application.
4. Then: Update all equation subclasses (`ContactEquation`, `FrictionEquation`, `RotationalLockEquation`, `RotationalVelocityEquation`, `AngleLockEquation`) to populate 12-component G. For all current equations, the extra components (z, roll, pitch) are 0.

**Checkpoint: All existing tests/behavior unchanged. No 6DOF bodies exist yet.**

### Phase 1C: Constraint updates (can parallel across constraint types)
- `RevoluteConstraint` — add z pivot, 3D cross products, optional z-equation
- `DistanceConstraint` — add z anchors
- `LockConstraint` — add z/orientation equations
- `LinearSpring` — add z anchors

**Checkpoint: Constraints support 6DOF but no game code uses it yet.**

### Phase 1D: World integration
- Update `World.ts` for 6DOF integration and solver writeback.

**Checkpoint: Engine fully supports 6DOF bodies. Can write a test creating a 6DOF body with constraints.**

### Phase 2A + 2B + 2C: Boat migration (sequential)
These must be done together because they involve removing BuoyantBody's integration and replacing it with body-native 6DOF.

1. First: Update `BoatConfig` to move inertia params to hull config.
2. Then: Enable 6DOF on hull body. Update constraint z-anchors (Rig boom pivot, Rudder pivot).
3. Then: Simplify all force-applying entities (Hull, Keel, Rudder, Buoyancy, Bilge, BoatGrounding, Sail) to use `body.applyForce3D()`.
4. Then: Remove old integration from Boat.onTick, update TiltTransform.
5. Then: Remove/simplify BuoyantBody.
6. Finally: Test that boat physics work equivalently (roll/pitch/yaw from forces, constraint reactions, capsizing).

### Phase 3: Hull form drag (independent, after Phase 2)
- Add flat-plate drag on hull waterline edges.
- Test: opening the sail no longer causes runaway spinning.
