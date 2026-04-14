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

A minimalist racing palette: white hulls with black trim, carbon-and-graphite interiors, brushed-aluminum spars, and a single pop of racing red on the mainsheet. Every Shaff should look like it was built in a wind tunnel.

**Hull exterior**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `hull.fill` (deck) | `#f0f0f0` | white gel-coat |
| `hull.stroke` (gunwale) | `#1a1a1a` | black trim line |
| `hull.side` (topsides) | `#e8ecf0` | cool white |
| `hull.bottom` (antifouling) | `#0c1822` | near-black navy |

**Deck zones**

| Zone | Color | Notes |
| ---- | ----- | ----- |
| foredeck | `#d8d8d8` | light gel-coat |
| cockpit | `#4a4a4a` | graphite nonskid sole |
| bench | `#2e2e2e` | dark carbon |
| bulkhead | `#1a1a1a` | carbon black |
| companionway | `#050505` | black opening |

**Rig, foils, and fittings**

| Field | Color | Notes |
| ----- | ----- | ----- |
| `keel.color` / `rudder.color` | `#1a1a1a` | black foils |
| `rig.colors.mast` | `#888888` | brushed aluminum |
| `rig.colors.boom` | `#2a2a2a` | black boom |
| `mainsail.color` / `jib.color` | `#fafafa` | racing white |
| `mainsheet.ropeColor` | `#ee2222` | racing red |
| `bowsprit.color` | `#2a2a2a` | black sprit |
| `lifelines.tubeColor` | `#cccccc` | stainless |
| `lifelines.wireColor` | `#888888` | steel wire |

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
| `mainsheet.ropeColor` | `#c9a968` | hemp-toned rope |
| `bowsprit.color` | `#775533` | classic wood |
| `lifelines.tubeColor` | `#aaaaaa` | painted alloy |
| `lifelines.wireColor` | `#777777` | weathered wire |

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
| `mainsheet.ropeColor` | `#0a1a40` | navy rope |
| `bowsprit.color` | `#b09030` | gold bowsprit |
| `lifelines.tubeColor` | `#ccccdd` | polished stainless |
| `lifelines.wireColor` | `#999999` | steel wire |

## Applying a brand palette

The palettes above are implemented in [`src/game/boat/configs/brandPalettes.ts`](../src/game/boat/configs/brandPalettes.ts) as `SHAFF_PALETTE`, `BHC_PALETTE`, and `MAESTRO_PALETTE`. Boat configs apply them via `withBrandPalette(baseConfig, palette)` so that individual boat files only carry geometry and physics overrides, never colors. If you add a new boat to an existing brand, use the helper — do not copy colors inline.
