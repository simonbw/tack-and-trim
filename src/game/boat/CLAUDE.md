# Boat System (`src/game/boat/`)

Physics-based sailing simulation. The `Boat` entity is the parent; all components are child entities that apply forces to the shared hull body each tick.

## Coordinate Conventions

See the comment block at the top of `BoatConfig.ts`. Summary: +X forward, +Y starboard, +Z up, Z=0 at waterline. Units are feet, pounds, seconds, radians. Forces use engine units (lbf * 32.174; see `LBF_TO_ENGINE` in `physics-constants.ts`).

## Entity Structure

`Boat` owns and wires together:

- **Hull** -- main `DynamicBody`, collision shape, buoyancy, form drag, skin friction, gravity
- **Keel** -- lateral resistance hydrofoil (prevents sideslip), applies forces to hull body
- **Rudder** -- steering hydrofoil, has its own `DynamicBody` + `RevoluteConstraint` to hull
- **Rig** -- mast and boom, boom has its own body constrained to mast pivot
- **Sail** (mainsail, optional jib) -- cloth simulation with per-triangle wind forces
- **Sheet** (mainsheet, jib sheets) -- spring constraints controlling sail trim angle
- **Anchor** -- deployable ground anchor with rode
- **Bilge** -- water ingress, sloshing ballast, sinking
- **Wake** -- visual wake particles driven by hull energy dissipation
- **Bowsprit**, **Lifelines** -- visual-only deck fittings
- **BoatGrounding** -- terrain collision detection for keel/rudder/hull
- **HullDamage**, **RudderDamage**, **SailDamage** -- damage state tracking
- **BoatSoundGenerator** -- positional audio
- **PlayerBoatController** -- maps player input to steering, trim, rowing, anchoring

## 3D Tilt System (6DOF)

The hull body is a `DynamicBody` with 6DOF mode enabled (`SixDOFOptions`). In addition to the standard 2D position, velocity, angle, and angular velocity, it tracks:

- **z** / **zVelocity** -- vertical position and velocity (heave)
- **roll** / **rollVelocity** -- heel angle and rate (rotation about the longitudinal axis)
- **pitch** / **pitchVelocity** -- fore/aft tilt and rate (rotation about the lateral axis)

The body maintains a 3x3 rotation matrix (`orientation`) combining yaw (2D angle), roll, and pitch. Forces are applied via `body.applyForce3D(fx, fy, fz, localX, localY, localZ)`, which computes both linear force and 3D torque (including roll and pitch moments from the force's application point and direction).

Configuration lives in `BuoyancyConfig` (mass, inertia, center of gravity) and `TiltConfig` (damping, righting moment coefficients, z-heights for force application).

## Forces Acting on the Boat

### Gravity
Applied each tick at the center of gravity: `F_z = -mass * g` at `(0, 0, centerOfGravityZ)`.

### Buoyancy (Hull)
Per-triangle, applied at each triangle's centroid. Force is purely vertical (+Z):

```
F_buoy = rho_water * g^2 * depth * area * |wnz|
```

where `depth` is average vertex submersion, `area` is triangle area, and `|wnz|` is the absolute world-frame vertical component of the triangle's outward normal. The `|wnz|` weighting models how the effective waterplane area changes with heel -- flat bottom triangles contribute most when upright; side triangles contribute when heeled. This naturally produces righting moment without needing a closed pressure surface.

Submersion is computed per-vertex (via `WaterQuery` at mesh vertices) and averaged per triangle with a smooth waterline transition band to avoid force discontinuities.

### Form Drag (Hull)
Pressure-based drag computed per-triangle on the hull mesh. Two regimes:

- **Stagnation** (front-facing triangles, `v . n > 0`): `F = -n * Cp_stag * 0.5 * rho * v^2 * A_projected`. Pushes the surface inward, opposing the impinging flow.
- **Separation** (rear-facing triangles, `v . n < 0`): `F = +n * Cp_sep * 0.5 * rho * v^2 * A_projected`. Suction pulling the surface into the low-pressure wake.

The relative velocity includes the z-component from roll/pitch rotation (`pointZVelocity`), which is critical for roll damping -- when the boat heels, hull triangles push through water vertically.

Energy dissipated by form drag is accumulated in `HullDissipation` and read by `Wake` to modulate wake particle intensity.

### Skin Friction (Hull)
Viscous drag applied at each submerged triangle centroid via `computeSkinFrictionAtPoint()`. Proportional to wetted area, velocity squared, and the friction coefficient `Cf`. Includes 3D velocity (roll/pitch z-velocity) for vertical drag contribution. Scaled by hull damage.

### Wind Drag (Hull)
Above-water triangles experience aerodynamic form drag from wind, computed identically to water stagnation pressure but with `RHO_AIR`.

### Hydrofoil Forces (Keel, Rudder)
Both keel and rudder use the shared `computeHydrofoilForces()` function from `fluid-dynamics.ts`. This computes symmetric foil lift and drag on edge pairs:

- **Lift**: thin airfoil theory (`Cl = 2*pi*sin(alpha)`) with post-stall exponential decay
- **Drag**: base profile drag + induced drag from lifting-line theory (`Cd_i = Cl^2 / (pi * AR * e)`), transitioning to flat-plate Kirchhoff drag post-stall

The 3D decomposition tilts the lateral (lift) component by hull roll angle: `fz = lateral * sin(roll)`. This means the keel's lateral resistance produces a vertical righting force when heeled, which is the primary righting mechanism for a keelboat.

The keel applies forces to the hull body at its blade midpoint depth. The rudder has its own `DynamicBody` connected to the hull via `RevoluteConstraint`, with player input applied as torque.

### Sail Forces
Sails use cloth simulation (`ClothSolver`) with per-triangle aerodynamic forces computed in `sail-aerodynamics.ts`. Each triangle gets lift and drag from the relative wind (true wind minus cloth surface velocity), producing natural damping. Forces are applied as 3D vectors to the hull body at configurable z-heights (foot to head of sail).

## Hull Mesh

The hull is lofted from cross-section profiles at a series of stations along the hull length (like a naval architect's lines drawing). Each `HullStation` is a half-profile in the y-z plane from keel centerline to gunwale; port is auto-mirrored from starboard. `buildHullMeshFromProfiles()` (in `hull-profiles.ts`) resamples each profile, interpolates intermediate stations, mirrors to full cross-sections, and stitches adjacent rings into quad strips. Bow/stern stations can collapse to a point for fan triangulation, and the first station gets an ear-clipped transom cap.

Triangles are classified into `upperSideIndices` (above waterline), `lowerSideIndices` (below), and `bottomIndices` (downward-facing panels) so the buoyancy and drag loops can key on the classification. A deck cap polygon is triangulated from the gunwale trace. Triangle data (centroid, outward normal, area, vertex indices) is precomputed once at construction in `HullForceData` flat arrays for cache-friendly access.

Two meshes are built per hull: a coarse physics mesh (lower `profileSubdivisions` / `stationSubdivisions`) driving the force loop, and a full-resolution render mesh used by `BoatCompositor` for the visible hull surface.

Water and wind are queried at all physics-mesh vertices each frame via `WaterQuery` and `WindQuery`. Per-triangle values are averaged from the three vertex results.

## Configuration

All boat parameters are data-driven via `BoatConfig` (defined in `BoatConfig.ts`). Concrete configs live in `configs/` (e.g., `Kestrel.ts`, `Osprey.ts`, `Albatross.ts`). Use `createBoatConfig(base, overrides)` for partial customization via deep merge.

Key config sections: `hull` (mass, vertices, drag coefficients), `keel`/`rudder` (foil geometry), `rig` (mast/boom dimensions, sail configs), `buoyancy` (mass, inertia, CG height), `tilt` (damping, righting coefficients), `bilge` (flooding/sinking), `grounding` (terrain collision friction), and damage configs.
