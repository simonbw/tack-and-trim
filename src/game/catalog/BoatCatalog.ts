import { DeepPartial } from "../../core/util/ObjectUtils";
import { BoatConfig } from "../boat/BoatConfig";
import { Kestrel } from "../boat/configs/Kestrel";
import { Osprey } from "../boat/configs/Osprey";
import { Albatross } from "../boat/configs/Albatross";

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
        pumpDrainRate: 0.3, // cubic ft/s
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
  {
    id: "kestrel",
    name: "Kestrel",
    description:
      "A nimble 22ft daysailer with a swing keel. Responsive and forgiving — a great boat to learn on.",
    cost: 0,
    baseConfig: Kestrel,
    displayStats: {
      speed: 5,
      stability: 5,
      durability: 4,
      maneuverability: 7,
    },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "better-oars",
      "deeper-keel",
    ],
  },
  {
    id: "osprey",
    name: "Osprey",
    description:
      "A fast 26ft sportboat with a fin keel. More power and stability, rewarding aggressive sailing.",
    cost: 500,
    baseConfig: Osprey,
    displayStats: {
      speed: 7,
      stability: 6,
      durability: 5,
      maneuverability: 5,
    },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "deeper-keel",
      "racing-sails",
    ],
  },
  {
    id: "albatross",
    name: "Albatross",
    description:
      "A powerful 40ft performance cruiser with a deep fin keel. Very stable and fast, but demands planning ahead.",
    cost: 2000,
    baseConfig: Albatross,
    displayStats: {
      speed: 8,
      stability: 9,
      durability: 8,
      maneuverability: 3,
    },
    availableUpgrades: ["reinforced-hull", "bilge-pump", "racing-sails"],
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
