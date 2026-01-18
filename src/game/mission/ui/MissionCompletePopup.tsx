import { type VNode } from "preact";
import { ReactEntity } from "../../../core/ReactEntity";
import type { Mission } from "../MissionTypes";
import "./MissionCompletePopup.css";

interface MissionCompletePopupProps {
  mission: Mission;
  success: boolean;
  time: number;
  bestTime?: number;
  failReason?: string;
}

/**
 * Popup shown when a mission ends (success or failure).
 */
export class MissionCompletePopup extends ReactEntity {
  private props: MissionCompletePopupProps;
  private isExiting = false;

  /** Callback when player chooses to retry */
  public onRetry?: () => void;
  /** Callback when player chooses to leave */
  public onLeave?: () => void;

  constructor(props: MissionCompletePopupProps) {
    super(() => this.renderContent(), false); // Don't auto-render
    this.props = props;
  }

  /** Begin exit animation */
  startExit(): void {
    this.isExiting = true;
    this.reactRender();
  }

  private renderContent(): VNode {
    const { mission, success, time, bestTime, failReason } = this.props;

    const popupClass = this.isExiting
      ? "mission-complete mission-complete--exiting"
      : "mission-complete";

    const statusClass = success
      ? "mission-complete--success"
      : "mission-complete--failure";

    return (
      <div className={`${popupClass} ${statusClass}`}>
        <div className="mission-complete__header">
          {success ? (
            <span className="mission-complete__icon">✓</span>
          ) : (
            <span className="mission-complete__icon mission-complete__icon--fail">
              ✗
            </span>
          )}
          <h2 className="mission-complete__title">
            {success ? "Mission Complete!" : "Mission Failed"}
          </h2>
        </div>

        <div className="mission-complete__mission-name">{mission.name}</div>

        {!success && failReason && (
          <div className="mission-complete__reason">{failReason}</div>
        )}

        <div className="mission-complete__stats">
          <div className="mission-complete__stat">
            <span className="mission-complete__stat-label">Time</span>
            <span className="mission-complete__stat-value">
              {this.formatTime(time)}
            </span>
          </div>

          {success && bestTime !== undefined && (
            <div className="mission-complete__stat">
              <span className="mission-complete__stat-label">Best</span>
              <span className="mission-complete__stat-value">
                {this.formatTime(bestTime)}
                {time <= bestTime && (
                  <span className="mission-complete__new-record">NEW!</span>
                )}
              </span>
            </div>
          )}
        </div>

        <div className="mission-complete__actions">
          <button
            className="mission-complete__button mission-complete__button--retry"
            onClick={() => this.onRetry?.()}
          >
            {success ? "Play Again" : "Retry"}
          </button>
          <button
            className="mission-complete__button mission-complete__button--leave"
            onClick={() => this.onLeave?.()}
          >
            Leave
          </button>
        </div>
      </div>
    );
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, "0")}.${ms.toString().padStart(2, "0")}`;
  }
}
