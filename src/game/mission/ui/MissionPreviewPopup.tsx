import { type VNode } from "preact";
import { ReactEntity } from "../../../core/ReactEntity";
import type { Mission, MissionDifficulty } from "../MissionTypes";
import { MissionPersistence } from "../MissionPersistence";
import "./MissionPreviewPopup.css";

interface MissionPreviewPopupProps {
  mission: Mission;
  isCompleted: boolean;
  bestTime?: number;
}

/**
 * Popup shown when player is near a mission spot.
 * Displays mission info and prompts to start.
 */
export class MissionPreviewPopup extends ReactEntity {
  private props: MissionPreviewPopupProps;
  private isExiting = false;
  private isVisible = true;

  constructor(props: MissionPreviewPopupProps) {
    super(() => this.renderContent());
    this.props = props;
  }

  /** Update the popup with new mission data */
  updateMission(mission: Mission): void {
    const completion = MissionPersistence.getMissionCompletion(mission.id);
    this.props = {
      mission,
      isCompleted: !!completion,
      bestTime: completion?.bestTime,
    };
    this.isExiting = false;
    this.isVisible = true;
    this.reactRender();
  }

  /** Show the popup */
  show(): void {
    this.isVisible = true;
    this.isExiting = false;
    this.reactRender();
  }

  /** Hide the popup with exit animation */
  hide(): void {
    this.isExiting = true;
    this.reactRender();
    // Actually hide after animation
    setTimeout(() => {
      this.isVisible = false;
      this.reactRender();
    }, 200);
  }

  private renderContent(): VNode {
    if (!this.isVisible) {
      return <div className="mission-preview--hidden" />;
    }

    const { mission, isCompleted, bestTime } = this.props;

    const popupClass = this.isExiting
      ? "mission-preview mission-preview--exiting"
      : "mission-preview";

    return (
      <div className={popupClass}>
        <div className="mission-preview__header">
          <h2 className="mission-preview__title">{mission.name}</h2>
          {isCompleted && (
            <span className="mission-preview__completed">Completed</span>
          )}
        </div>

        <div className="mission-preview__difficulty">
          {this.renderDifficulty(mission.difficulty)}
        </div>

        <p className="mission-preview__description">{mission.description}</p>

        {mission.timeLimit && (
          <div className="mission-preview__info">
            <span className="mission-preview__info-label">Time Limit:</span>
            <span className="mission-preview__info-value">
              {this.formatTime(mission.timeLimit)}
            </span>
          </div>
        )}

        {bestTime !== undefined && (
          <div className="mission-preview__info">
            <span className="mission-preview__info-label">Best Time:</span>
            <span className="mission-preview__info-value">
              {this.formatTime(bestTime)}
            </span>
          </div>
        )}

        <div className="mission-preview__action">
          <kbd className="mission-preview__key">F</kbd>
          <span className="mission-preview__action-text">
            {isCompleted ? "Replay Mission" : "Start Mission"}
          </span>
        </div>
      </div>
    );
  }

  private renderDifficulty(difficulty: MissionDifficulty): VNode {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      const starClass =
        i <= difficulty
          ? "mission-preview__star mission-preview__star--filled"
          : "mission-preview__star";
      stars.push(<span key={i} className={starClass}>★</span>);
    }
    return <div className="mission-preview__stars">{stars}</div>;
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }
}
