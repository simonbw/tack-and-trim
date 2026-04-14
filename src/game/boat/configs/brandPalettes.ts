import { BoatConfig } from "../BoatConfig";

/**
 * Color palette shared by every boat in a given brand. Applied via
 * {@link withBrandPalette} before per-boat physics overrides. See
 * `docs/boat-brands.md` for the brand style guide.
 */
export interface BrandPalette {
  /** Hull exterior colors (matches {@link BoatConfig.hull.colors}). */
  hull: {
    /** Deck top surface. */
    fill: number;
    /** Gunwale / deck-edge trim line. */
    stroke: number;
    /** Topsides (above waterline). */
    side: number;
    /** Antifouling (below waterline). */
    bottom: number;
  };
  /** Interior deck zone colors, keyed by the zone roles from the base config. */
  deckZones: {
    foredeck: number;
    cockpit: number;
    bench: number;
    bulkhead: number;
    companionway: number;
  };
  /** Keel + rudder blade color. */
  foils: number;
  /** Mast + boom colors. */
  rig: {
    mast: number;
    boom: number;
  };
  /** Mainsail + jib cloth color. */
  sails: number;
  /** Mainsheet rope base color. */
  mainsheet: number;
  /** Bowsprit spar color. */
  bowsprit: number;
  /** Lifeline stanchion tube + wire colors. */
  lifelines: {
    tube: number;
    wire: number;
  };
}

/** Shaff — performance racing. Minimalist white / carbon / racing red. */
export const SHAFF_PALETTE: BrandPalette = {
  hull: {
    fill: 0xf0f0f0, // white deck
    stroke: 0x1a1a1a, // black trim
    side: 0xe8ecf0, // cool white topsides
    bottom: 0x0c1822, // near-black navy antifouling
  },
  deckZones: {
    foredeck: 0xd8d8d8, // light gel-coat deck
    cockpit: 0x4a4a4a, // graphite nonskid sole
    bench: 0x2e2e2e, // dark carbon bench
    bulkhead: 0x1a1a1a, // carbon black
    companionway: 0x050505, // black opening
  },
  foils: 0x1a1a1a, // black foils
  rig: {
    mast: 0x888888, // brushed aluminum
    boom: 0x2a2a2a, // black boom
  },
  sails: 0xfafafa, // racing white
  mainsheet: 0xee2222, // racing red
  bowsprit: 0x2a2a2a,
  lifelines: {
    tube: 0xcccccc,
    wire: 0x888888,
  },
};

/** BHC — affordable recreational. Warm cream / teak / brown. */
export const BHC_PALETTE: BrandPalette = {
  hull: {
    fill: 0xd8c89c, // warm cream deck
    stroke: 0x6a4a1a, // brown trim
    side: 0xe8dbb0, // light cream topsides
    bottom: 0x4a3018, // dark mahogany
  },
  deckZones: {
    foredeck: 0xc4a46c, // light teak
    cockpit: 0x8a6538, // honey teak nonskid
    bench: 0xa88450, // medium teak bench
    bulkhead: 0x6a4620, // dark teak
    companionway: 0x2a1808, // dark mahogany
  },
  foils: 0x5a4030, // stained wood
  rig: {
    mast: 0xa09080, // tan-gray alloy
    boom: 0x8a6a40, // tan-brown
  },
  sails: 0xeeeedd, // cream Dacron
  mainsheet: 0xc9a968, // hemp-toned rope
  bowsprit: 0x775533, // classic wood
  lifelines: {
    tube: 0xaaaaaa,
    wire: 0x777777,
  },
};

/** Maestro — luxury Italian. Deep navy / gold / ivory. */
export const MAESTRO_PALETTE: BrandPalette = {
  hull: {
    fill: 0xe8e0cc, // ivory deck
    stroke: 0xb09030, // gold trim
    side: 0x162648, // deep navy topsides
    bottom: 0x060b1a, // near-black navy
  },
  deckZones: {
    foredeck: 0xe8e0cc, // ivory foredeck
    cockpit: 0x6a4a28, // varnished teak sole
    bench: 0x8a6236, // honey teak bench
    bulkhead: 0xe8e0cc, // ivory bulkhead
    companionway: 0x0a1028, // navy companionway
  },
  foils: 0x162648, // navy foils
  rig: {
    mast: 0xbbbbcc, // polished silver
    boom: 0xb09030, // gold boom
  },
  sails: 0xf4f2ee, // ivory cloth
  mainsheet: 0x0a1a40, // navy rope
  bowsprit: 0xb09030, // gold bowsprit
  lifelines: {
    tube: 0xccccdd,
    wire: 0x999999,
  },
};

/**
 * Map a deckPlan zone name to its palette color. Falls back to the foredeck
 * color for unrecognized zone names.
 */
function zoneColorFor(name: string, palette: BrandPalette): number {
  if (name === "foredeck") return palette.deckZones.foredeck;
  if (name === "cockpit") return palette.deckZones.cockpit;
  if (name === "companionway") return palette.deckZones.companionway;
  if (name.includes("bench")) return palette.deckZones.bench;
  if (name.includes("bulkhead")) return palette.deckZones.bulkhead;
  return palette.deckZones.foredeck;
}

/**
 * Return a new BoatConfig with the brand palette applied to every visible
 * styling field — hull exterior, deck plan zones, foils, rig, sails, sheet,
 * bowsprit, and lifelines. Geometry and physics are preserved untouched.
 *
 * Use this as the base passed to `createBoatConfig` so that per-boat overrides
 * only need to deal with physics and dimensions, not colors.
 */
export function withBrandPalette(
  base: BoatConfig,
  palette: BrandPalette,
): BoatConfig {
  return {
    ...base,
    hull: {
      ...base.hull,
      colors: { ...palette.hull },
      deckPlan: base.hull.deckPlan
        ? {
            zones: base.hull.deckPlan.zones.map((zone) => {
              const color = zoneColorFor(zone.name, palette);
              return {
                ...zone,
                color,
                wallColor: zone.wallColor !== undefined ? color : undefined,
              };
            }),
          }
        : undefined,
    },
    keel: { ...base.keel, color: palette.foils },
    rudder: { ...base.rudder, color: palette.foils },
    rig: {
      ...base.rig,
      colors: { mast: palette.rig.mast, boom: palette.rig.boom },
      mainsail: { ...base.rig.mainsail, color: palette.sails },
    },
    jib: base.jib ? { ...base.jib, color: palette.sails } : undefined,
    mainsheet: {
      ...base.mainsheet,
      ropeColor: palette.mainsheet,
    },
    bowsprit: base.bowsprit
      ? { ...base.bowsprit, color: palette.bowsprit }
      : undefined,
    lifelines: base.lifelines
      ? {
          ...base.lifelines,
          tubeColor: palette.lifelines.tube,
          wireColor: palette.lifelines.wire,
        }
      : undefined,
  };
}
