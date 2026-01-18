import { V } from "../../../core/Vector";
import type { Mission } from "../MissionTypes";

/**
 * First Sail - The simplest possible mission.
 * Just sail away from the start point to prove you can move the boat.
 */
export const firstSailMission: Mission = {
  id: "first-sail",
  name: "First Sail",
  description:
    "Prove you can handle the boat by sailing to the marker. Use the wind to your advantage!",
  difficulty: 1,
  category: "training",

  // Position the mission spot near the starting area but not on top of it
  spotPosition: V(50, 50),

  // Always unlocked - this is the entry point
  unlockConditions: [{ type: "always" }],

  // Simple objective: reach a point 100 feet away
  objectives: [
    {
      type: "reach",
      position: V(150, -50),
      radius: 20,
      label: "Destination",
    },
  ],

  // No time limit for the first mission
  timeLimit: undefined,
};
