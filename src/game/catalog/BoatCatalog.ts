import { DeepPartial } from "../../core/util/ObjectUtils";
import { BoatConfig } from "../boat/BoatConfig";
import { BhcDaysailer } from "../boat/configs/BhcDaysailer";
import { BhcExpedition } from "../boat/configs/BhcExpedition";
import { BhcJourney } from "../boat/configs/BhcJourney";
import { BhcWeekender } from "../boat/configs/BhcWeekender";
import { MaestroEtude } from "../boat/configs/MaestroEtude";
import { MaestroFantasia } from "../boat/configs/MaestroFantasia";
import { MaestroOpus } from "../boat/configs/MaestroOpus";
import { MaestroTrio } from "../boat/configs/MaestroTrio";
import { ShaffS11 } from "../boat/configs/ShaffS11";
import { ShaffS15 } from "../boat/configs/ShaffS15";
import { ShaffS20 } from "../boat/configs/ShaffS20";
import { ShaffS7 } from "../boat/configs/ShaffS7";

// ============================================
// Display Stats (simplified ratings for UI)
// ============================================

export interface DisplayStats {
  readonly speed: number; // 1-10
  readonly stability: number; // 1-10
  readonly durability: number; // 1-10
  readonly maneuverability: number; // 1-10
}

// ============================================
// Boat Definition
// ============================================

export interface BoatDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly baseConfig: BoatConfig;
  readonly displayStats: DisplayStats;
  readonly availableUpgrades: string[];
}

// ============================================
// Upgrade Definition
// ============================================

export interface UpgradeDef {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  readonly applyToConfig: (config: BoatConfig) => DeepPartial<BoatConfig>;
}

// ============================================
// Upgrade Definitions
// ============================================

export const UPGRADE_DEFS: readonly UpgradeDef[] = [
  {
    id: "reinforced-hull",
    name: "Reinforced Hull",
    description:
      "Fiberglass reinforcement on the hull bottom. Halves damage from groundings.",
    cost: 150,
    applyToConfig: (config) => ({
      hullDamage: {
        groundingDamageRate: config.hullDamage.groundingDamageRate * 0.5,
      },
    }),
  },
  {
    id: "bilge-pump",
    name: "Bilge Pump",
    description:
      "An electric bilge pump that automatically drains water from the cockpit.",
    cost: 100,
    applyToConfig: () => ({
      bilge: {
        pumpDrainRate: 0.3,
      },
    }),
  },
  {
    id: "better-oars",
    name: "Better Oars",
    description:
      "Longer, lighter oars with better blade shape. 50% more rowing force.",
    cost: 75,
    applyToConfig: (config) => ({
      rowing: {
        force: config.rowing.force * 1.5,
      },
    }),
  },
  {
    id: "deeper-keel",
    name: "Deeper Keel",
    description:
      "Extended keel for better lateral resistance and pointing ability.",
    cost: 200,
    applyToConfig: (config) => ({
      keel: {
        draft: config.keel.draft * 1.3,
      },
    }),
  },
  {
    id: "racing-sails",
    name: "Racing Sails",
    description:
      "High-performance laminate sails with better shape and less drag.",
    cost: 300,
    applyToConfig: () => ({
      rig: {
        mainsail: {
          liftScale: 1.15,
          dragScale: 0.9,
        },
      },
    }),
  },
];

// ============================================
// Boat Definitions
// ============================================

export const BOAT_DEFS: readonly BoatDef[] = [
  // ---- Shaff ----
  {
    id: "shaff-s7",
    name: "Shaff S-7",
    description:
      "A pure one-design racer built for speed over everything else. Tender and demanding — the boat teaches you to sail by punishing mistakes and rewarding precision.",
    cost: 0,
    baseConfig: ShaffS7,
    displayStats: { speed: 7, stability: 3, durability: 4, maneuverability: 8 },
    availableUpgrades: ["reinforced-hull", "bilge-pump", "racing-sails"],
  },
  {
    id: "shaff-s11",
    name: "Shaff S-11",
    description:
      "Stiff, fast, and unforgiving. The J/105-inspired S-11 carries her sail better than you'd expect and rewards aggressive upwind tactics. One-design fleet racing at its best.",
    cost: 800,
    baseConfig: ShaffS11,
    displayStats: { speed: 8, stability: 5, durability: 4, maneuverability: 7 },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "deeper-keel",
      "racing-sails",
    ],
  },
  {
    id: "shaff-s15",
    name: "Shaff S-15",
    description:
      "An offshore race boat that'll push your crew to their limits. Enormous sail plan, fine entry, and a deep fin keel. When the wind pipes up, she comes alive.",
    cost: 3500,
    baseConfig: ShaffS15,
    displayStats: { speed: 9, stability: 5, durability: 4, maneuverability: 6 },
    availableUpgrades: ["reinforced-hull", "bilge-pump", "racing-sails"],
  },
  {
    id: "shaff-s20",
    name: "Shaff S-20",
    description:
      "The flagship Shaff. A grand-prix offshore racer that demands a professional crew and rewards them with astonishing speed. Not for the faint-hearted.",
    cost: 12000,
    baseConfig: ShaffS20,
    displayStats: {
      speed: 10,
      stability: 4,
      durability: 5,
      maneuverability: 5,
    },
    availableUpgrades: ["reinforced-hull", "racing-sails"],
  },

  // ---- BHC ----
  {
    id: "bhc-daysailer",
    name: "BHC Daysailer",
    description:
      "The most forgiving boat on the water. Swing keel, comfortable cockpit, basic sails — everything you need, nothing you don't. Great for learning and lazy afternoons.",
    cost: 0,
    baseConfig: BhcDaysailer,
    displayStats: { speed: 4, stability: 7, durability: 7, maneuverability: 6 },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "better-oars",
      "deeper-keel",
    ],
  },
  {
    id: "bhc-weekender",
    name: "BHC Weekender",
    description:
      "Six thousand hulls built for a reason. Comfortable enough for overnight passages, capable enough for club racing. Practically impossible to embarrass yourself on.",
    cost: 700,
    baseConfig: BhcWeekender,
    displayStats: { speed: 5, stability: 8, durability: 7, maneuverability: 5 },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "better-oars",
      "deeper-keel",
    ],
  },
  {
    id: "bhc-journey",
    name: "BHC Journey",
    description:
      "Built for real passages. Wide, stable, and immensely livable. Not the fastest, but she'll get you there comfortably — and keep everyone sane doing it.",
    cost: 3000,
    baseConfig: BhcJourney,
    displayStats: { speed: 5, stability: 9, durability: 8, maneuverability: 4 },
    availableUpgrades: ["reinforced-hull", "bilge-pump", "better-oars"],
  },
  {
    id: "bhc-expedition",
    name: "BHC Expedition",
    description:
      "Purpose-built for ocean passages. Heavy, supremely stable, built like a brick. The boat you want when the forecast turns bad three days from land.",
    cost: 10000,
    baseConfig: BhcExpedition,
    displayStats: {
      speed: 4,
      stability: 10,
      durability: 9,
      maneuverability: 3,
    },
    availableUpgrades: ["reinforced-hull", "bilge-pump"],
  },

  // ---- Maestro ----
  {
    id: "maestro-etude",
    name: "Maestro Etude",
    description:
      "The smallest Maestro is the most fun. Hand-laid hull, precision-cut sails, and a deeper feel than anything else in the S class. Faster than it looks.",
    cost: 600,
    baseConfig: MaestroEtude,
    displayStats: { speed: 7, stability: 6, durability: 6, maneuverability: 7 },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "deeper-keel",
      "racing-sails",
    ],
  },
  {
    id: "maestro-trio",
    name: "Maestro Trio",
    description:
      "More sail area than any other M-class boat, a beautifully balanced helm, and enough interior to mean something. Fast upwind, composed downwind, impeccably finished.",
    cost: 2800,
    baseConfig: MaestroTrio,
    displayStats: { speed: 8, stability: 7, durability: 6, maneuverability: 6 },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "deeper-keel",
      "racing-sails",
    ],
  },
  {
    id: "maestro-fantasia",
    name: "Maestro Fantasia",
    description:
      "The boat you commission when you've already crossed an ocean and know exactly what you want. More sail than the competition, better stability, and a level of finish that makes everything else feel unfinished.",
    cost: 9000,
    baseConfig: MaestroFantasia,
    displayStats: { speed: 8, stability: 8, durability: 7, maneuverability: 5 },
    availableUpgrades: ["reinforced-hull", "bilge-pump", "racing-sails"],
  },
  {
    id: "maestro-opus",
    name: "Maestro Opus",
    description:
      "The pinnacle of the Maestro lineup. Deep lead keel, carbon-reinforced hull, enough sail area to humble a crew of ten. You do not buy an Opus — you earn one.",
    cost: 28000,
    baseConfig: MaestroOpus,
    displayStats: { speed: 9, stability: 8, durability: 7, maneuverability: 5 },
    availableUpgrades: ["reinforced-hull", "racing-sails"],
  },
];

// ============================================
// Lookup Helpers
// ============================================

export function getBoatDef(id: string): BoatDef | undefined {
  return BOAT_DEFS.find((def) => def.id === id);
}

export function getUpgradeDef(id: string): UpgradeDef | undefined {
  return UPGRADE_DEFS.find((def) => def.id === id);
}
