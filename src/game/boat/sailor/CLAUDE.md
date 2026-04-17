# Sailor & Station System (`src/game/boat/sailor/`)

The player controls a visible sailor character that walks between **stations** on the boat. Each station exposes a different subset of controls, so sailing the boat requires physically moving to the right position. This creates meaningful tradeoffs (you can't steer while walking to the bow to drop anchor).

## How it works

### Modal input

Controls are **modal**: when the sailor is at a station, WASD/QE operate that station's controls. When walking between stations, WASD moves the sailor and no sailing controls work. The rudder floats when unattended (no steering torque applied).

### Stations

Stations are defined per-boat in `BoatConfig.stations` (with `BoatConfig.initialStationId` naming the starting station). Each station maps input axes to boat controls:

- **steerAxis** (A/D) -- e.g. `"rudder"` at the Helm
- **primaryAxis** (W/S) -- e.g. `"mainsheet"` at Helm, `"mainHoist"` at Mast, `"jibHoistFurl"` at Bow
- **secondaryAxis** (Q/E) -- e.g. `"jibSheets"` at Helm
- **actions** -- discrete controls like `"anchor"`, `"mooring"`, `"bail"`

Default station layout (defined in Kestrel, inherited by all boats):

| Station | steerAxis | primaryAxis | secondaryAxis | actions |
|---------|-----------|-------------|---------------|---------|
| Helm    | rudder    | mainsheet   | jibSheets     | --      |
| Mast    | --        | mainHoist   | --            | bail    |
| Bow     | --        | jibHoistFurl | --           | anchor, mooring |

### Walking

- Press **F** at any station to leave and start walking. Unbound WASD keys do nothing at a station (e.g. A/D at the Mast, where only W/S is bound, have no effect — F is the only way to leave).
- WASD drives the sailor in hull-local coordinates: W = forward, S = backward, A = port, D = starboard.
- To enter a station, walk within `SAILOR_SNAP_RADIUS` of it and press **F**. The sailor does not auto-snap — entering is always an explicit action.

### Walking physics

The sailor is a `Particle` `DynamicBody` constrained to the deck via `DeckContactConstraint` with two extensions:

1. **`preventFallOff`** -- blocks the inside-to-outside state transition so the sailor can never leave the deck. When the sailor reaches the hull boundary, the constraint applies an inward wall force instead of transitioning to outside mode.

2. **Motorized friction** (`targetVelocityX`/`targetVelocityY`) -- the friction equations normally drive relative tangential velocity to zero. These fields set `relativeVelocity` on the friction equations so the solver drives toward the walk speed instead of zero. Walking is literally "set the friction setpoint."

The sailor's mass (`SAILOR_MASS` in `Sailor.ts`) affects boat balance through the deck constraint's reaction forces -- the same mechanism that lets ropes on deck transfer load to the hull.

## Files

- **`StationConfig.ts`** -- `StationDef`, `AxisControl`, `ActionControl` types
- **`Sailor.ts`** -- entity with physics body, deck constraint, state machine (`atStation` | `walking`), rendering (orange circle). Also exports `SAILOR_MASS`, `SAILOR_WALK_SPEED`, `SAILOR_RUN_SPEED`, `SAILOR_SNAP_RADIUS` constants (not boat-dependent).
- **`StationHUD.tsx`** -- ReactEntity HUD showing current station name, key bindings, and walking indicator

## Integration points

- **`BoatConfig.stations`** / **`BoatConfig.initialStationId`** -- required fields on every boat config. The boat defines where stations are and what each controls; per-sailor constants (mass, walk/run speed, snap radius) live in `Sailor.ts`.
- **`Boat.sailor`** -- the `Sailor` entity, always constructed. Added as a child of `Boat` after `BoatRenderer` for correct draw ordering.
- **`PlayerBoatController`** -- reads `boat.sailor.getCurrentStation()` to gate input. Two modes: walking (WASD drives sailor, boat controls inert) and at-station (dispatches to bound controls).
- **`DeckContactConstraint`** (`src/core/physics/constraints/`) -- the base constraint used by ropes, extended with `preventFallOff` and `targetVelocityX/Y` for the sailor.
- **`GameController`** -- adds `StationHUD` alongside other HUDs on game start.
- **`SaveFile.boat.sailor`** -- persists `stationId` and hull-local `position`. Save version 3.
- **`configScale.ts`** -- scales station positions with hull geometry (`sx`, `sy`).
- **`CustomEvent.ts`** -- `sailorEnteredStation` and `sailorLeftStation` events.
