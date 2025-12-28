# Sailing Physics Improvement Suggestions

This document catalogs potential improvements to the sailing physics simulation, organized by system and priority. Each suggestion includes the current implementation, proposed improvement, and relevant file locations.

---

## 1. Wind System

### Current Implementation

- Uniform wind field: same velocity everywhere (`Wind.ts:6-16`)
- No temporal variation (gusts)
- No spatial variation (wind shadows, local effects)

### Suggestions

#### 1.1 Wind Gusts

Add realistic temporal wind variation with gusts and lulls.

```
- Random gust events with smooth ramp-up/down
- Perlin noise for continuous small variations (±10-20%)
- Optional "puff" system for tactical racing
```

**Impact:** More engaging gameplay; requires anticipation and reaction

#### 1.2 Wind Gradient (Height Effect)

Wind speed increases with height above water due to boundary layer effects. Currently all sail nodes experience the same wind.

```
- Apply wind gradient factor based on sail node height
- Typically: V(h) = V_ref * (h/h_ref)^α where α ≈ 0.1-0.15 for water
- Affects sail twist optimization
```

**Location:** `Sail.ts:93-94` - modify `getFluidVelocity` to account for height

#### 1.3 Wind Shadow

Sails create a wind shadow (turbulent, reduced-velocity zone) downwind. Currently no inter-body wind interaction.

```
- Track wind shadow cones behind sails
- Reduce effective wind speed for objects in shadow
- Important for multi-boat racing or multi-sail rigs
```

**Impact:** Critical for racing tactics (covering opponents, dirty air)

#### 1.4 Apparent Wind Display

Add HUD showing true wind vs. apparent wind vectors for player feedback.

```
- Calculate apparent wind: wind_velocity - boat_velocity
- Display as vector indicator on screen
- Show both angle and speed
```

**Location:** New HUD entity; references `Wind.ts`, `Boat.ts:72-74`

---

## 2. Sail Aerodynamics

### Current Implementation

- Particle-chain sail with 32 nodes (`Sail.ts:13`)
- Thin airfoil theory: Cl = 2π·sin(α) (`sail-helpers.ts:39`)
- Stall at 15° with exponential decay (`sail-helpers.ts:41-43`)
- Camber affects lift but `CAMBER_LIFT_FACTOR = 0.0` (disabled) (`sail-helpers.ts:85`)

### Suggestions

#### 2.1 Enable and Tune Camber Effect

Camber calculation exists but has zero effect. Real sails generate more lift with proper draft.

```
Current: CAMBER_LIFT_FACTOR = 0.0
Suggested: CAMBER_LIFT_FACTOR = 1.5-3.0

- Positive camber (leeward billow) increases Cl
- Excessive camber increases drag
- Add camber-induced drag term
```

**Location:** `sail-helpers.ts:85`

#### 2.2 Sail Twist

Real sails have twist (different angles at top vs. bottom) to match the wind gradient. The current flat triangular compensation (`Sail.ts:116`) doesn't model this.

```
- Calculate optimal twist based on wind gradient
- Allow dynamic twist from sheet tension
- Top of sail can be at different angle than bottom
```

#### 2.3 Improved Stall Model

Current stall is a hard threshold with exponential decay. Real stall is more gradual and has hysteresis.

```
- Add stall hysteresis (stalls at 15°, recovers at 12°)
- Model partial stall (gradual lift loss from 12-18°)
- Add flow reattachment delay after stall
```

**Location:** `sail-helpers.ts:38-44`

#### 2.5 Jib / Genoa / Multiple Sails

Currently single mainsail only. Adding a headsail would significantly improve upwind performance and realism.

```
- Jib interacts with mainsail (slot effect)
- Genoa overlap changes aerodynamics
- Headsail sheets with separate controls
```

---

## 3. Hull Hydrodynamics

### Current Implementation

- Simple flat plate model for all hull edges (`Hull.ts:66-68`)
- Same lift/drag scale (0.15) for all edges
- No distinction between bow, stern, or sides

### Suggestions

#### 3.1 Form Drag vs. Skin Friction

Hull resistance has two components currently lumped together:

```
- Form drag: pressure difference bow-to-stern (dominant at high speed)
- Skin friction: viscous drag on wetted surface (dominant at low speed)

Model: C_total = C_form + C_friction/Re^0.5
```

#### 3.2 Wave-Making Resistance

At higher speeds, hulls create waves that consume energy. This is the primary speed limiter for displacement hulls.

```
- Add wave drag component above critical Froude number
- Froude number: Fr = V / sqrt(g * L)
- Hull speed limit occurs around Fr ≈ 0.4
```

**Impact:** Prevents unrealistic high speeds; creates proper "hull speed" limit

#### 3.3 Directional Hull Resistance

The bow should slice through water more efficiently than the beam.

```
Current: All edges use same flat plate coefficients
Suggested:
- Bow edges: lower drag coefficient (streamlined entry)
- Beam edges: higher lateral resistance
- Stern edges: moderate (transom vs. canoe stern)
```

**Location:** `Hull.ts:63-68` - use different coefficients per edge region

#### 3.4 Leeway Tracking

Boats slip sideways (leeway) when sailing upwind. Currently this happens naturally but isn't tracked or displayed.

```
- Calculate leeway angle: arctan(lateral_velocity / forward_velocity)
- Display on HUD for player awareness
- Affects VMG calculations
```

---

## 4. Keel and Rudder (Foil Physics)

### Current Implementation

- Symmetric NACA-style foil model (`fluid-dynamics.ts:191-215`)
- Thin airfoil theory with 15° stall angle
- Keel: scale 1.5, spans ±15 units (`Keel.ts:13-14`)
- Rudder: scale 2.0, 18 units long (`Rudder.ts:14-15`)

### Suggestions

#### 4.1 Aspect Ratio Effects

Lift curve slope depends on aspect ratio. Current implementation uses infinite-AR theory (2π).

```
Real slope: dCl/dα = 2π * AR / (AR + 2)

For typical keel AR ≈ 3: slope ≈ 3.77 (vs. 6.28 for 2π)
For typical rudder AR ≈ 2: slope ≈ 3.14
```

**Location:** `fluid-dynamics.ts:202` - adjust 2π based on aspect ratio

#### 4.2 Tip Vortex Losses (Induced Drag)

Current induced drag is simplified (`0.15 * α²`). Real induced drag depends on lift and aspect ratio.

```
C_Di = Cl² / (π * AR * e)
where e ≈ 0.9 (span efficiency)
```

**Location:** `fluid-dynamics.ts:233`

#### 4.3 Ventilation and Cavitation

At high speeds or extreme angles, foils can ventilate (air drawn down) or cavitate (vapor bubbles form).

```
- Ventilation: sudden lift loss when air reaches foil
- Cavitation: occurs above critical speed
- Both cause dramatic loss of lateral resistance
```

**Impact:** Explains why boats "spin out" when pushed too hard

#### 4.4 Rudder Stall Warning

When the rudder stalls (>15°), steering authority is lost. Players should be warned.

```
- Track rudder angle of attack (boat drift + steer angle)
- Visual/audio warning near stall
- Force reduction when stalled
```

#### 4.5 Keel Position Effects

Keel position affects balance. Currently centered. Moving it affects helm balance.

```
- Forward keel: lee helm (boat wants to fall off)
- Aft keel: weather helm (boat wants to head up)
- Balance point affects required rudder angle
```

---

## 5. Missing Physical Phenomena

### 5.1 Heeling (No Current Implementation)

Real boats heel (lean) when sailing. This is a 2D simulation, but heeling affects:

```
- Effective sail area (projected area decreases)
- Hull shape in water (asymmetric)
- Righting moment from keel weight
- Crew hiking (weight to windward)
```

**Options:**

- Track heel angle as a variable affecting forces
- Reduce sail force effectiveness at high heel
- Add heel indicator to HUD

### 5.2 Pitching Moment

Sail forces are applied above the center of lateral resistance, creating forward pitch.

```
- Bow digs in during gusts
- Affects wetted surface area
- Extreme case: pitchpole (bow buries, stern lifts)
```

### 5.3 Wave Interaction

Currently no wave physics (`Water.ts` is visual only).

```
Suggestions:
- Add simple sinusoidal wave field
- Waves affect boat motion (heave, pitch, roll)
- Surfing: boat accelerates going downhill
- Hobby-horsing: resonance with wave frequency
```

### 5.4 Water Current

Currently commented as "not implemented" (`WaterParticles.ts:69`).

```
- Add current vector field (like wind but for water)
- Affects all hydrodynamic calculations
- Tidal effects for coastal sailing
```

**Location:** The infrastructure for `getFluidVelocity` already exists (`fluid-dynamics.ts:31,61`)

---

## 6. Rigging and Controls

### Current Implementation

- Boom pivots freely on mast (`Rig.ts:52-56`)
- Mainsheet controls boom angle indirectly via distance constraint (`Mainsheet.ts:43-54`)
- No vang, no cunningham, no outhaul

### Suggestions

#### 6.1 Boom Vang

Prevents boom from rising when eased, controlling leech tension.

```
- Add downward constraint from boom to deck
- Affects sail twist and shape
- Tighter vang = less twist = better upwind
```

#### 6.2 Traveler

Allows centering boom without sheeting too tight.

```
- Mainsheet attach point moves side-to-side
- Separates boom angle from sheet tension
- Critical for proper upwind sailing
```

#### 6.3 Jib Sheets

If headsail added, need proper lead positions.

```
- Lead position affects headsail shape
- Forward lead: fuller shape, more power
- Aft lead: flatter shape, better pointing
```

---

## 7. Numerical and Performance

### Current Implementation

- Physics runs at 120Hz (`Game.ts` tick rate)
- 32 sail particles each applying forces (`Sail.ts:13`)
- Custom Gauss-Seidel solver, 10 iterations

### Suggestions

#### 7.1 Force Smoothing / Filtering

High-frequency force fluctuations can cause jitter.

```
- Low-pass filter on calculated forces
- Temporal averaging over 2-3 frames
- Clamp maximum force change per tick
```

**Location:** `fluid-dynamics.ts:144` before applying force

#### 7.2 Adaptive Time Stepping

Fixed 120Hz may be overkill for calm conditions, insufficient for extreme maneuvers.

```
- Monitor constraint violation / energy error
- Reduce timestep when needed
- Increase when stable
```

#### 7.3 Wake / Propeller Wash

Visual wake exists but has no physical effect.

```
- Trailing wake affects boats behind
- Propeller wash (if motoring added) affects rudder
```

---

## 8. Gameplay and Feedback

### 8.1 Telltales

Visual indicators on sails showing airflow.

```
- Small streamers at luff (front edge)
- Windward telltale: air flow over top
- Leeward telltale: air flow over bottom
- Both streaming: proper trim
```

**Impact:** Essential feedback for sail trim

### 8.2 Speed and VMG Display

Help players understand performance.

```
- Boat speed (knots)
- Velocity Made Good (toward destination)
- Target speed for current angle
- Polar diagram overlay
```

### 8.3 Sound Feedback

Audio cues for sailing state.

```
- Water rushing (speed-dependent)
- Wind in rigging (speed/angle dependent)
- Luffing sail (flapping when undertrimmed)
- Sheet load (creaking when loaded)
```

---

## Priority Recommendations

### High Priority (Significant realism improvement, moderate effort)

1. **Enable camber effect** - already implemented, just tune the constant
2. **Directional hull resistance** - straightforward, big impact on feel
3. **Apparent wind display** - essential player feedback
4. **Leeway tracking** - already happening, just needs display
5. **Wind gusts** - adds engagement, moderate implementation

### Medium Priority (Good improvement, more effort)

1. **Wave-making resistance** - prevents unrealistic speeds
2. **Aspect ratio effects on foils** - more accurate foil physics
3. **Rudder stall feedback** - important for player learning
4. **Sail backwinding** - completes the upwind sailing model
5. **Telltales** - visual feedback for trim

### Lower Priority (Nice to have, significant effort)

1. **Heeling simulation** - requires careful balancing
2. **Multiple sails (jib)** - major feature addition
3. **Wave physics** - complex system
4. **Wind shadows** - complex tracking
5. **Additional controls (vang, traveler)** - adds complexity

---

## Files Reference

| System              | Primary File                    | Line Numbers |
| ------------------- | ------------------------------- | ------------ |
| Wind                | `src/game/Wind.ts`              | 1-33         |
| Sail Forces         | `src/game/boat/Sail.ts`         | 89-128       |
| Sail Coefficients   | `src/game/boat/sail-helpers.ts` | 32-86        |
| Hull Forces         | `src/game/boat/Hull.ts`         | 63-68        |
| Fluid Dynamics Core | `src/game/fluid-dynamics.ts`    | 55-145       |
| Foil Model          | `src/game/fluid-dynamics.ts`    | 180-242      |
| Keel                | `src/game/boat/Keel.ts`         | 30-38        |
| Rudder              | `src/game/boat/Rudder.ts`       | 54-66        |
| Rigging             | `src/game/boat/Rig.ts`          | 38-59        |
| Mainsheet           | `src/game/boat/Mainsheet.ts`    | 43-80        |
| Water Particles     | `src/game/WaterParticles.ts`    | 30-49        |
