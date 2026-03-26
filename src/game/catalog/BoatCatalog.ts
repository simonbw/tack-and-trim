import { DeepPartial } from "../../core/util/ObjectUtils";
import { BoatConfig } from "../boat/BoatConfig";
import { StarterDinghy } from "../boat/configs/StarterDinghy";

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
      "A small electric bilge pump that automatically drains water from the cockpit.",
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
    id: "deeper-centerboard",
    name: "Deeper Centerboard",
    description:
      "Extended centerboard for better lateral resistance and pointing ability.",
    cost: 200,
    applyToConfig: (config) => ({
      keel: {
        draft: config.keel.draft * 1.3,
      },
    }),
  },
];

// ============================================
// Boat Definitions
// ============================================

export const BOAT_DEFS: readonly BoatDef[] = [
  {
    id: "starter-dinghy",
    name: "Starter Dinghy",
    description:
      "A typical 16ft sailing dinghy. Good all-around boat for learning and casual sailing.",
    cost: 0,
    baseConfig: StarterDinghy,
    displayStats: {
      speed: 5,
      stability: 4,
      durability: 3,
      maneuverability: 6,
    },
    availableUpgrades: [
      "reinforced-hull",
      "bilge-pump",
      "better-oars",
      "deeper-centerboard",
    ],
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
