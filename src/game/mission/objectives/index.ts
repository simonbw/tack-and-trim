import type { ObjectiveDefinition } from "../MissionTypes";
import type { ObjectiveChecker } from "./ObjectiveChecker";
import { ReachObjectiveChecker } from "./ReachObjective";

export { ObjectiveChecker, ObjectiveCheckResult } from "./ObjectiveChecker";
export { ReachObjectiveChecker } from "./ReachObjective";

/**
 * Create the appropriate ObjectiveChecker for a given objective definition.
 */
export function createObjectiveChecker(
  definition: ObjectiveDefinition
): ObjectiveChecker {
  switch (definition.type) {
    case "reach":
      return new ReachObjectiveChecker(definition);

    case "checkpoint":
      // TODO: Implement CheckpointObjectiveChecker
      throw new Error("Checkpoint objectives not yet implemented");

    case "gate":
      // TODO: Implement GateObjectiveChecker
      throw new Error("Gate objectives not yet implemented");

    case "speed":
      // TODO: Implement SpeedObjectiveChecker
      throw new Error("Speed objectives not yet implemented");

    case "heading":
      // TODO: Implement HeadingObjectiveChecker
      throw new Error("Heading objectives not yet implemented");

    case "survival":
      // TODO: Implement SurvivalObjectiveChecker
      throw new Error("Survival objectives not yet implemented");

    default:
      // Exhaustiveness check
      const _exhaustive: never = definition;
      throw new Error(`Unknown objective type`);
  }
}
