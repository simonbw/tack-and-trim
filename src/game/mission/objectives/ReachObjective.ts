import type { MissionContext } from "../MissionContext";
import type { ReachObjectiveDefinition, ObjectiveState } from "../MissionTypes";
import type { ObjectiveChecker, ObjectiveCheckResult } from "./ObjectiveChecker";

/**
 * Checker for "reach a location" objectives.
 * Complete when the boat enters the target radius.
 */
export class ReachObjectiveChecker implements ObjectiveChecker {
  private complete: boolean = false;
  private closestDistance: number = Infinity;

  constructor(private definition: ReachObjectiveDefinition) {}

  check(context: MissionContext): ObjectiveCheckResult {
    if (this.complete) {
      return { status: "complete" };
    }

    const boatPosition = context.boat.body.getPosition();
    const targetPosition = this.definition.position;
    const distance = boatPosition.distanceTo(targetPosition);

    // Track closest approach for progress indication
    if (distance < this.closestDistance) {
      this.closestDistance = distance;
    }

    if (distance <= this.definition.radius) {
      this.complete = true;
      return { status: "complete" };
    }

    // Return progress as a value between 0 and 1
    // We use a reasonable max distance for progress calculation
    const maxProgressDistance = 500; // feet
    const progress = Math.max(0, 1 - distance / maxProgressDistance);

    return { status: "incomplete", progress };
  }

  reset(): void {
    this.complete = false;
    this.closestDistance = Infinity;
  }

  getState(): ObjectiveState {
    return {
      complete: this.complete,
      progress: this.complete ? 1 : Math.max(0, 1 - this.closestDistance / 500),
    };
  }

  /**
   * Get the target position for UI display.
   */
  getTargetPosition() {
    return this.definition.position;
  }

  /**
   * Get the target radius for UI display.
   */
  getTargetRadius() {
    return this.definition.radius;
  }

  /**
   * Get the optional label for this objective.
   */
  getLabel() {
    return this.definition.label;
  }
}
