import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Boat } from "../boat/Boat";
import { WindInfo } from "../world-data/wind/WindInfo";
import { TutorialPopup } from "./TutorialPopup";
import type { TutorialContext } from "./TutorialStep";
import { tutorialSteps } from "./tutorialSteps";

/** Delay before advancing to next step (allows exit animation) */
const STEP_TRANSITION_DELAY = 0.3;

/**
 * Tutorial manager entity.
 * Coordinates tutorial flow, tracks progress, and manages the popup UI.
 */
export class TutorialManager extends BaseEntity {
  id = "tutorialManager";

  private currentStepIndex = 0;
  private popup: TutorialPopup | null = null;
  private context: TutorialContext | null = null;
  private transitionTimer = 0;
  private isTransitioning = false;
  private isComplete = false;

  @on("afterAdded")
  onAfterAdded(): void {
    // Get references to boat and wind
    const boat = this.game!.entities.getById("boat") as Boat | undefined;
    if (!boat) {
      console.warn("TutorialManager: Could not find boat");
      this.destroy();
      return;
    }
    const windInfo = WindInfo.fromGame(this.game!);

    // Initialize context
    const startPos = boat.getPosition().clone();
    this.context = {
      boat,
      windInfo,
      stepStartPosition: startPos,
      stepStartHeading: boat.hull.body.angle,
      stepStartMainsheetPosition: boat.mainsheet.getSheetPosition(),
      stepStartTack: "port", // Will be set properly on tacking step
      tutorialStartPosition: startPos,
    };

    // Start the first step
    this.startStep(0);
  }

  private startStep(index: number): void {
    if (index >= tutorialSteps.length) {
      this.completeTutorial();
      return;
    }

    this.currentStepIndex = index;
    const step = tutorialSteps[index];

    // Update context for this step
    if (this.context) {
      const boat = this.context.boat;
      this.context.stepStartPosition = boat.getPosition().clone();
      this.context.stepStartHeading = boat.hull.body.angle;
      this.context.stepStartMainsheetPosition =
        boat.mainsheet.getSheetPosition();
    }

    // Call step's onStart callback if defined
    if (step.onStart && this.context) {
      step.onStart(this.context);
    }

    // Create or update popup
    if (!this.popup) {
      this.popup = this.game!.addEntity(
        new TutorialPopup({
          step,
          stepIndex: index,
          totalSteps: tutorialSteps.length,
        }),
      );
    } else {
      this.popup.updateStep(step, index);
    }

    this.isTransitioning = false;
  }

  private advanceToNextStep(): void {
    if (this.isTransitioning) return;

    const step = tutorialSteps[this.currentStepIndex];

    // Dispatch step complete event
    this.game!.dispatch("tutorialStepComplete", {
      stepIndex: this.currentStepIndex,
      stepTitle: step.title,
    });

    // Start exit animation
    this.popup?.startExit();
    this.isTransitioning = true;
    this.transitionTimer = STEP_TRANSITION_DELAY;
  }

  private completeTutorial(): void {
    this.isComplete = true;

    // Dispatch tutorial complete event
    this.game!.dispatch("tutorialComplete", {});

    // Clean up
    if (this.popup) {
      this.popup.destroy();
      this.popup = null;
    }

    // Destroy self
    this.destroy();
  }

  @on("tick")
  onTick(dt: number): void {
    if (this.isComplete || !this.context) return;

    // Handle transition timer
    if (this.isTransitioning) {
      this.transitionTimer -= dt;
      if (this.transitionTimer <= 0) {
        this.startStep(this.currentStepIndex + 1);
      }
      return;
    }

    // Check if current step is complete
    const step = tutorialSteps[this.currentStepIndex];
    if (step.checkComplete(this.context)) {
      this.advanceToNextStep();
    }
  }

  @on("destroy")
  onDestroy(): void {
    // Clean up popup if still exists
    if (this.popup) {
      this.popup.destroy();
      this.popup = null;
    }
  }
}
