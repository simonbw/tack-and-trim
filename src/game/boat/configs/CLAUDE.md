# Boat Configs (`src/game/boat/configs/`)

Concrete `BoatConfig` data for every sailable boat. Parent docs in [`../CLAUDE.md`](../CLAUDE.md) cover the runtime physics/rendering — this file covers how a config is put together.

## Files in this folder

- **`Kestrel.ts`** — the 22ft reference hull. Defines complete geometry, deck plan zones, rigging attachment points, damage models, tilt/buoyancy — everything. Every other config starts from Kestrel.
- **`configScale.ts`** — `scaleBoatConfig(base, sx, sy, sz)` returns a geometrically scaled copy of a base config. Only dimensions scale; masses, inertias, damping, and righting coefficients are *not* scaled and must be supplied per boat.
- **`brandPalettes.ts`** — brand color palettes (`SHAFF_PALETTE`, `BHC_PALETTE`, `MAESTRO_PALETTE`) and `withBrandPalette(base, palette)`, which returns a new base config with hull, deck zones, foils, rig, sails, sheet, bowsprit, and lifelines recolored to match the brand.
- **`Shaff*.ts`, `Bhc*.ts`, `Maestro*.ts`** — one file per boat model. Each defines an instance via `createBoatConfig(base, overrides)`.

## The config pipeline

A typical boat file composes three layers, from inside out:

1. **`scaleBoatConfig(Kestrel, sx, sy, sz)`** — stretches Kestrel's geometry to the target size class. Skip this for boats at or very near Kestrel's 22.5ft LOA.
2. **`withBrandPalette(..., BRAND_PALETTE)`** — applies the brand's color scheme. This is the *only* place colors should come from; per-boat files must not set any color fields directly.
3. **`createBoatConfig(..., { physics overrides })`** — deep-merges the per-boat mass, draft, inertia, damping, righting coefficients, skin friction, and performance tweaks.

```ts
export const BhcWeekender = createBoatConfig(
  withBrandPalette(scaleBoatConfig(Kestrel, sx, sy, sz), BHC_PALETTE),
  {
    hull: { mass: 5100, skinFrictionCoefficient: 0.0033 },
    keel: { draft: 5.25 },
    rudder: { draft: 4.0, steerAdjustSpeed: 0.65, steerAdjustSpeedFast: 1.6 },
    // ...tilt, buoyancy, hullDamage, etc.
  },
);
```

## Conventions

- **Do not set colors per boat.** Hull colors, deck zone colors, foil colors, rig colors, sail colors, rope colors, bowsprit color, and lifeline colors all come from the brand palette. If a boat is "special" enough to want a unique color, add a new palette — don't leak colors into the boat file.
- **Scale geometry, override physics.** `scaleBoatConfig` stretches geometry but not physics. Mass, inertia, righting coefficients, damping, draft, and damage rates must all come from the per-boat overrides block. Sailor station positions are scaled geometrically.
- **Sailor stations are inherited.** Kestrel defines the default 3-station layout (Helm, Mast, Bow) with axis bindings and actions. All derived configs inherit these via `scaleBoatConfig` (positions scaled) and `createBoatConfig` (deep merge). Per-boat overrides can add, remove, or relocate stations.
- **Inspiration comments.** Each boat's docstring cites a real-world boat (J/22, Catalina 30, Swan 60, etc.) with LOA, displacement, and sail area. Use the same format when adding a new model so physics values are justifiable.
- **Deep merge caveat.** `createBoatConfig` uses `deepMerge`, which replaces arrays wholesale. That's why the brand palette rewrites `hull.deckPlan.zones` through `withBrandPalette` rather than letting configs splice individual zones.

## Recommended reading

- **[`docs/boat-brands.md`](../../../../docs/boat-brands.md)** — the brand identity and full color style guide. Read this before adjusting any visual aspect of a boat or adding a new one.
- **[`../CLAUDE.md`](../CLAUDE.md)** — runtime physics, tilt system, force model, hull mesh construction.
- **[`../BoatConfig.ts`](../BoatConfig.ts)** — the authoritative type for everything a config can contain.
