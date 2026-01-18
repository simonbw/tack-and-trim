import { type VNode } from "preact";
import { ReactEntity } from "../../../core/ReactEntity";
import type { Mission } from "../MissionTypes";
import "./PauseMenu.css";

interface PauseMenuProps {
  /** Currently active mission, if any */
  activeMission?: Mission;
  /** Elapsed time in the active mission */
  elapsedTime?: number;
}

/**
 * Pause menu shown when the game is paused.
 * Includes mission info and controls if a mission is active.
 */
export class PauseMenu extends ReactEntity {
  private props: PauseMenuProps;

  /** Callback when player chooses to resume */
  public onResume?: () => void;
  /** Callback when player chooses to restart mission */
  public onRestartMission?: () => void;
  /** Callback when player chooses to end mission */
  public onEndMission?: () => void;
  /** Callback when player chooses to quit to menu */
  public onQuitToMenu?: () => void;

  constructor(props: PauseMenuProps = {}) {
    super(() => this.renderContent(), false); // Don't auto-render
    this.props = props;
  }

  /** Update the mission info */
  updateMissionInfo(activeMission?: Mission, elapsedTime?: number): void {
    this.props = { activeMission, elapsedTime };
    this.reactRender();
  }

  private renderContent(): VNode {
    const { activeMission, elapsedTime } = this.props;

    return (
      <div className="pause-menu">
        <div className="pause-menu__backdrop" />
        <div className="pause-menu__panel">
          <h1 className="pause-menu__title">Paused</h1>

          <div className="pause-menu__buttons">
            <button
              className="pause-menu__button pause-menu__button--primary"
              onClick={() => this.onResume?.()}
            >
              Resume
            </button>
            <button
              className="pause-menu__button"
              onClick={() => this.onQuitToMenu?.()}
            >
              Quit to Menu
            </button>
          </div>

          {activeMission && (
            <div className="pause-menu__mission-section">
              <div className="pause-menu__mission-header">
                <span className="pause-menu__mission-label">
                  Current Mission
                </span>
                <span className="pause-menu__mission-name">
                  {activeMission.name}
                </span>
              </div>

              {elapsedTime !== undefined && (
                <div className="pause-menu__mission-time">
                  Time: {this.formatTime(elapsedTime)}
                  {activeMission.timeLimit && (
                    <span className="pause-menu__time-limit">
                      {" "}
                      / {this.formatTime(activeMission.timeLimit)}
                    </span>
                  )}
                </div>
              )}

              <div className="pause-menu__mission-buttons">
                <button
                  className="pause-menu__button pause-menu__button--mission"
                  onClick={() => this.onRestartMission?.()}
                >
                  Restart Mission
                </button>
                <button
                  className="pause-menu__button pause-menu__button--mission pause-menu__button--danger"
                  onClick={() => this.onEndMission?.()}
                >
                  End Mission
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  }
}
