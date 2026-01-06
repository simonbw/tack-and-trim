# Sailing Glossary

A guide to sailing terminology used in this codebase. Whether you're new to sailing or just want to understand the game mechanics better, this glossary will help you navigate the code and concepts.

## Boat Parts

### Hull
The main body of the boat that floats on the water. In this game, the hull is the central physics body to which all other components attach. See `src/game/boat/Hull.ts`.

### Mast
The vertical pole that holds up the sails. The mast is positioned on the hull and serves as the attachment point for both the mainsail and jib. See `src/game/boat/Rig.ts`.

### Boom
A horizontal pole attached to the mast that holds the bottom edge (foot) of the mainsail. The boom swings from side to side as the sail is adjusted. Controlled by the mainsheet. See `src/game/boat/Rig.ts`.

### Keel
A fin-shaped underwater appendage extending below the hull. The keel serves two purposes:
1. **Lateral resistance** - Prevents the boat from sliding sideways when wind pushes on the sails
2. **Stability** - Adds weight low in the water to keep the boat upright

The keel generates hydrodynamic lift perpendicular to the boat's motion, counteracting the sideways force from the sails. See `src/game/boat/Keel.ts`.

### Rudder
A movable underwater fin at the back (stern) of the boat used for steering. Turning the rudder creates hydrodynamic lift that rotates the boat. See `src/game/boat/Rudder.ts`.

### Tiller
A lever attached to the rudder used to steer. Push the tiller left to turn the boat right, and vice versa. (Note: In this game, steering controls are simplified so this inversion isn't simulated.)

### Bow
The front of the boat. In the code, the bow is in the positive X direction (when the boat faces right).

### Stern
The back of the boat. Where the rudder is mounted.

## Sails

### Mainsail (Main)
The primary sail, attached to both the mast and boom. It's the larger of the two sails and provides most of the driving force. Controlled by the mainsheet. See `src/game/boat/Sail.ts` and `Rig.ts`.

### Jib
A triangular sail at the front of the boat, attached to the mast (at the head) and near the bow (at the tack). The jib helps balance the boat and can increase efficiency by creating a "slot effect" that accelerates air over the mainsail. Controlled by the jib sheets. See `src/game/boat/Boat.ts`.

### Spinnaker
A large, balloon-shaped sail used when sailing downwind. (Not currently implemented in this game, but a common sailing term.)

## Parts of a Sail

### Head
The top corner of a sail, attached to the mast or halyard. In the code: `getHead()`, `getHeadPosition()`.

### Tack
The bottom-front corner of a sail. For the jib, this is near the bow. (Note: "Tack" is also a verb meaning to turn the bow through the wind - see Maneuvers section.)

### Clew
The bottom-back corner of a sail where the sheet attaches. This is the corner you pull to trim the sail. In the code: `getClew()`, `getClewPosition()`.

### Luff
The leading edge of a sail (front edge, facing the wind). When a sail is undertrimmed, it will "luff" - flutter or flap because air is flowing over both sides instead of generating lift.

### Leech
The trailing edge of a sail (back edge). The shape of the leech affects how air exits the sail.

### Foot
The bottom edge of a sail, running from tack to clew.

### Chord
An imaginary straight line from the head to the clew of a sail. Used in aerodynamic calculations.

### Camber
The curved shape of a sail when filled with wind. More camber generally means more power but also more drag. The code calculates camber to determine lift and drag forces. See `calculateCamber()` in `sail-helpers.ts`.

## Lines (Ropes)

In sailing, ropes are generally called "lines" once they have a specific purpose.

### Sheet
A line used to control the angle of a sail. Pulling in (trimming) a sheet brings the sail closer to the centerline; letting out (easing) allows it to move away.

- **Mainsheet** - Controls the boom/mainsail angle. See `src/game/boat/Sheet.ts`.
- **Jib Sheet** - Controls the jib. There are two jib sheets (port and starboard), but only one is "active" at a time depending on which side the wind is coming from.

### Trim (verb)
To pull in a sheet, bringing the sail closer to the boat's centerline. In the game: W trims the mainsheet, Q/E trim the jib sheets.

### Ease (verb)
To let out a sheet, allowing the sail to move away from the boat's centerline. The opposite of trimming.

### Rode
The line (rope or chain) connecting the anchor to the boat. See `src/game/boat/Anchor.ts`.

### Halyard
A line used to raise or lower a sail. (Referenced conceptually in sail hoisting mechanics.)

## Wind Terms

### True Wind
The actual wind as it would be measured by a stationary observer. Set by the game's wind system.

### Apparent Wind
The wind as experienced on the moving boat. This is the combination of true wind and the wind created by the boat's own motion. A boat sailing forward creates a headwind, so apparent wind is always shifted forward compared to true wind. Faster boats experience more forward-shifted apparent wind.

This is a crucial concept - the sails interact with apparent wind, not true wind. See `fluid-dynamics.ts`.

### Windward
The direction from which the wind is coming. Also called "upwind." The windward side of the boat is the side the wind hits first.

### Leeward
(Pronounced "LOO-erd") The direction the wind is blowing toward. Also called "downwind." The leeward side of the boat is sheltered from the wind.

### Upwind
Sailing toward the wind source. Boats cannot sail directly into the wind (see "No-Go Zone"), so upwind sailing requires zig-zagging (tacking).

### Downwind
Sailing away from the wind source. With the wind behind you.

### Point of Sail
The angle between the boat's heading and the wind direction. Different points of sail require different sail trim.

## Points of Sail

These are the different angles at which a boat can sail relative to the wind:

### Close-Hauled
Sailing as close to the wind as efficiently possible, typically about 30-45 degrees off the wind. Sails are trimmed in tight. This is the fastest point of sail for getting upwind.

### Close Reach
Sailing with the wind forward of the beam (side) but not as close as close-hauled. A comfortable, fast point of sail.

### Beam Reach
Sailing with the wind coming directly from the side (90 degrees to the boat). Often the fastest point of sail.

### Broad Reach
Sailing with the wind coming from behind and to the side. Sails are eased well out.

### Running
Sailing directly downwind, with the wind coming from behind. Sails are eased all the way out. Can be unstable.

### No-Go Zone (In Irons)
The area directly into the wind (roughly 30-45 degrees on either side of the wind direction) where a boat cannot sail. If you point too close to the wind, the sails will luff and you'll lose power. Getting stuck here is called being "in irons."

## Maneuvers

### Tacking
Turning the bow (front) of the boat through the wind to change which side the wind is coming from. During a tack:
1. The boat turns toward the wind
2. The bow passes through the no-go zone
3. The sails flip to the other side
4. The boat is now on the opposite tack

In the game, when tacking you need to release the jib sheet on one side and trim in the other. See `tackJib()` in `Boat.ts`.

### Jibing (Gybing)
Turning the stern (back) of the boat through the wind. The opposite of tacking. In real sailing, jibing can be dangerous because the boom swings across forcefully when the wind catches the other side of the sail.

### Port Tack
When the wind is coming from the port (left) side of the boat. The boom will be on the starboard (right) side.

### Starboard Tack
When the wind is coming from the starboard (right) side of the boat. The boom will be on the port (left) side.

### Bearing Away
Turning the boat away from the wind (more downwind). Also called "bearing off" or "heading down."

### Heading Up
Turning the boat toward the wind (more upwind). Also called "pointing up" or "coming up."

### Luffing
When a sail flutters because it's not properly filled with wind, usually because the boat is pointing too close to the wind or the sail is too loose.

## Aerodynamics & Physics

### Lift
The force generated perpendicular to the airflow over a sail. This is the primary driving force - it pulls the boat forward and sideways. The keel counteracts the sideways component.

### Drag
The force generated parallel to (in the direction of) airflow. Drag opposes motion and is generally undesirable, though some drag is inevitable.

### Angle of Attack
The angle between the sail (or foil) and the apparent wind. Too little angle = no power. Too much angle = stall. See `angleOfAttack` calculations in the physics code.

### Stall
When the angle of attack is too high, airflow separates from the sail surface, causing a sudden loss of lift and increase in drag. Like an airplane wing stalling. The game simulates this with `STALL_ANGLE`. See `isSailStalled()` in `sail-helpers.ts`.

### Slot Effect
The gap between the jib and mainsail accelerates airflow, increasing the effectiveness of the mainsail. This is why a jib can increase overall performance even though it's a small sail. Simulated in `SailWindEffect.ts`.

### Circulation
In aerodynamics, the circular flow of air around a lifting surface. The game uses circulation calculations to model how sails affect the wind field around them. See `SailWindEffect.ts`.

## Visual Aids

### Telltale (Telltail)
Small strips of fabric or yarn attached to sails that show airflow direction. If both telltales stream backward evenly, the sail is trimmed correctly. If one flutters, the sail needs adjustment. The game renders these on the sails. See `src/game/boat/TellTail.ts`.

### Buoy
A floating marker in the water, often used to mark race courses or navigation channels. See `src/game/Buoy.ts`.

### Wake
The trail of disturbed water left behind a moving boat. Rendered in `src/game/boat/Wake.ts`.

## Directions

### Port
The left side of the boat when facing forward. Traditionally marked with red.

### Starboard
The right side of the boat when facing forward. Traditionally marked with green.

### Fore / Forward
Toward the front (bow) of the boat.

### Aft
Toward the back (stern) of the boat.

## Actions

### Row
Propelling the boat using oars. In the game, the Space key provides a rowing force for when there's no wind.

### Anchor
A heavy object dropped to the bottom to keep the boat in place. The game implements anchor deployment and retrieval. See `src/game/boat/Anchor.ts`.

### Hoist
To raise a sail.

### Lower / Drop
To take down a sail.

---

## Quick Reference: Game Controls

| Key | Action | Sailing Term |
|-----|--------|--------------|
| A/D | Steer left/right | Helm / Rudder control |
| W | Trim mainsheet | Sheeting in |
| S | Ease mainsheet | Sheeting out |
| Q/E | Adjust jib sheet | Jib trim |
| R | Toggle sails | Hoist/Lower |
| F | Toggle anchor | Deploy/Retrieve anchor |
| Space | Row | Manual propulsion |
| Shift | Fast adjustment | - |

---

## Further Reading

If you want to learn more about sailing:
- The physics of sailing involve fascinating fluid dynamics
- Real sailing adds many more considerations: weather, tides, currents, right-of-way rules, and crew coordination
- Racing sailing introduces tactics and strategy around mark rounding and fleet positioning

This game focuses on the core physics of sail trim and boat handling - the fundamental skills every sailor learns first.
