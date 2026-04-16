# Rope Wrap Constraint for Hull Crossings

## Context

The rope in Tack & Trim can end up with adjacent particles on opposite sides of the boat's infinitely-thin hull wall — typically because the boat moves and sweeps its hull past a stationary particle. When that happens, the straight-line chain distance constraint between those particles "cuts the corner" through the wall: the chord is shorter than the over-the-edge path, the distance constraint sees slack that isn't really there, and no tension transmits. Result: the rope visually droops through the hull and can't be retrieved by pulling on it.

We want to add a 3-body "wrap" constraint that models the rope wrapping around the hull edge at the crossing point, so tension transmits correctly along the real path. This doesn't replace the normal chain distance constraint — it's added alongside. The chord constraint enforces `|A − B| ≤ L`; the wrap enforces the strictly tighter `|A − peg| + |peg − B| ≤ L` only while a straddle is detected. When there's no straddle, the wrap is disabled and the chord constraint does its normal job alone.

Scope of this pass: particle-to-particle chain links only (i.e. `RopeSegment`). Endpoint chain links (`PointToRigidDistanceConstraint3D` from a particle to a hull-fixed anchor) can straddle too but use a different 2-body shape — deferred as a follow-up.

## Approach

`PulleyConstraint3D` / `PulleyEquation` is structurally exactly what we need: upper-limit 3-body constraint enforcing `|A−C| + |C−B| ≤ L`, with a fully-specialized 18-component solver path (`iteratePulleyBatch` in `GSSolver.ts`). The only thing we need differently is that the "pulley anchor" (the peg) slides — it's recomputed each substep from the current chord's intersection with the hull, instead of being a fixed local point on bodyC.

So:
1. Extract the hull-geometry helpers currently private to `DeckContactConstraint` into a shared module, and add a chord-vs-hull-outline intersection routine.
2. Create a new `WrapConstraint3D` constraint class that owns a single `PulleyEquation` and recomputes the peg each `update()`.
3. Pre-create one `WrapConstraint3D` per `RopeSegment` when deck contact is configured, disabled by default. Toggle `.enabled` on its `PulleyEquation` each substep based on whether the two endpoints straddle the hull.

### Pre-create vs dynamic add/remove

**Recommendation: pre-create + toggle `.enabled`.** Rationale:
- Codebase precedent: `BaseEntity.constraints` is read exactly once when the entity is added (`Game.ts:331`); there is no post-add mutation path. Dynamic add/remove would require new plumbing in `ConstraintManager` and `BaseEntity`.
- `PulleyConstraint3D` itself uses this pattern — its sub-equations (`ratchetEquation`, `frictionEquation`) are always present and it flips `enabled` each `update()` (`PulleyConstraint3D.ts:321, 377, 402, 437`).
- The wrap constraint's `update()` runs cheaply when disabled (straddle check is a couple of `isInside()` reads).
- Memory cost is tiny: one `WrapConstraint3D` + one `PulleyEquation` per rope segment that has deck contact. For a 24-particle rope, that's 23 extra constraints.

## Files

### New: `src/core/physics/utils/HullBoundaryGeometry.ts`

Shared hull-outline geometry queries. Extract from `DeckContactConstraint.ts`:

- `pointInPolygon(level, px, py): boolean`
- `findNearestEdge(level, px, py): { edgeIndex, cx, cy, distSq }`
- `findLevelForZ(boundary, z): HullBoundaryLevel | null`

New routine for the wrap peg:

- `findChordHullCrossing(boundary, aLocal, bLocal): { px, py, pz } | null`
  - Picks the deck-level outline (topmost level) as the polygon to test against. That's the right surface for the common "rope draped over the gunwale" case and is stable against recomputation each substep.
  - Performs 2D line-segment-vs-polygon-edge intersection in hull-local XY: iterate edges, for each edge compute segment-segment intersection params `(t, u)`, accept if both ∈ [0,1].
  - If multiple edges cross, pick the one closest (by parameter `t`) to the outside particle — that's the edge the rope is wrapped around.
  - Returns `(px, py)` at the intersection plus `pz = boundary.deckHeight` (peg sits on the gunwale in hull-local coords).
  - Returns `null` if no crossing is found (treat as "no wrap this substep").

### Modified: `src/core/physics/constraints/DeckContactConstraint.ts`

- Export `HullBoundaryData` and `HullBoundaryLevel` (already exported).
- Replace the three private geometry methods with imports from `HullBoundaryGeometry`.
- No behavioral change.

### New: `src/core/physics/constraints/WrapConstraint3D.ts`

```ts
export class WrapConstraint3D extends Constraint {
  private sumEquation: PulleyEquation;
  private hullBody: Body;
  private hullBoundary: HullBoundaryData;
  private deckContactA: DeckContactConstraint;  // for isInside()
  private deckContactB: DeckContactConstraint;
  private totalLength: number;

  constructor(
    particleA: DynamicBody,
    particleB: DynamicBody,
    hullBody: Body,
    hullBoundary: HullBoundaryData,
    deckContactA: DeckContactConstraint,
    deckContactB: DeckContactConstraint,
    totalLength: number,
    options?: ConstraintOptions,
  ) { ... }

  update(): this {
    // 1. Straddle check
    if (this.deckContactA.isInside() === this.deckContactB.isInside()) {
      this.sumEquation.enabled = false;
      return this;
    }

    // 2. Compute peg in hull-local, then world
    const [laX, laY, laZ] = this.hullBody.toLocalFrame3D(pA...);
    const [lbX, lbY, lbZ] = this.hullBody.toLocalFrame3D(pB...);
    const peg = findChordHullCrossing(this.hullBoundary, [laX,laY,laZ], [lbX,lbY,lbZ]);
    if (!peg) { this.sumEquation.enabled = false; return this; }
    const [px, py, pz] = this.hullBody.toWorldFrame3D(peg.px, peg.py, peg.pz);

    // 3. Compute distA, distB, unit vectors, position (same math as PulleyConstraint3D.update())
    // 4. Enable equation only if position > totalLength
    // 5. Fill 18-element Jacobian via sumEquation.setJacobian(...)
    // 6. Lever arm for bodyC: peg minus hull center
  }
}
```

Key differences from `PulleyConstraint3D`:
- No `localAnchorC` — peg is computed each substep from `findChordHullCrossing`.
- No ratchet, no friction (first pass — can add later for rope-over-edge friction).
- Upper-limit-only: `sumEquation.maxForce = 0`, `minForce = -maxForce`.
- `totalLength` passed in at construction (= chain link length from `RopeSegment`).
- Guard `update()` early-outs: same-side → disable, no crossing found → disable.

### Modified: `src/game/rope/RopeSegment.ts`

- Add optional `wrapConfig?: { hullBody, hullBoundary, deckContactA, deckContactB }` to `RopeSegmentConfig`.
- When present, construct a `WrapConstraint3D` and push it onto `this.constraints` alongside the existing chain `ParticleDistanceConstraint3D`.
- Wrap constraint's solver order: same as the chain constraint on that segment (`config.solverOrder`) — or one slot higher so the solver sees the wrap after the chain.

### Modified: `src/game/rope/Rope.ts`

Two small changes (`Rope.ts:186-269`):

1. When building the particles loop, keep a parallel array of each particle's `DeckContactConstraint` (read off the `RopeParticle` — it's at `constraints[0]` when deck contact is configured, as seen at `RopeParticle.ts:86-96`). Alternatively, expose a `getDeckContact(): DeckContactConstraint | null` getter on `RopeParticle`.

2. When constructing each `RopeSegment`, if `config.deckContact` is present, pass a `wrapConfig` built from the hull body, hull boundary, and the two neighboring particles' deck-contact constraints.

## Known limitations (deferred)

- **Endpoint chain links don't wrap.** The A→P0 and P_{n-1}→B endpoint constraints use `PointToRigidDistanceConstraint3D` and can also straddle (e.g., cleat is inside, first particle is outside). Fixing this needs a 2-body wrap shape (particle + hull, with a hull-local anchor on one side and a sliding peg on the same body). Out of scope for this pass — note in code and revisit if it's a real problem in play.
- **Peg always uses deck-level outline.** If a rope physically crosses the hull side (say below the waterline), the peg snaps to the gunwale, which is geometrically wrong. For the intended use cases (rope draped over the edge), this is the right surface. Revisit only if we see misbehavior with submerged crossings.
- **No edge friction.** The peg slides frictionlessly along the gunwale. This is the right default; add capstan-style friction later if wrapping ropes feel too slippery.

## Files referenced

- `src/core/physics/equations/PulleyEquation.ts` — 18-component 3-body equation. Reused as-is.
- `src/core/physics/constraints/PulleyConstraint3D.ts` — template for `update()` logic (`:235-363` is the Jacobian fill pattern to copy, minus the ratchet/friction branches).
- `src/core/physics/constraints/DeckContactConstraint.ts:504-592` — geometry helpers to extract.
- `src/core/physics/constraints/DeckContactConstraint.ts:619-621` — `isInside()` public accessor.
- `src/game/rope/RopeSegment.ts:80-93` — where the chain constraint is built and where the wrap constraint will be added.
- `src/game/rope/RopeParticle.ts:130-135` — `isInside()` accessor, and `constraints[0]` is the `DeckContactConstraint` when configured.
- `src/game/rope/Rope.ts:251-269` — `RopeSegment` construction loop.
- `src/core/Game.ts:331-335` — confirms constraints are registered once at entity-add time.

## Verification

1. **Type check:** `npm run tsgo`.
2. **Unit repro (in-game):**
   - Start the game, grab a rope (e.g. main sheet or painter).
   - Drape it over the gunwale so half hangs outside, half lies on deck. Confirm the rope doesn't visually clip through the hull.
   - Pull the inside end. The outside particles should feel tension and drag up over the gunwale instead of hanging dead.
   - Steer the boat hard so the hull sweeps past a dropped rope. The rope should lift up onto the deck (or be pulled across) rather than threading itself through the hull.
3. **Stability:** Watch for instability at the moment a new wrap activates — the first substep sees a potentially large `position - totalLength`. If the rope jumps, soften `sumEquation.relaxation`/`stiffness` to match the chain constraint's values and/or clamp the initial `computeGq` to a max fraction of `totalLength`.
4. **No regression on single-side ropes:** confirm a rope that stays entirely inside (or entirely outside) the hull behaves identically — wrap constraints should stay disabled and cost nothing beyond the straddle check.
5. **E2E:** run `npm test` to confirm existing rope tests still pass.
