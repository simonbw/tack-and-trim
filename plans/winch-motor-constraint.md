# Winch as a Motorized Constraint

## Current State

Sheets and anchor rodes are cranked in by a per-tick force applied to the
tail-side rope particle of a `Pulley`:

- `src/game/rope/Pulley.ts:296-322` — `Pulley.applyForce(forceMagnitude,
  dirX, dirY, maxSpeed)`. Applied to the B-anchor particle (`indexA + 2`)
  each tick; taper scale `(1 - v_rope / maxSpeed)` fakes a stall near
  `maxSpeed`; Newton's third-law reaction is added to `pulleyBody.force`.
- `src/game/boat/Sheet.ts:264-306` — `Sheet.adjust` computes force magnitude
  and max speed each tick, transforms hull-local `config.tailDirection` to
  world space, calls `winch.applyForce`.
- `src/core/physics/equations/Equation.ts` — base class has
  `minForce`/`maxForce` fields (lines 73-76); `GSSolver.iterateEquation`
  clamps lambda to `[minForce·h, maxForce·h]` every iteration (GSSolver.ts
  lines 407-413).
- `src/core/physics/equations/RotationalVelocityEquation.ts` — the engine's
  existing "motor" pattern: pure velocity-target equation, overrides
  `computeB` as `B = -GW * b - h * GiMf` (no position term), uses
  `relativeVelocity` as the target. **Direct template for the new
  equation.**
- `src/core/physics/world/World.ts:512-517` — `solve()` flattens equations
  from `world.constraints.flatMap(c => c.equations)`. Non-contact equations
  must live inside a `Constraint` wrapper.
- `src/core/physics/constraints/PulleyConstraint3D.ts` — reference for a
  constraint wrapping multiple equations and swapping bodies on the fly
  (`setParticleA/B` pattern).
- Substepping is live (default N=8 in `src/game/index.tsx`). Constraint
  `update()` + solve + position integration run N times per tick, but
  forces are folded into velocity once per tick. So the current
  force-based winch lags the rope it drives.

### Pain points

1. **Force once per tick, rope solves 8×.** Winch pull lags rope tension
   by a full tick.
2. **Soft limiter is implicit and fragile.** `forceMag * (1 - v/maxSpeed)`
   conflates target speed and max force into one scalar, and cranking
   against an immovable rope can over-tension and stretch it.
3. **No stall guarantee.** Nothing prevents the winch from over-driving
   rope when the far end is anchored.

## Desired Changes

Reformulate the winch as a **velocity-target motor equation with clamped
impulse** between the tail particle and the pulley body. Solver clamps the
impulse every GS iteration, so when rope tension exceeds the configured
max pulling force the motor naturally stalls. Runs inside the substep loop
for free, so rope consumption tracks instantaneous tension.

**Relative-velocity formulation — critical.** The Jacobian has non-zero
entries on _both_ bodies (tail particle and pulley body). The impulse the
solver applies is equal-and-opposite, so pulling the tail particle one way
drags the pulley body (hull) the other way by the same impulse. Linear
and angular momentum are conserved between the two bodies on every
iteration — no momentum created from nothing. On an infinite-mass hull
this reads as "pull the particle toward the drum"; on a real finite-mass
hull the motor also nudges the boat forward and yaws it (because the
application point is offset from the hull CoM) with every crank, exactly
as a real winch would. This is directly analogous to
`RotationalVelocityEquation`, which drives the _relative_ angular velocity
between two bodies — same shape, linear axis instead of rotation axis.

### Motor equation details

- **Constraint axis `d`:** world-space unit vector along the tail
  direction, recomputed each `update()` from the pulley body's angle and
  a stored hull-local `tailDirection`.
- **Constraint row (G):** derived from scalar constraint
  `v_rel · d = targetSpeed`.
  - `G_A_linear = d` (particle's contribution to GW)
  - `G_A_angular = 0` (rope particles are point masses with fixedRotation)
  - `G_B_linear = -d` (pulley body's linear contribution)
  - `G_B_angular = -(r × d)` — r is the world-frame lever arm from
    pulley body center to the world anchor point. This term converts the
    reaction impulse into a torque on the hull when the pulley is offset
    from the CoM, so cranking a sheet yaws the boat as well as nudging
    it. For 6DOF bodies this goes in `G[9..11]`; for 2D only `G[5]`
    matters.
  - Total: `GW = v_A · d − v_B · d − (ω_B · (r × d))` — the scalar
    relative velocity of the particle w.r.t. the pulley application
    point, along d.
- **`relativeVelocity = targetSpeed`** (velocity bias). Positive = trim in.
- **`computeB(a, b, h, ws)`:** pure velocity constraint, mirrors
  `RotationalVelocityEquation.computeB`: `B = -GW * b - h * GiMf`. No
  `-a * Gq` term — there's no position target.
- **Impulse clamp:** `minForce = 0`, `maxForce = maxPull` (trim-only, so
  a taut rope the user isn't actively cranking never gets reverse-driven);
  motor disabled (`enabled = false`) when `maxForce = 0`.
- Uses base-class `computeGW` / `computeGiMf` / `computeGiMGt` /
  `addToWlambda` — vanilla 2-body equation, no body-count gymnastics.

### Constraint wrapper

A minimal `WinchMotorConstraint` subclass holding the single equation,
needed because `World.solve` flattens out of `world.constraints`, not out
of bare equations. API:

- `constructor(tailParticle, pulleyBody, localAnchor: V3d)`
- `setTailDirection(localDir: V3d)` — stores hull-local direction, used
  by `update()`.
- `setMotor(targetSpeed: number, maxForce: number)` — updates
  equation's `relativeVelocity` and `maxForce`; toggles `enabled`.
- `setTailParticle(particle)` — swaps `bodyA`, mirroring
  `PulleyConstraint3D.setParticleA`. Called when the pulley's tail index
  shifts.
- `update()` — recomputes world-space `d` and lever arm `r`, writes
  Jacobian entries into `equation.G`. Called every substep.

### Pulley integration

- New private field `motorConstraint: WinchMotorConstraint` alongside the
  existing `constraint: PulleyConstraint3D`.
- Created in constructor with the same `localAnchor` the pulley uses.
- Pushed into `this.constraints = [this.constraint, this.motorConstraint]`
  so the game engine registers both in `world.constraints`.
- `applyForce` deleted. Replaced by:
  - `setMotor(targetSpeed, maxForce)` — passthrough.
  - `setTailDirection(localDir)` — passthrough (called once, not per tick).
- `shiftBy(delta)`: after shifting `indexA`, call
  `this.motorConstraint.setTailParticle(this.particles[this.indexA + 2])`.
- `setWorkingLength`: same tail-particle refresh after changing `indexA`.

### Sheet integration

- Once at construction: `winch.setTailDirection(config.tailDirection)`.
- Per tick, replace `winch.applyForce(forceMag, aftX, aftY, maxSpeed)`
  with `winch.setMotor(trimSign * maxSpeed, forceMag)` where `trimSign`
  is `1` while trimming, `0` otherwise.

### Not doing (phase 1)

- No active-ease motor. Easing stays as today: switching the pulley out
  of ratchet mode + disabled motor. If driven ease is wanted later,
  extend to `minForce = -easeMax`.
- No changes to `PulleyConstraint3D`, ratchet logic, pulley friction, or
  `shiftIndex`. Motor is purely additive.
- No changes to `Rope`, `RopeParticle`, `RopeSegment`,
  `DistanceConstraint3D`, or `GSSolver`.

## Files to Modify

### New
- `src/core/physics/equations/WinchMotorEquation.ts` — 2-body
  velocity-target equation. Constructor: `bodyA` (particle), `bodyB`
  (pulley body), defaults `minForce = 0`, `maxForce = 0`,
  `relativeVelocity = 0`. `computeB` mirrors `RotationalVelocityEquation`
  exactly. Jacobian written by the wrapper's `update()`.
- `src/core/physics/constraints/WinchMotorConstraint.ts` — thin
  `Constraint` subclass. Holds the single equation, exposes `setMotor`,
  `setTailParticle`, `setTailDirection`. Implements `update()` to write
  `d` and `-(r × d)` into `equation.G`. Copy the `Constraint` subclass
  boilerplate shape from `RevoluteConstraint3D` or
  `DistanceConstraint3D`.

### Modified
- `src/game/rope/Pulley.ts`:
  - Add `motorConstraint` field; create in constructor; push to
    `this.constraints`.
  - Delete `applyForce`.
  - Add `setMotor(targetSpeed, maxForce)` and `setTailDirection(localDir)`
    passthroughs.
  - Update `shiftBy` and `setWorkingLength` to call
    `motorConstraint.setTailParticle` after the tail index changes.
- `src/game/boat/Sheet.ts`:
  - At construction: call `winch.setTailDirection(config.tailDirection)`.
  - Per tick: replace `applyForce` call with `setMotor(trimSign * maxSpeed,
    forceMag)`.
  - Confirm no other callers of `Pulley.applyForce` exist before deleting.
- `src/core/physics/CLAUDE.md`: one line under **Solver Pipeline** noting
  the new "velocity target + impulse clamp" motor pattern as the
  recommended way to model force-limited drivers (winches, etc.).

## Execution Order

### Sequential (has dependencies)

1. **Create `WinchMotorEquation.ts`.** Pure data + `computeB` override.
   Depends on nothing — can be typechecked standalone.
2. **Create `WinchMotorConstraint.ts`.** Depends on
   `WinchMotorEquation`. Implements `update()`, body-swap, and
   `setMotor`. After this, `npm run tsgo` should still pass with no
   callers yet.
3. **Modify `Pulley.ts`:** add motor constraint, delete `applyForce`,
   add new API methods, update shift/setWorkingLength paths. Typecheck
   will fail at this point because `Sheet.ts` still calls `applyForce`.
4. **Modify `Sheet.ts`:** switch to new API. Typecheck should pass
   again.
5. **Add line to `src/core/physics/CLAUDE.md`.** Documentation, no
   build impact.

### Parallel (no dependencies)

- Steps 1 and 2 are tightly coupled (2 imports 1), but once 1 is
  written, 2 can proceed while a separate pass reviews 1. In practice:
  write sequentially; it's fast.
- Doc update (step 5) can happen anytime after step 2.

## Verification

1. **Typecheck:** `npm run tsgo`.
2. **Smoke test (unloaded):** grab a boat, crank the mainsheet in with
   the rope unloaded. Rope should pull in at approximately `maxSpeed`,
   same feel as today. No over-tension, no oscillation.
3. **Stall test (loaded):** sail upwind at full breeze, sheet main all
   the way in. Rope should shorten until tension hits motor `maxForce`
   and then stop — no explosion, no stretch past rest length. Release
   input; motor disables, rope holds via ratchet.
4. **Hard-stall test:** anchor the boat to terrain via anchor rode, crank
   the winch against the immovable anchor. Rope reaches taut and motor
   stalls cleanly. Before this change, tapered-force behavior would
   over-drive into visible stretch; after, tension bounded by `maxForce`.
5. **Momentum conservation sanity check:** crank a sheet on a boat
   drifting in flat water with no wind. The boat should nudge forward
   (and yaw slightly if the pulley is offset from CoM) as rope is pulled
   in — confirming the equal-and-opposite reaction is being applied to
   the hull. If the boat doesn't move at all, the angular Jacobian term
   on `bodyB` is missing or wrong.
6. **Substep-correctness:** with substeps=8, temporarily log
   `motorConstraint.equations[0].multiplier`; it should respond within
   a single tick to abrupt load changes mid-crank.
7. **Regression spot-check:** jib trim, anchor rode payout, boom swing
   under gust all behave the same as before when the winch is idle
   (motor disabled, no equation contribution). Confirms additive nature.

## Open Questions

None. Phase 1 scope is trim-only (`minForce = 0`), no active ease, no
changes to pulley/ratchet/friction. If driven ease is wanted later, the
extension is a negative `minForce` — straightforward follow-up.
