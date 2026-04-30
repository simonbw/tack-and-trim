# Sailor & Station System (`src/game/boat/sailor/`)

The player controls a visible sailor character that occupies one of several **stations** on the boat. Each station exposes a different subset of controls, so sailing the boat requires moving to the right position. The player is always at a station; **Z** and **X** cycle to the previous/next station and the sailor auto-walks the deck between them. The walk takes time, which preserves the meaningful tradeoff (you can't steer while moving to the bow to drop the anchor) without forcing the player to drive the walk by hand.

## How it works

### Stations

Stations are defined per-boat in `BoatConfig.stations` (an ordered array; `BoatConfig.initialStationId` names the starting station). Each station maps input axes to boat controls:

- **steerAxis** (A/D) -- e.g. `"rudder"` at the Helm
- **primaryAxis** (W/S) -- e.g. `"mainsheet"` at Helm, `"mainHoist"` at Mast, `"jibHoistFurl"` at Bow
- **secondaryAxis** (Q/E) -- e.g. `"jibSheets"` at Helm
- **actions** -- discrete controls like `"anchor"`, `"mooring"`, `"bail"`

Default station layout (defined in `BaseBoat`, inherited by all boats):

| Station | steerAxis | primaryAxis  | secondaryAxis | actions         |
| ------- | --------- | ------------ | ------------- | --------------- |
| Helm    | rudder    | mainsheet    | jibSheets     | --              |
| Mast    | --        | mainHoist    | --            | bail            |
| Bow     | --        | jibHoistFurl | --            | anchor, mooring |

### State machine

The sailor has two states:

- `atStation { stationId }` -- pinned to the station via a 3-axis position lock (`stationWeld`). Station controls are live.
- `transit { targetStationId }` -- walking toward the destination. Station controls are inert; the rudder floats and the anchor idles.

### Z / X cycling

- **Z** = previous station, **X** = next station, in the order defined by `BoatConfig.stations`.
- Clamped at the array ends (no wrap-around).
- Pressing Z/X mid-transit retargets without stopping — the sailor pivots toward the new destination.

### Auto-walk

In `transit`, the sailor's tick handler drives the deck's friction motor (`SailorDeckConstraint.targetVelocityX/Y`) straight toward the target station's hull-local position at `SAILOR_WALK_SPEED`. When the sailor crosses within `SAILOR_SNAP_RADIUS` of the target, `snapToStation()` re-enables the station weld (with a `beginWeldRamp()` slide to avoid an impulse) and the state flips back to `atStation`.

Path planning is straight-line. The deck is convex on current hulls so this is sufficient; if a future hull layout has obstructions between stations a per-config waypoint table would be the next step, but it is not currently needed.

### Deck physics

The sailor is a dynamic point-mass-3D body (`createPointMass3D({ motion: "dynamic", … })`) with a `Particle` shape, constrained to the deck via `SailorDeckConstraint` (a `DeckContactConstraint` extended for the sailor) with two extras:

1. **`preventFallOff`** -- blocks the inside-to-outside state transition so the sailor can never leave the deck. At the hull boundary the constraint applies an inward wall force instead of transitioning to outside mode.

2. **Motorized friction** (`targetVelocityX`/`targetVelocityY`) -- the friction equations normally drive relative tangential velocity to zero. These fields set `relativeVelocity` on the friction equations so the solver drives toward the walk velocity instead of zero. Walking is literally "set the friction setpoint."

The sailor's mass (`SAILOR_MASS` in `Sailor.ts`) affects boat balance through the deck constraint's reaction forces -- the same mechanism that lets ropes on deck transfer load to the hull. As the sailor walks fore/aft during transit, the hull pitches in response; this is preserved from the previous free-walk model.

## Files

- **`StationConfig.ts`** -- `StationDef`, `AxisControl`, `ActionControl` types
- **`Sailor.ts`** -- entity with physics body, deck constraint, state machine (`atStation` | `transit`), rendering (orange circle). Also exports `SAILOR_MASS`, `SAILOR_WALK_SPEED`, `SAILOR_SNAP_RADIUS` constants (not boat-dependent).
- **`StationHUD.tsx`** -- ReactEntity HUD showing current station name (or transit destination), key bindings, and Z/X cycle hints

## Integration points

- **`BoatConfig.stations`** / **`BoatConfig.initialStationId`** -- required fields on every boat config. The boat defines where stations are and what each controls; per-sailor constants (mass, walk speed, snap radius) live in `Sailor.ts`.
- **`Boat.sailor`** -- the `Sailor` entity, always constructed. Added as a child of `Boat` after `BoatRenderer` for correct draw ordering.
- **`PlayerBoatController`** -- handles `KeyZ`/`KeyX` → `sailor.goToNeighborStation(±1)`. Each tick, when the sailor is not at a station, releases the rudder and idles the anchor; otherwise dispatches to the bound controls.
- **`DeckContactConstraint`** (`src/core/physics/constraints/`) -- base constraint used by ropes; the sailor uses the `SailorDeckConstraint` subclass with `preventFallOff` and the friction motor.
- **`GameController`** -- adds `StationHUD` alongside other HUDs on game start.
- **`SaveFile.boat.sailor`** -- persists `stationId` only. Save version 4. Mid-transit saves persist the target as the station id (sailor effectively snaps to the destination on reload).
- **`configScale.ts`** -- scales station positions with hull geometry (`sx`, `sy`).
- **`CustomEvent.ts`** -- `sailorEnteredStation` (fired on snap) and `sailorLeftStation` (fired when transit begins).
