import { V } from "../../../core/Vector";
import type { Mission } from "../MissionTypes";

/**
 * Buoy Run - Sail to a distant buoy and back.
 * Teaches players to navigate longer distances.
 */
export const buoyRunMission: Mission = {
  id: "buoy-run",
  name: "Buoy Run",
  description:
    "Sail out to the red buoy and return to the starting area. Test your navigation skills!",
  difficulty: 2,
  category: "training",

  // Position near the existing buoy at (200, 0)
  spotPosition: V(-50, 80),

  // Requires completing the first mission
  unlockConditions: [{ type: "missionComplete", missionId: "first-sail" }],

  // Two objectives: reach the buoy, then return
  objectives: [
    {
      type: "reach",
      position: V(200, 0),
      radius: 25,
      label: "Red Buoy",
    },
    {
      type: "reach",
      position: V(0, 0),
      radius: 30,
      label: "Return to Start",
    },
  ],

  // 5 minute time limit
  timeLimit: 300,
};
