import { BoatConfig } from "../BoatConfig";
import { RopePattern } from "../RopeShader";

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
  /**
   * Rope patterns for running rigging and the anchor rode. Each brand picks
   * its own weave so that boats look identifiable up close as well as at
   * silhouette distance.
   */
  ropes: {
    mainsheet: RopePattern;
    jibSheet: RopePattern;
    anchorRode: RopePattern;
    halyard: RopePattern;
  };
  /** Bowsprit spar color. */
  bowsprit: number;
  /** Lifeline stanchion tube + wire colors. */
  lifelines: {
    tube: number;
    wire: number;
  };
}

/** Shaff — performance racing in "Mermaid" livery. Teal topsides / gold trim / racing red, inspired by the Zissou palette. */
export const SHAFF_PALETTE: BrandPalette = {
  hull: {
    fill: 0xffffff, // white deck
    stroke: 0xe1af00, // gold gunwale trim
    side: 0x3b9ab2, // signature mermaid teal topsides
    bottom: 0x1a4552, // deep teal antifouling
  },
  deckZones: {
    foredeck: 0xffffff, // white foredeck
    cockpit: 0x3b9ab2, // medium teal nonskid sole
    bench: 0x1a4552, // dark teal bench
    bulkhead: 0xffffff, // white bulkhead
    companionway: 0x0f3a47, // dark teal opening
  },
  foils: 0x1a4552, // deep teal foils
  rig: {
    mast: 0x888888, // brushed aluminum
    boom: 0xe1af00, // gold boom
  },
  sails: 0xfafafa, // racing white
  ropes: {
    // Racing red 16-plait mainsheet with a pair of white flecks per family.
    mainsheet: {
      type: "braid",
      carriers: [
        0xf21a00, 0xf21a00, 0xffffff, 0xf21a00, 0xf21a00, 0xf21a00, 0xf21a00,
        0xf21a00, 0xf21a00, 0xf21a00, 0xffffff, 0xf21a00, 0xf21a00, 0xf21a00,
        0xf21a00, 0xf21a00,
      ],
      helixAngle: 35,
    },
    // Teal jib sheets with a gold fleck so the windward trim pops.
    jibSheet: {
      type: "braid",
      carriers: [
        0x3b9ab2, 0x3b9ab2, 0xe1af00, 0x3b9ab2, 0x3b9ab2, 0x3b9ab2, 0x3b9ab2,
        0x3b9ab2, 0x3b9ab2, 0x3b9ab2, 0xe1af00, 0x3b9ab2, 0x3b9ab2, 0x3b9ab2,
        0x3b9ab2, 0x3b9ab2,
      ],
      helixAngle: 35,
    },
    // Poolside-yellow-and-teal anchor rode.
    anchorRode: {
      type: "braid",
      carriers: [
        0xebcc2a, 0xebcc2a, 0x3b9ab2, 0x3b9ab2, 0xebcc2a, 0xebcc2a, 0x3b9ab2,
        0x3b9ab2,
      ],
      helixAngle: 40,
    },
    // White halyard with a lightweight red tracer — reads clearly against
    // the teal topsides and matches the racing-red mainsheet at a glance.
    halyard: {
      type: "braid",
      carriers: [
        0xeeeeee, 0xeeeeee, 0xf21a00, 0xeeeeee, 0xeeeeee, 0xeeeeee, 0xeeeeee,
        0xeeeeee, 0xeeeeee, 0xeeeeee, 0xf21a00, 0xeeeeee, 0xeeeeee, 0xeeeeee,
        0xeeeeee, 0xeeeeee,
      ],
      helixAngle: 35,
    },
  },
  bowsprit: 0xe1af00, // gold, matching the gunwale trim
  lifelines: {
    tube: 0xcccccc, // silver stanchion
    wire: 0x888888, // steel wire
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
  ropes: {
    // Classic 3-strand manila mainsheet.
    mainsheet: {
      type: "laid",
      carriers: [0xc9a968, 0xb89050, 0xc9a968],
      helixAngle: 38,
    },
    // Hemp-toned jib sheets with a brown tracer.
    jibSheet: {
      type: "braid",
      carriers: [
        0xd8b878, 0xd8b878, 0x6a4a1a, 0xd8b878, 0xd8b878, 0xd8b878, 0xd8b878,
        0xd8b878, 0xd8b878, 0xd8b878, 0x6a4a1a, 0xd8b878, 0xd8b878, 0xd8b878,
        0xd8b878, 0xd8b878,
      ],
      helixAngle: 35,
    },
    // Tarred marline anchor rode.
    anchorRode: {
      type: "laid",
      carriers: [0x6a4a1a, 0x553818, 0x6a4a1a],
      helixAngle: 42,
    },
    // Classic 3-strand manila halyard — utilitarian cream hemp.
    halyard: {
      type: "laid",
      carriers: [0xd8b878, 0xc9a968, 0xd8b878],
      helixAngle: 38,
    },
  },
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
  ropes: {
    // Deep navy mainsheet with a thin gold tracer.
    mainsheet: {
      type: "braid",
      carriers: [
        0x0a1a40, 0x0a1a40, 0xb09030, 0x0a1a40, 0x0a1a40, 0x0a1a40, 0x0a1a40,
        0x0a1a40, 0x0a1a40, 0x0a1a40, 0xb09030, 0x0a1a40, 0x0a1a40, 0x0a1a40,
        0x0a1a40, 0x0a1a40,
      ],
      helixAngle: 32,
    },
    // Ivory jib sheets with a navy fleck.
    jibSheet: {
      type: "braid",
      carriers: [
        0xf4f2ee, 0xf4f2ee, 0x0a1a40, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee,
        0xf4f2ee, 0xf4f2ee, 0xf4f2ee, 0x0a1a40, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee,
        0xf4f2ee, 0xf4f2ee,
      ],
      helixAngle: 32,
    },
    // Navy-and-gold anchor rode, ostentatious by design.
    anchorRode: {
      type: "braid",
      carriers: [
        0x0a1a40, 0x0a1a40, 0xb09030, 0xb09030, 0x0a1a40, 0x0a1a40, 0xb09030,
        0xb09030,
      ],
      helixAngle: 40,
    },
    // Ivory halyard with a fine gold tracer — matches the mainsheet trim.
    halyard: {
      type: "braid",
      carriers: [
        0xf4f2ee, 0xf4f2ee, 0xb09030, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee,
        0xf4f2ee, 0xf4f2ee, 0xf4f2ee, 0xb09030, 0xf4f2ee, 0xf4f2ee, 0xf4f2ee,
        0xf4f2ee, 0xf4f2ee,
      ],
      helixAngle: 32,
    },
  },
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
      ropeColor: palette.ropes.mainsheet.carriers[0],
      ropePattern: palette.ropes.mainsheet,
    },
    jibSheet: base.jibSheet
      ? {
          ...base.jibSheet,
          ropeColor: palette.ropes.jibSheet.carriers[0],
          ropePattern: palette.ropes.jibSheet,
        }
      : undefined,
    anchor: {
      ...base.anchor,
      ropePattern: palette.ropes.anchorRode,
    },
    halyard: {
      ...base.halyard,
      ropeColor: palette.ropes.halyard.carriers[0],
      ropePattern: palette.ropes.halyard,
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
