import type { MissionContext } from "../MissionContext";
import type { ObjectiveDefinition, ObjectiveState } from "../MissionTypes";

/**
 * Result of checking an objective.
 */
export type ObjectiveCheckResult =
  | { status: "incomplete"; progress?: number }
  | { status: "complete" }
  | { status: "failed"; reason: string };

/**
 * Interface for objective validation logic.
 * Each objective type has a corresponding checker implementation.
 */
export interface ObjectiveChecker {
  /**
   * Check the current state of the objective.
   * Called every tick while the objective is active.
   */
  check(context: MissionContext): ObjectiveCheckResult;

  /**
   * Reset the checker to its initial state.
   * Called when restarting a mission.
   */
  reset(): void;

  /**
   * Get the current state for UI/persistence.
   */
  getState(): ObjectiveState;
}

/**
 * Factory function type for creating objective checkers.
 */
export type ObjectiveCheckerFactory = (
  definition: ObjectiveDefinition
) => ObjectiveChecker;
