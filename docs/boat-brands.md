# Boat Brands

Tack & Trim features three boat manufacturers, each with a distinct identity and lineup spanning multiple size classes.

## Shaff

Performance-oriented boats built for sailors who want the most speed per dollar. Shaff boats sacrifice cargo space and creature comforts for sharp handling and competitive edge. The lineup uses a simple letter-number scheme, where the number is the hull length in yards.

| Class | Model |
| ----- | ----- |
| S     | S-7   |
| M     | S-11  |
| L     | S-15  |
| XL    | S-20  |

### Shaff style guide

A "Mermaid" livery inspired by the Zissou palette: teal topsides over a white deck, gold pinstripe and boom, a warm teak bench, brushed-aluminum mast, and a single pop of racing red on the mainsheet. Every Shaff should look like it was built in a wind tunnel — and then painted by someone who read too much Jacques Cousteau.

**Hull exterior**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `hull.fill` (deck) | `#ffffff` | white deck |
| `hull.stroke` (gunwale) | `#e1af00` | gold trim line |
| `hull.side` (topsides) | `#3b9ab2` | signature mermaid teal |
| `hull.bottom` (antifouling) | `#1a4552` | deep teal |

**Deck zones**

| Zone | Color | Notes |
| ---- | ----- | ----- |
| foredeck | `#ffffff` | white |
| cockpit | `#3b9ab2` | medium teal nonskid sole |
| bench | `#1a4552` | dark teal |
| bulkhead | `#ffffff` | white |
| companionway | `#0f3a47` | dark teal opening |

**Rig, foils, and fittings**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `keel.color` / `rudder.color` | `#1a4552` | deep teal foils |
| `rig.colors.mast` | `#888888` | brushed aluminum |
| `rig.colors.boom` | `#e1af00` | gold boom |
| `mainsail.color` / `jib.color` | `#fafafa` | racing white |
| `bowsprit.color` | `#e1af00` | gold, matching gunwale |
| `lifelines.tubeColor` | `#cccccc` | stainless |
| `lifelines.wireColor` | `#888888` | steel wire |

**Running rigging (ropes)**

| Line | Pattern | Notes |
| ---- | ------- | ----- |
| `ropes.mainsheet` | 16-plait braid, `#f21a00` + `#ffffff` flecks, 35° | racing red with white flecks |
| `ropes.jibSheet` | 16-plait braid, `#3b9ab2` + `#e1af00` flecks, 35° | teal with gold flecks |
| `ropes.anchorRode` | 8-plait braid, alternating `#ebcc2a` / `#3b9ab2`, 40° | poolside yellow-and-teal |

## BHC

Affordable recreational boats with a bit more space and creature comforts than the competition. BHC boats may not be the fastest on the water, but they're forgiving, practical, and built for a good day out. Models are named for what you'd actually do in them.

| Class | Model      |
| ----- | ---------- |
| S     | Daysailer  |
| M     | Weekender  |
| L     | Journey    |
| XL    | Expedition |

### BHC style guide

A warm traditional palette: cream decks with brown trim, honey-teak interiors, tan-toned alloy spars, and hemp-colored running rigging. Every BHC should feel like a sunny afternoon at the yacht club.

**Hull exterior**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `hull.fill` (deck) | `#d8c89c` | warm cream gel-coat |
| `hull.stroke` (gunwale) | `#6a4a1a` | brown trim |
| `hull.side` (topsides) | `#e8dbb0` | light cream |
| `hull.bottom` (antifouling) | `#4a3018` | dark mahogany |

**Deck zones**

| Zone | Color | Notes |
| ---- | ----- | ----- |
| foredeck | `#c4a46c` | light teak |
| cockpit | `#8a6538` | honey teak nonskid |
| bench | `#a88450` | medium teak |
| bulkhead | `#6a4620` | dark teak |
| companionway | `#2a1808` | dark mahogany |

**Rig, foils, and fittings**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `keel.color` / `rudder.color` | `#5a4030` | stained wood |
| `rig.colors.mast` | `#a09080` | tan-gray alloy |
| `rig.colors.boom` | `#8a6a40` | tan-brown |
| `mainsail.color` / `jib.color` | `#eeeedd` | cream Dacron |
| `bowsprit.color` | `#775533` | classic wood |
| `lifelines.tubeColor` | `#aaaaaa` | painted alloy |
| `lifelines.wireColor` | `#777777` | weathered wire |

**Running rigging (ropes)**

| Line | Pattern | Notes |
| ---- | ------- | ----- |
| `ropes.mainsheet` | 3-strand laid, `#c9a968` / `#b89050` / `#c9a968`, 38° | classic manila |
| `ropes.jibSheet` | 16-plait braid, `#d8b878` + `#6a4a1a` flecks, 35° | hemp with brown tracer |
| `ropes.anchorRode` | 3-strand laid, `#6a4a1a` / `#553818` / `#6a4a1a`, 42° | tarred marline |

## Maestro

Luxury Italian-inspired boats with high-tech features, strong performance, and generous cargo space — at a premium price. Maestro is the most expensive brand in every size class, but you get what you pay for. Models are named after musical forms, scaling in complexity and grandeur.

| Class | Model    |
| ----- | -------- |
| S     | Etude    |
| M     | Trio     |
| L     | Fantasia |
| XL    | Opus     |

### Maestro style guide

A luxury palette: deep navy topsides under ivory decks, gold gunwales, varnished-teak soles with ivory bulkheads, polished-silver spars with gold booms, and navy running rigging. Every Maestro should look like it costs more than it does.

**Hull exterior**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `hull.fill` (deck) | `#e8e0cc` | ivory gel-coat |
| `hull.stroke` (gunwale) | `#b09030` | gold trim |
| `hull.side` (topsides) | `#162648` | deep navy |
| `hull.bottom` (antifouling) | `#060b1a` | near-black navy |

**Deck zones**

| Zone | Color | Notes |
| ---- | ----- | ----- |
| foredeck | `#e8e0cc` | ivory |
| cockpit | `#6a4a28` | varnished teak sole |
| bench | `#8a6236` | honey teak |
| bulkhead | `#e8e0cc` | ivory |
| companionway | `#0a1028` | navy opening |

**Rig, foils, and fittings**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `keel.color` / `rudder.color` | `#162648` | navy foils |
| `rig.colors.mast` | `#bbbbcc` | polished silver |
| `rig.colors.boom` | `#b09030` | gold boom |
| `mainsail.color` / `jib.color` | `#f4f2ee` | ivory cloth |
| `bowsprit.color` | `#b09030` | gold bowsprit |
| `lifelines.tubeColor` | `#ccccdd` | polished stainless |
| `lifelines.wireColor` | `#999999` | steel wire |

**Running rigging (ropes)**

| Line | Pattern | Notes |
| ---- | ------- | ----- |
| `ropes.mainsheet` | 16-plait braid, `#0a1a40` + `#b09030` flecks, 32° | navy with gold tracer |
| `ropes.jibSheet` | 16-plait braid, `#f4f2ee` + `#0a1a40` flecks, 32° | ivory with navy fleck |
| `ropes.anchorRode` | 8-plait braid, alternating `#0a1a40` / `#b09030`, 40° | navy-and-gold |

## Applying a brand palette

The palettes above are implemented in [`src/game/boat/configs/brandPalettes.ts`](../src/game/boat/configs/brandPalettes.ts) as `SHAFF_PALETTE`, `BHC_PALETTE`, and `MAESTRO_PALETTE`. Boat configs apply them via `withBrandPalette(baseConfig, palette)` so that individual boat files only carry geometry and physics overrides, never colors or rope patterns. Running-rigging patterns are full `RopePattern` objects (`type`, `carriers`, `helixAngle`, optional `weave`) defined on `palette.ropes`; the helper assigns them to `mainsheet.ropePattern`, `jibSheet.ropePattern`, and `anchor.ropePattern` respectively, overwriting anything set on the base. If you add a new boat to an existing brand, use the helper — do not copy colors or rope patterns inline.
