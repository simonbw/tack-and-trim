# Sound Design Philosophy

This document describes the approach to sound in Tack & Trim. Rather than treating audio as a layer of feedback that sits on top of the game, our sound system should be a direct expression of the simulation itself -- another medium through which the physics become tangible.

## Core Principle: Sound as Simulation Output

The game already simulates fluid dynamics, aerodynamics, rigid body mechanics, and soft body cloth physics at 120Hz. Every one of these systems produces forces, velocities, pressures, and accelerations that have acoustic consequences in the real world. Our sound system should treat these simulation values as its primary inputs.

This means most sounds in the game should not be event-triggered clips ("the sail just luffed, play luff.wav"). Instead, they should be continuously synthesized or modulated from the underlying physics state. A sail doesn't make a "flapping sound" -- it produces noise because turbulent airflow is causing the cloth to oscillate, and the character of that noise depends on wind speed, angle of attack, flow attachment state, cloth tension, and proximity to stall. All of those values already exist in our simulation. The sound system's job is to translate them into audio.

This has several practical consequences:

1. **Sounds emerge from state, not events.** A continuous sound whose parameters are driven by simulation values will naturally start, stop, intensify, and change character as the physics change. There is no need to manually author transition logic.

2. **Sounds are never out of sync.** Because the audio parameters are computed from the same data that drives the visuals and physics, they cannot drift out of alignment. If the boat slows down, the water sounds slow down in the same frame.

3. **Sounds blend naturally.** Rather than crossfading between discrete clips for "light wind" and "heavy wind," a simulation-driven approach produces a continuous spectrum of sound that tracks the actual conditions smoothly.

4. **Sounds teach the player.** When audio is an honest representation of the physics, players learn to read the simulation by ear. They hear when the sail is about to stall, when the hull is starting to plane, when the anchor rode goes taut. This is not a gimmick -- real sailors rely heavily on sound.

## Implementation Approach

We will use the Web Audio API's synthesis and processing capabilities alongside sample playback. Many sounds will be built from layered noise sources, oscillators, and filters whose parameters are continuously updated from simulation state. Recorded samples will be used where synthesis falls short (impacts, mechanical sounds) but even those will have their gain, playback rate, and filtering driven by physics values rather than fixed.

The existing `SoundInstance` and `PositionalSound` classes give us sample playback with spatial positioning. We will build on this foundation with new primitives for continuous, parameter-driven sound sources.

All boat sounds should be positional, emanating from the appropriate part of the vessel. Wind and water ambience are an exception -- they surround the listener and represent the environment rather than a point source.

---

## Sound Inventory

What follows is a catalog of the sounds that matter for this game, organized by the system that produces them. For each one, we describe what it sounds like, what simulation values drive it, and how it connects to gameplay.

---

### 1. Wind

#### 1.1 Ambient Wind

**What it sounds like:** A continuous broadband rushing/whooshing. Low wind is a soft, low-frequency hum. As speed increases, the sound brightens and gains high-frequency content, becoming a whistle or roar in strong conditions.

**Simulation inputs:**
- `WindQuery` velocity at the listener position (speed and direction)
- Simplex noise variation in the wind field (gives natural gusting character)

**How to build it:** Filtered noise source. A white noise generator feeds a bandpass filter whose center frequency and bandwidth are mapped to wind speed. Gain tracks speed. The simplex noise variation in the wind naturally produces the swelling and fading of gusts without any additional modulation. Since the wind field already has spatial variation, sampling it at the listener position gives us authentic gust timing for free.

**Gameplay connection:** Players learn to hear wind speed changes before they see their effect on the boat. A gust arriving sounds like a crescendo of broadband noise, giving the player a moment to prepare (ease sheets, bear away) before the force hits the sails.

#### 1.2 Wind in Rigging

**What it sounds like:** Tonal whistling and humming from wind flowing over ropes, stays, and the mast. Higher wind speeds produce higher pitches and more harmonics. Multiple lines produce a chord-like effect.

**Simulation inputs:**
- Wind speed at the boat position
- Number and diameter of rigging elements (sheets, stays)

**How to build it:** Multiple sine oscillators with slight detuning, whose frequencies are derived from the Strouhal relationship: `f = St * V / d` where `St ≈ 0.2`, `V` is wind speed, and `d` is the line diameter. Each rigging element gets its own oscillator. Gain increases with wind speed. A small amount of frequency jitter from the wind's simplex variation gives the whistling an organic warble.

**Gameplay connection:** The pitch of the rigging whistle is a direct indicator of apparent wind speed. Players will unconsciously learn to associate pitch with conditions.

---

### 2. Sails

#### 2.1 Sail Luffing / Flapping

**What it sounds like:** Rapid, irregular flapping -- like a flag in wind. Ranges from a gentle flutter at the leading edge to violent snapping of the whole sail when fully depowered.

**Simulation inputs:**
- `SailFlowSimulator` flow state: `turbulence` amount per segment, `stallDistance` (how far back separation has traveled from the luff)
- Sail particle velocities (the soft body nodes that make up the cloth)
- Wind speed (determines energy available for flapping)
- Sail area (mainsail vs. jib -- larger sail, deeper sound)

**How to build it:** This is where the cloth simulation pays off acoustically. The sail particles are already oscillating when the flow separates -- their velocities contain the actual frequency content of the flapping. We can derive a flapping intensity signal from the variance of particle velocities along the sail. Layer this with filtered noise bursts whose amplitude envelope follows the particle motion. The `stallDistance` value controls how much of the sail is involved: a sail that's just starting to luff at the leading edge should sound different from one that's completely stalled and thrashing.

**Gameplay connection:** This is one of the most important sounds in the game. Luffing is the primary audio cue that the sail is not trimmed correctly. A good sailor constantly adjusts trim to keep the sail *just* on the edge of luffing -- the sound should make that edge palpable. The distinction between "luffing a little at the luff" and "whole sail flogging" tells the player how far off they are.

#### 2.2 Sail Under Load (Quiet Power)

**What it sounds like:** When a sail is properly trimmed and drawing, it is mostly quiet -- a taut, low hum of fabric under tension, maybe a faint creak from the attachment points. This quietness is itself meaningful.

**Simulation inputs:**
- Flow attachment state (fully attached = minimal turbulence)
- Sheet tension (the `Sheet` constraint length vs. its current extension)
- Sail loading force (the total aerodynamic force vector on the sail)
- Apparent wind speed (more wind = more tension = slightly louder hum)

**How to build it:** Very subtle. A low-amplitude, low-frequency filtered noise whose gain is proportional to sail loading force. Perhaps a very quiet tonal element that tracks sheet tension. The key is contrast -- this sound is defined by the absence of luffing. The transition from luffing to drawing should feel like the sail "locks in" acoustically.

**Gameplay connection:** Players should feel the satisfaction of a well-trimmed sail through its quiet authority. The absence of flapping and the presence of a subtle loaded hum confirms they've got it right.

#### 2.3 Sail Trim Adjustments

**What it sounds like:** The sound of rope running through hardware -- a rapid, ratcheting, fibrous sliding sound when sheeting in (pulling the line through a cleat or block), and a smoother easing sound when letting out.

**Simulation inputs:**
- `Sheet` trim speed and direction (pulling in vs. easing out, currently 15 ft/s)
- Sheet tension (higher tension = more friction sound)
- Whether the player is actively adjusting (W/S keys for main, Q/E for jib)

**How to build it:** Sample-based with modulation. A looping rope-through-block sample whose playback rate tracks trim speed and whose gain tracks sheet tension. Sheeting in under load should sound more strained than easing out. A brief transient when trimming starts and stops gives tactile feedback.

**Gameplay connection:** Audio feedback for control input. The sound confirms the player's action and the resistance they're working against. Heavy tension making the sheeting sound more labored tells the player the sail is loaded.

#### 2.4 Sail Hoist / Lower

**What it sounds like:** The rhythmic sound of a halyard running through a block as the sail goes up or comes down. Canvas rustling and gathering.

**Simulation inputs:**
- Sail hoist amount (0 to 1 animation value)
- Hoist direction (raising vs. lowering)
- Wind speed (a sail being lowered in strong wind makes more noise as it fights the wind)

**How to build it:** Looping halyard sample modulated by hoist speed. Layered with cloth rustling noise whose amplitude increases with wind speed during the operation. A satisfying "lock" transient when the sail reaches full hoist.

**Gameplay connection:** Confirms the player's hoist/lower action. In strong wind, the increased noise of lowering a sail communicates the urgency of the situation.

---

### 3. Hull and Water Interaction

#### 3.1 Hull Moving Through Water

**What it sounds like:** The continuous sound of a hull displacing water. At low speeds, a soft lapping and gurgling. At moderate speeds, a sustained rushing/hissing. At high speeds (planing), a louder, higher-pitched roar with spray.

**Simulation inputs:**
- Hull velocity magnitude (boat speed through water, accounting for current via `WaterQuery`)
- Hull velocity relative to water surface velocity (the *actual* flow speed past the hull)
- Wake spawn rate (from `Wake.ts` -- already computed based on speed threshold)
- Skin friction force magnitude (from `Hull.ts` -- `F = 0.5 * ρ * v² * Cf * A`)

**How to build it:** Layered continuous noise sources. A low-frequency component (hull resonance / displacement wave) whose gain rises first at low speeds. A mid-frequency component (turbulent boundary layer noise) that rises at moderate speeds. A high-frequency component (spray and cavitation) that only appears at high speeds. All three layers have their filter cutoffs and gains driven by hull speed through water. The skin friction force -- already computed by the physics -- is an excellent proxy for the total hydrodynamic noise energy.

**Gameplay connection:** One of the most constant sounds in the game. It tells the player how fast they're going without looking at any UI. Changes in pitch and intensity communicate acceleration and deceleration immediately. The transition to planing sound (if we implement planing physics) would be a particularly satisfying moment.

#### 3.2 Bow Wave / Spray

**What it sounds like:** A splashy, airy sound of water being thrown aside by the bow. More prominent at higher speeds. Distinct from the general hull sound -- more chaotic and percussive.

**Simulation inputs:**
- `BoatSpray` particle spawn rate and velocity (already varies with boat speed)
- Hull speed
- Wave encounter angle (heading into waves produces more spray than running with them)
- `WaterQuery` surface height at bow (detecting when the bow punches through a wave crest)

**How to build it:** Filtered noise with a spiky amplitude envelope. The spray particle system already tracks when and how much spray is being generated -- use its spawn rate as a direct gain control. When the bow meets a wave crest (detectable via water surface height at the bow position rising above the hull), inject a burst of spray sound. High-pass filtered to sit above the hull rushing sound in the frequency spectrum.

**Gameplay connection:** Spray sound increases with speed and roughness of conditions. It's an indicator of how hard the boat is working. Sudden spray bursts when hitting waves give visceral feedback about sea state.

#### 3.3 Wake

**What it sounds like:** A low, continuous bubbling/churning behind the boat. The sound of turbulent water being left behind.

**Simulation inputs:**
- `Wake` particle density and age
- Hull speed (wake intensity tracks speed)
- Wake particle lateral spread velocity (5 ft/s parameter)

**How to build it:** Low-frequency filtered noise positioned behind the boat (using `PositionalSound` at the stern). Gain proportional to hull speed. Gentle amplitude modulation to give it a bubbling quality. Should be subtle -- the wake is behind you, so panning and distance attenuation naturally reduce it.

**Gameplay connection:** Subtle background confirmation of movement. If you stop, the wake sound fades. Tells you something is wrong if you expect to be moving but don't hear it.

#### 3.4 Wave Slap

**What it sounds like:** The percussive slapping sound of wave crests hitting the hull side. Ranges from gentle lapping in calm conditions to sharp, loud impacts in rough seas.

**Simulation inputs:**
- `WaterQuery` surface height at hull contact points (multiple points along the hull)
- Rate of change of water surface height (rising water = wave approaching the hull)
- Water surface normal relative to hull normal (steeper = harder impact)
- Hull velocity perpendicular to the wave (beam-on waves slap harder)

**How to build it:** This one benefits from sample playback with physics-driven triggering and modulation. Monitor water surface height at several points along the hull. When the surface rises past the hull waterline with sufficient velocity, trigger a wave slap sample. The sample's gain and pitch are modulated by the impact velocity (rate of surface height change times the hull's cross-wave velocity component). In calm water, these triggers rarely fire. In rough water, they produce a continuous irregular rhythm of impacts.

**Gameplay connection:** Communicates sea state. In protected water, it's calm. As waves build, the slapping becomes more frequent and forceful. Players learn to associate this rhythm with danger level. Particularly important when sailing beam-on to waves (most vulnerable angle).

---

### 4. Rudder and Steering

#### 4.1 Rudder Water Flow

**What it sounds like:** A subtle, continuous underwater gurgling/swishing that changes character with rudder angle and boat speed. Neutral rudder is nearly silent. A turned rudder produces a more turbulent, "torn" water sound.

**Simulation inputs:**
- Rudder angle (0 to ~30 degrees)
- Rudder angle of attack (from `Rudder.ts` foil physics)
- Flow speed past the rudder (boat speed relative to water at rudder position)
- Rudder lift and drag forces (already computed)
- Rudder stall state (the rudder can stall just like a foil at extreme angles)

**How to build it:** Filtered noise positioned at the stern. Gain tracks flow speed. Filter resonance and bandwidth increase with rudder angle (more angle = more turbulence = broader, noisier sound). If the rudder stalls (extreme angle at speed), introduce a distinctive low-frequency rumble -- the same physics that cause foil stall (flow separation) also produce a characteristic sound.

**Gameplay connection:** Tells the player how much hydrodynamic "work" the rudder is doing. A stalling rudder sounds alarming, cueing the player to reduce rudder angle. The quiet, clean sound of a centered rudder reinforces good straight-line sailing.

---

### 5. Keel

#### 5.1 Keel Flow Noise

**What it sounds like:** A low hum/moan from water flowing over the keel. Increases in pitch and volume with boat speed. Changes character when the keel's angle of attack increases (more sideslip).

**Simulation inputs:**
- Keel angle of attack (from `Keel.ts` -- the angle between the hull's heading and its actual direction of travel)
- Flow speed past the keel
- Keel lift and drag forces
- Keel stall state (stall angle ~15 degrees for symmetric foil)

**How to build it:** Low-frequency oscillator whose pitch tracks flow speed (Strouhal relation on the keel chord of 1.25 ft). Gain tracks dynamic pressure (`0.5 * ρ * v²`). When the angle of attack increases (the boat is making significant leeway), add broadband noise representing increased turbulence. Keel stall -- a dramatic event where the keel loses its ability to prevent sideslip -- should produce a sudden change: the clean tonal sound breaks up into a chaotic, lower-frequency rumble.

**Gameplay connection:** Keel stall is a dangerous condition that most new sailors won't understand visually. The sound of the keel going from a clean hum to a rough rumble is an immediate, visceral warning. It also provides feedback on leeway -- the amount of broadband noise mixed in tells you how much the boat is slipping sideways.

---

### 6. Anchor

#### 6.1 Anchor Deploy Splash

**What it sounds like:** A heavy splash as the anchor hits the water, followed by a rapid chain/rope paying-out sound as the rode deploys.

**Simulation inputs:**
- Anchor deploy event trigger (state transition: stowed -> deploying)
- Anchor body velocity at water entry (the `AnchorSplashRipple` already fires spray particles)
- Rode deployment speed (`rodeDeploySpeed` from config)
- Current rode length (animation from 0 to `maxRodeLength`)

**How to build it:** A splash sample triggered on deploy, with gain proportional to entry velocity. Then a continuous rode-paying-out sound (rope running through a chock) whose playback rate tracks deployment speed and which stops when the rode reaches full length or the anchor state changes.

**Gameplay connection:** Satisfying confirmation of anchor deployment. The sound of the rode running out tells the player it's working, and the silence when it stops tells them the anchor is set.

#### 6.2 Anchor Rode Under Tension

**What it sounds like:** A deep, taut groaning/creaking when the anchor rode goes taut and the boat pulls against it. In strong current or wind, the rode can vibrate and hum.

**Simulation inputs:**
- `DistanceConstraint` force on the rode (the tension between the hull attachment point and the anchor body)
- Wind/current force on the hull (what's pulling the boat away from the anchor)
- Rode length and angle

**How to build it:** A low-frequency tonal sound whose pitch rises with rode tension (higher tension = higher vibration frequency on a taut line). Amplitude also tracks tension. Above a threshold tension, add creaking transients.

**Gameplay connection:** Tells the player whether the anchor is holding and how much strain it's under. A calm, quiet rode means safe anchorage. A groaning, vibrating rode means conditions are deteriorating and the anchor might drag.

#### 6.3 Anchor Retrieval

**What it sounds like:** The reverse of deployment -- the rode being pulled back in, with the anchor breaking free from the bottom producing a jolt, and finally the anchor clanking back into its stowed position.

**Simulation inputs:**
- Rode retrieval speed
- Decreasing rode length
- Anchor state transition (deployed -> retrieving -> stowed)

**How to build it:** Reversed rode-running sample. A "break free" transient when retrieval starts. A stowing clank at the end.

**Gameplay connection:** Confirms the anchor is coming up and when it's secured.

---

### 7. Rowing

#### 7.1 Oar Strokes

**What it sounds like:** A rhythmic cycle: the catch (oar entering water -- a quick splash), the drive (sustained water resistance sound), and the recovery (oar leaving water -- a dripping release).

**Simulation inputs:**
- Row action state (space bar press timing)
- Boat speed (faster boat = more resistance sound during drive)
- Water surface state at oar position

**How to build it:** A three-phase sample set (catch, drive, recovery) triggered by the rowing input. The drive phase gain and pitch scale with resistance (which depends on boat speed). In rough water, the catch phase might miss or hit a wave, adding variation.

**Gameplay connection:** Rhythmic feedback that helps the player establish a rowing cadence. The resistance sound tells them whether the strokes are effective.

---

### 8. Collisions

#### 8.1 Hull Impacts

**What it sounds like:** Varies enormously by what's hit. Hitting a buoy: a hollow, resonant thud. Running aground: a deep, grinding crunch. Hull-to-hull (if multiplayer): a woody crack.

**Simulation inputs:**
- Physics engine `impact` event (velocity at contact, collision normal)
- Contact body types (buoy, terrain, other hull)
- Impact energy (`0.5 * m * v²` for the collision)
- Contact surface material

**How to build it:** Impact samples selected by material pair, with gain and pitch modulated by impact energy. Low-energy contacts produce quiet thumps; high-energy contacts are loud cracks. For grounding, a sustained grinding loop that plays while the hull is in contact with terrain, with gain proportional to sliding velocity.

**Gameplay connection:** Immediate feedback about collisions. The sound communicates severity -- a light brush against a buoy versus a hard grounding. Tells the player when they've made a mistake and how bad it is.

#### 8.2 Buoy Interaction

**What it sounds like:** The metallic clang or hollow thud of hitting a buoy, plus the sound of the buoy rocking and splashing in the water as it settles.

**Simulation inputs:**
- Collision event with buoy body
- Buoy angular velocity after impact (rocking)
- Buoy body interaction with water surface (from buoyancy simulation)
- Impact velocity

**How to build it:** A metallic impact sample on collision, gain from impact energy. Then a decaying water-slapping loop as the buoy rocks, driven by the buoy's actual angular velocity and its interaction with the water surface height query.

**Gameplay connection:** Buoys are navigation markers. Hitting one should sound wrong and slightly alarming. The lingering rocking sound is a reminder that you hit it.

---

### 9. Environmental / Ambient

#### 9.1 Water Surface Ambience

**What it sounds like:** The general sound of being on open water -- a bed of soft, irregular lapping and low-frequency wave motion. Changes with sea state: glassy calm is nearly silent; rough conditions are a constant low roar.

**Simulation inputs:**
- `WaterQuery` wave amplitude and frequency at the listener position
- Wave source parameters (number of active wave sources, their amplitudes)
- Tide state (from `TimeOfDay` -- tidal variation)

**How to build it:** Layered noise beds at different frequency ranges, with amplitude driven by aggregate wave energy. The wave sources already have amplitude and wavelength parameters -- sum their energies to get a sea state value that drives the ambient volume and spectral content. Low sea state emphasizes low-frequency, gentle lapping. High sea state adds mid and high-frequency content.

**Gameplay connection:** Sets the mood and communicates conditions before the player even starts sailing. A quiet, glassy ambient tells them it's calm. A building roar says conditions are getting serious.

#### 9.2 Shallow Water

**What it sounds like:** A change in the water ambience character when near shore or in shallow water. The lapping becomes more defined, with occasional wave-on-shore sounds. Wavelengths shorten (shoaling) and the sound becomes more chaotic.

**Simulation inputs:**
- `WaterQuery` depth at listener position
- Wave shoaling computation (Green's Law already applied in water shader)
- Distance to terrain

**How to build it:** A crossfade layer that activates when water depth drops below a threshold. The shoaling physics already amplify waves in shallow water -- use the increased wave amplitude to drive more energetic and higher-pitched water sounds. Add occasional breaking/washing sounds when wave height exceeds a fraction of water depth.

**Gameplay connection:** Audio warning of shallow water. Players learn to associate the change in water sound with approaching shore or shoals. Complements any visual depth cues.

---

### 10. Boat Structural Sounds

#### 10.1 Hull Creaking

**What it sounds like:** Wooden creaking and groaning sounds from the boat's structure under stress. Occurs during heeling, wave impacts, and when the boat is heavily loaded by wind.

**Simulation inputs:**
- Hull angular velocity (the boat rocking/heeling produces structural stress)
- Total force on hull from sails (aerodynamic loading)
- Wave impact events (sudden force changes)
- Rate of change of forces (dynamic loading stresses the hull more than static)

**How to build it:** A library of short creak samples triggered stochastically, with probability and gain proportional to hull stress indicators. Rapid changes in heel angle or sudden wave encounters increase the trigger rate. At high sustained loads, occasional longer groaning sounds. Keep it subtle in normal conditions -- just enough to remind the player they're on a boat.

**Gameplay connection:** Communicates that the boat is a physical structure under real forces. Builds tension in rough conditions. Excessive creaking warns the player they're pushing the boat hard.

---

## Mixing and Priority

Not all sounds are equally important at all times. The mix should adapt to conditions:

- **In light air:** Water ambience and subtle hull sounds dominate. Sail adjustments are clearly audible. The world feels quiet and peaceful.
- **In heavy air:** Wind and wave sounds build. Sail luffing is loud and urgent. Hull impacts are percussive. Rigging whistles. The soundscape becomes tense and demanding.
- **While maneuvering:** Rudder flow, sheet adjustments, and sail state changes come to the foreground. The player needs to hear the feedback from their control inputs.
- **At anchor:** Wind and wave ambience. Rode tension sounds. The absence of hull flow sounds communicates stillness.

A dynamic mixing system should manage the overall loudness budget, ensuring that critical sounds (sail luffing as a trim warning, collision impacts, keel stall) always cut through regardless of how busy the ambient layer is.

---

## Summary

The guiding principle is simple: if the simulation computes it, the sound system should express it. We are not decorating the game with audio -- we are giving the simulation a voice. Every force, every flow state, every contact event is an opportunity for sound that teaches the player about the world they're sailing in.
