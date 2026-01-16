import type { VNode } from "preact";
import { ReactEntity } from "../../core/ReactEntity";
import type { TutorialStep } from "./TutorialStep";
import "./TutorialPopup.css";

interface TutorialPopupProps {
  step: TutorialStep;
  stepIndex: number;
  totalSteps: number;
}

/**
 * Tutorial popup UI component.
 * Renders a styled text box with title, description, objective, and progress.
 */
export class TutorialPopup extends ReactEntity {
  private props: TutorialPopupProps;
  private isExiting = false;

  constructor(props: TutorialPopupProps) {
    super(() => this.renderContent());
    this.props = props;
  }

  /** Update the popup with new step data */
  updateStep(step: TutorialStep, stepIndex: number): void {
    this.props = { ...this.props, step, stepIndex };
    this.isExiting = false;
    this.reactRender();
  }

  /** Begin exit animation */
  startExit(): void {
    this.isExiting = true;
    this.reactRender();
  }

  private renderContent(): VNode {
    const { step, stepIndex, totalSteps } = this.props;

    const popupClass = this.isExiting
      ? "tutorial-popup tutorial-popup--exiting"
      : "tutorial-popup";

    return (
      <div className={popupClass}>
        <h2 className="tutorial-title">{step.title}</h2>
        <p className="tutorial-description">{step.description}</p>

        <div className="tutorial-objective">
          <div className="tutorial-objective__label">Objective</div>
          <div className="tutorial-objective__text">{step.objective}</div>
        </div>

        {step.keyHint && (
          <div className="tutorial-keyhint">
            <span className="tutorial-keyhint__label">Press</span>
            {this.renderKeyHint(step.keyHint)}
          </div>
        )}

        <div className="tutorial-progress">
          {Array.from({ length: totalSteps }, (_, i) => {
            let dotClass = "tutorial-progress__dot";
            if (i < stepIndex) {
              dotClass += " tutorial-progress__dot--completed";
            } else if (i === stepIndex) {
              dotClass += " tutorial-progress__dot--current";
            }
            return <div key={i} className={dotClass} />;
          })}
        </div>
      </div>
    );
  }

  private renderKeyHint(hint: string): VNode {
    // Split by " / " to handle things like "A / D"
    const keys = hint.split(" / ");
    return (
      <>
        {keys.map((key, i) => (
          <>
            {i > 0 && <span className="tutorial-keyhint__label"> or </span>}
            <kbd className="tutorial-key">{key.trim()}</kbd>
          </>
        ))}
      </>
    );
  }
}
