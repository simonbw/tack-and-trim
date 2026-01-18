import { MissionRegistry } from "../MissionRegistry";
import { firstSailMission } from "./first-sail";
import { buoyRunMission } from "./buoy-run";

/**
 * Register all missions.
 * This function should be called once at startup before the MissionManager is created.
 */
export function registerAllMissions(): void {
  MissionRegistry.register(firstSailMission);
  MissionRegistry.register(buoyRunMission);
}

// Export individual missions for direct access if needed
export { firstSailMission } from "./first-sail";
export { buoyRunMission } from "./buoy-run";
