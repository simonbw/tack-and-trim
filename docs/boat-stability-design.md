# Boat Stability Systems Design

This document describes the game design for boat tilting, water accumulation, and capsizing mechanics. These systems work together to create meaningful danger in rough conditions and reward skillful sailing.

## Design Goals

1. **Create consequence for overpowering** - Strong wind should be dangerous if you don't actively manage sail trim
2. **Make waves matter** - Large waves should threaten the boat, not just be visual
3. **Reward skilled play** - Experienced players can sail in conditions that would sink beginners
4. **Enable progression** - These mechanics gate access to rougher waters naturally
5. **Feel visceral** - The boat should feel alive and reactive, not like a hovercraft

---

## System 1: Boat Tilting (Heel)

### Concept

The boat has a **heel angle** representing how much it's tipping to one side. This is displayed visually as a rotation/tilt of the boat sprite and affects gameplay.

### What Causes Heel

| Source | Direction | Notes |
|--------|-----------|-------|
| Wind on sails | Leeward (downwind) | Primary source. More sail area + stronger wind = more heel |
| Waves | Varies | Waves rolling under the boat cause temporary heel spikes |
| Momentum/turning | Into the turn | Quick turns cause the boat to lean |
| Water inside boat | Toward low side | Water sloshes to leeward, amplifying heel |

### Heel Feel

- **0-15°**: Normal sailing. Boat feels fast and responsive.
- **15-30°**: "Powered up" - boat is at maximum efficiency but getting risky. Visual warning.
- **30-45°**: Overpowered. Rudder starts losing effectiveness. Water may come over the rail.
- **45°+**: Critical. Imminent capsize unless player acts immediately.

### Righting Forces

The boat naturally wants to return to level. The **righting moment** comes from:

- **Hull shape** - Wide beam creates initial stability
- **Keel/centerboard weight** - Pulls the boat back upright
- **Automated ballast system** - Shifts weight to windward automatically (see below)

The righting moment increases with heel angle up to a point (typically 60-90°), then decreases. Past the **point of vanishing stability**, the boat will capsize.

### Automated Ballast System

Rather than manual hiking controls, boats are equipped with an **automated ballast transfer system** - a futuristic mechanism that shifts water or weight to the windward side to counteract heel. This fits the setting of advanced sailboats with automated systems.

**How it works:**
- The system reacts to heel angle automatically
- Transfers ballast toward the high side to create righting moment
- Has a maximum capacity (can only counteract so much heel force)
- Has a reaction speed (can't respond instantly to gusts)

**Upgrade path:**
| Level | Capacity | Reaction Speed | Notes |
|-------|----------|----------------|-------|
| None | - | - | No automated assistance, pure hull stability |
| Basic | Low | Slow | Helps in light-moderate conditions |
| Standard | Medium | Medium | Handles steady strong wind |
| Advanced | High | Fast | Can react to gusts, handles rough conditions |
| Racing | Very high | Very fast | Top-tier, required for extreme conditions |

**Design benefits:**
- No extra controls for the player to manage
- Creates a clear upgrade progression
- Explains why better boats handle rougher conditions
- Player still needs skill (reefing, trim, heading) - the system just raises the threshold

### Player Counterplay

Players can reduce heel by:

1. **Easing sheets** - Let sails out to spill wind (reduces power but prevents capsize)
2. **Heading up** - Turn toward the wind to reduce apparent wind angle
3. **Reefing** - Reduce sail area to decrease heel force (can be done anytime)
4. **Dumping water** - Less water inside = less weight amplifying heel

### Visual Representation

Since this is a top-down 2D game, heel needs creative visual treatment:

- **Boat sprite rotation** - Slight rotation toward the heeled side
- **Perspective shift** - Boat appears to "lean" with one side higher/closer to camera
- **Shadow/water line** - Shows more of one side of the hull
- **Crew position** - Crew sprites shift to the high side
- **Wake asymmetry** - Leeward rail creates more spray

### Interaction with Other Systems

- **Rudder effectiveness** - High heel reduces steering control (rudder lifts out of water)
- **Speed** - Moderate heel is fast; excessive heel increases drag dramatically
- **Water ingress** - High heel causes water to come over the leeward rail

---

## Sail Controls and Reefing

### Continuous Sail Raise/Lower

The current binary "sails up/down" system is replaced with **continuous control**:

- Player selects which sail to control (main, jib, or both)
- Hold raise/lower input to smoothly adjust sail height
- Release to stop at any position
- Sail area scales with how much is raised

### Reefing as Partial Hoist

"Reefing" is simply having a sail partially raised:

| Hoist Level | Effective Sail Area | Use Case |
|-------------|---------------------|----------|
| 100% | Full power | Light to moderate wind |
| 75% | Good power, reduced heel | Moderate to strong wind |
| 50% | Moderate power, much safer | Strong wind, rough conditions |
| 25% | Minimal power, maximum control | Storm survival |
| 0% | No sail | Rowing, anchored, emergency |

### When to Reef

The skill is knowing when to reef:

- **Reef too early**: Not enough power to make headway, especially against current
- **Reef too late**: Already overpowered, struggling to control the boat while reefing
- **Right timing**: Reef before conditions overwhelm you, when you can still control the boat

### Reefing While Sailing

Unlike real sailing where reefing requires specific maneuvers, reefing can happen **anytime** for accessibility:

- Lower sail partially even while moving
- Raise sail to catch more wind on the fly
- No need to head into wind or stop

This abstracts away the complexity of real reefing (boom vang, reef points, cunningham) while keeping the strategic decision of "how much sail do I want?"

### Control Scheme (Proposed)

| Input | Action |
|-------|--------|
| Tab / Select | Cycle selected sail (main → jib → both) |
| W / Up | Raise selected sail |
| S / Down | Lower selected sail |
| Hold Shift | Faster raise/lower |

The selected sail is indicated visually (highlight, icon, or UI element).

---

## System 2: Water in the Boat

### Concept

Water can accumulate in the cockpit. More water makes the boat heavier, lower in the water, and more sluggish. Too much water leads to swamping and sinking.

### Sources of Water

| Source | Rate | Condition |
|--------|------|-----------|
| Rail in water | Fast | Heel angle > threshold (rail dips below waterline) |
| Waves over bow | Medium | Heading into large waves, or wave breaks over deck |
| Waves over stern | Medium | Running in large following seas, wave overtakes boat |
| Spray/splash | Slow | Constant small accumulation in rough conditions |
| Rain | Very slow | Weather system (if implemented) |

### Water Accumulation Effects

| Water Level | Effect |
|-------------|--------|
| 0-25% | Minimal effect. Sloshing sound. Slight weight increase. |
| 25-50% | Noticeably heavier. Reduced acceleration. Heel response more sluggish. |
| 50-75% | Dangerously heavy. Very slow. Reduced freeboard means more water comes in faster (death spiral). |
| 75-100% | Swamped. Boat barely moves. Sinking imminent without intervention. |

### The Death Spiral

This is the key danger: once you start taking on water, you sit lower, which means you take on MORE water. The player must act quickly to break this cycle.

### Bailing and Bilge Pumps

Water removal uses a **hybrid system**: automatic bilge pumps provide background drainage, while manual bailing handles emergencies.

#### Automatic Bilge Pump

The bilge pump runs continuously, removing water at a steady rate:

- **Base rate** depends on pump upgrade level
- **Overwhelmed** when intake exceeds pump capacity
- Player doesn't need to manage it directly

**Bilge Pump Upgrades:**

| Level | Drain Rate | Notes |
|-------|------------|-------|
| None | Very slow | Manual scupper drainage only |
| Basic | Slow | Handles spray and light splash |
| Standard | Medium | Keeps up with moderate conditions |
| Heavy-duty | Fast | Handles rough conditions, quick recovery |
| Industrial | Very fast | Emergency-grade, hard to overwhelm |

#### Manual Bailing

For emergencies when the pump can't keep up:

- Player holds a key to bail manually
- Much faster than the pump, but has tradeoffs
- Required input during crisis situations

**Bailing Tradeoffs** - What can't you do while bailing?

| Sacrifice | Gameplay Impact |
|-----------|-----------------|
| Steering | Boat goes straight, can't react to waves/wind shifts |
| Trimming | Sails may luff or overpower |
| Both? | Maximum bail rate but zero control |

This creates meaningful tension: "I'm taking on water but there's a gust coming - do I bail now or trim first?"

#### The Bilge Pump Decision

Upgrading the bilge pump is a key progression choice:

- Better pumps let you survive rougher conditions
- But even the best pump can be overwhelmed in extreme situations
- Manual bailing is always the emergency fallback

### Visual Representation

- **Water level visible in cockpit** - Transparent water rendered inside hull outline
- **Boat sits lower** - Waterline rises on hull as water accumulates
- **Sluggish particle effects** - Spray and wake look heavier when loaded with water
- **Bailing animation** - Water splashing overboard when manually bailing
- **Bilge pump indicator** - UI shows pump status (working, overwhelmed, off)

### Water Slosh Physics

Water inside the boat isn't static - it **sloshes** based on boat motion:

**Slosh Behavior:**
- Water shifts toward the **low side** when heeling
- Water shifts **forward/backward** during acceleration/deceleration
- Water has **momentum** - continues moving briefly after boat motion stops
- Sloshing creates a **feedback loop** with heel (water moves to low side → more heel → more water moves)

**Physical Effects of Slosh:**
- **Amplifies heel** - Water weight on low side increases heeling moment
- **Affects trim** - Water at bow/stern changes pitch
- **Reduces stability** - Moving water mass makes the boat feel "loose"
- **Resonance danger** - Rhythmic waves can cause water to slosh in sync, amplifying the problem

**Gameplay Implications:**
- Even moderate water levels become dangerous if sloshing gets out of control
- Smooth sailing keeps water stable; jerky maneuvers make it worse
- Sometimes the best move is to stabilize and let the water settle before maneuvering

### Draft and Performance Effects

Water adds weight, which affects the boat physically:

| Water Level | Draft Increase | Speed Penalty | Acceleration | Handling |
|-------------|----------------|---------------|--------------|----------|
| 0-25% | Minimal | ~5% | ~10% slower | Normal |
| 25-50% | Noticeable | ~15% | ~25% slower | Sluggish |
| 50-75% | Significant | ~30% | ~50% slower | Very sluggish |
| 75-100% | Severe | ~50%+ | Barely moves | Nearly unresponsive |

**Draft effects:**
- Boat sits lower in water, reducing freeboard
- Lower freeboard = easier for waves/heel to bring in more water
- Deeper draft may cause grounding in shallow water

---

## System 3: Capsizing and Sinking

### Capsize Conditions

The boat capsizes when:

1. **Heel exceeds critical angle** (~70-90° depending on boat) - Wind/waves overpower righting moment
2. **Stability lost due to water weight** - Water inside shifts the center of gravity
3. **Knockdown from wave** - Large breaking wave hits the boat broadside

### Capsize Sequence

Capsizing shouldn't be instant. A brief sequence creates drama and potential recovery:

1. **Critical heel warning** (0.5-1s) - Screen effects, audio warning, boat sprite shows extreme lean
2. **Point of no return** - If player hasn't corrected, capsize begins
3. **Capsize animation** (1-2s) - Boat rolls over, sails hit water
4. **Capsized state** - Boat is on its side or inverted

### Capsize vs. Sinking

Important distinction:

- **Capsize** = boat tips over but can potentially recover
- **Sinking** = boat fills with water and goes under = **game over**

### Capsize Recovery

When the boat capsizes (tips past point of no return):

1. **Capsize animation** plays (boat rolls, sails hit water)
2. **Water floods in rapidly** - capsized boats fill quickly
3. **Recovery window** - brief chance to right the boat
4. **If recovered**: Boat rights itself but is full of water, must bail immediately
5. **If not recovered**: Boat sinks

**Recovery factors:**
- Conditions matter - calmer water gives more time to recover
- Automated ballast system helps (if upgraded)
- Water already in boat makes recovery harder
- Some boats are more recoverable than others (wider beam, more buoyancy)

### Sinking = Game Over

Sinking occurs when:
- Water level reaches 100% (complete swamp)
- Capsize recovery fails
- Catastrophic event (future: collision, storm damage)

**Sinking Sequence:**
1. Boat slips below waterline
2. Screen effect (blur, darkening)
3. "Lost at Sea" / game over screen
4. **Reset to last save point** (free roam) or **mission restart** (during mission)

### Stakes and Tension

This creates real consequences:

- Players must respect dangerous conditions
- Getting in over your head has a real cost
- Missions in rough water feel genuinely risky
- "Do I push through or turn back?" becomes a meaningful choice

### Difficulty Considerations

To prevent frustration while maintaining stakes:

- **Save points** should be reasonably frequent in the open world
- **Missions** should have appropriate checkpoints for length
- **Warning signs** should be clear before conditions become deadly
- **Easy mode** (optional) could allow capsize recovery in any conditions

---

## System Interactions

### Heel → Water → Sink Chain

```
Strong wind/waves
       ↓
  Excessive heel
       ↓
  Rail underwater → Water floods in
       ↓
  Boat gets heavier → Sits lower → More water floods in
       ↓
  Can't right the boat → Capsize
       ↓
  Capsized boat fills with water → Sink
```

The player can break this chain at any point with the right action.

### Wave Interaction with Heel

Waves should create dynamic heel moments:

- **Beam seas** (waves from the side) - Cause large heel oscillations, hardest to manage
- **Following seas** (waves from behind) - Risk of broaching (spinning out) and stern swamping
- **Head seas** (waves from ahead) - Pitching and bow spray, less heel danger

### Wind Gusts

Gusts are particularly dangerous because:
- Heel increases suddenly
- Player may not have time to ease sheets
- Creates "reflex test" gameplay moments

Consider a **gust indicator** so players can anticipate and prepare.

---

## Difficulty Tuning

These systems can be tuned to create progression:

### Boat Upgrades

**Stability upgrades:**
| Upgrade | Effect |
|---------|--------|
| Wider beam | More initial stability, slower heel response |
| Heavier keel | Stronger righting moment, higher capsize angle |
| Higher freeboard | Rail goes underwater at higher heel angles |
| Ballast system | Auto-counteracts heel (see System 1) |

**Water management upgrades:**
| Upgrade | Effect |
|---------|--------|
| Bilge pump | Auto-drains water (see System 2) |
| Sealed cockpit | Reduces water ingress from spray |
| Scuppers | Passive drainage when boat is level |

**Sail upgrades:**
| Upgrade | Effect |
|---------|--------|
| Smaller sails | Less power, less heel force, good for rough weather |
| Storm sail | Tiny sail for survival conditions |
| Quick-reef system | Faster sail raise/lower speed |

### Regional Difficulty

| Region | Wind | Waves | Margin for Error |
|--------|------|-------|------------------|
| Protected bay | 5-10 kt | Flat | Very forgiving, hard to capsize |
| Coastal | 10-20 kt | Small-medium | Requires attention, occasional bail |
| Offshore | 15-30 kt | Medium-large | Active management required |
| Storm/open ocean | 25-40+ kt | Large | Expert skill or upgraded boat required |

### Skill Expression

Skilled players demonstrate mastery by:
- Sailing at optimal heel angle (powered up but not overpowered)
- Anticipating gusts and waves, reefing proactively
- Reading conditions and choosing the right sail configuration
- Smooth maneuvers that don't upset water slosh
- Quick sheet easing when hit by unexpected gusts
- Knowing when to bail vs. when to keep sailing
- Recognizing when to turn back before it's too late

### Progression: Skill vs. Equipment

Both player skill and boat upgrades expand what's possible:

**Skill alone:**
- A skilled player in a basic boat can handle moderate conditions
- Proper reefing, trim, and course selection matter more than gear
- Knowledge of when to turn back is crucial

**Equipment alone:**
- Upgraded boat with unskilled player survives longer but still fails in rough conditions
- Better bilge pump buys time but doesn't prevent water intake
- Ballast system helps but can be overwhelmed

**Skill + Equipment:**
- Required for the roughest conditions
- Upgrades raise the ceiling; skill lets you reach it
- The most dangerous waters require both mastery and gear

---

## Design Decisions (Resolved)

These questions have been answered:

| Question | Decision |
|----------|----------|
| Hiking mechanic | **No manual hiking.** Replaced with automated ballast transfer system that can be upgraded. Fits the futuristic boat setting. |
| Reefing | **Reef anytime.** Continuous sail raise/lower - stop at any point. Simple and accessible. |
| Capsize recovery | **Automatic with conditions.** Recovery possible if conditions allow and boat isn't too swamped. No mini-game. |
| Sinking consequences | **Game over.** Reset to last save point (free roam) or mission start (during mission). Real stakes. |
| Water physics | **Full slosh simulation.** Water moves with boat motion, affects heel and trim, creates feedback loops. |
| Bilge pumps | **Upgradeable.** Background auto-drain plus manual emergency bailing. Pump level is key progression. |

## Remaining Questions

1. **Exact control mapping** - Which keys for sail select, raise/lower, bailing?
2. **Capsize recovery timing** - How long before a capsize becomes unrecoverable?
3. **Save point frequency** - How often should auto-saves happen in free roam?
4. **Equipment damage** - Should rough conditions damage sails/rigging over time?
5. **Crew members** - Do additional crew help with bailing rate or other tasks?

---

## Summary

These three systems create an interconnected danger model:

- **Heel** is the first warning sign - managed through sail trim, heading, and reefing
- **Water accumulation** is the consequence of poor heel management - handled by bilge pumps and manual bailing
- **Capsizing/sinking** is the ultimate failure state - game over, real stakes

**Key design pillars:**
- **Automated assistance** (ballast, bilge pumps) provides baseline capability that can be upgraded
- **Player skill** (reefing timing, trim, course selection) determines success within those capabilities
- **Real consequences** (sinking = reset) make dangerous waters genuinely threatening
- **Clear feedback** (visual heel, water level, slosh) lets players understand what's happening

Together these systems transform sailing from "point at destination and wait" to an active, engaging challenge where rough conditions are genuinely dangerous and skill is rewarded.
