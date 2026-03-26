import { BoatConfig, createBoatConfig } from "../boat/BoatConfig";
import { BoatDef, getUpgradeDef } from "./BoatCatalog";

/**
 * Compute the effective BoatConfig for a boat definition with upgrades applied.
 * Upgrades are applied in order, each one receiving the current config state
 * so that multiplicative upgrades compound correctly.
 */
export function computeEffectiveConfig(
  boatDef: BoatDef,
  upgradeIds: string[],
): BoatConfig {
  let config = boatDef.baseConfig;

  for (const id of upgradeIds) {
    const upgrade = getUpgradeDef(id);
    if (upgrade) {
      const overrides = upgrade.applyToConfig(config);
      config = createBoatConfig(config, overrides);
    }
  }

  return config;
}
