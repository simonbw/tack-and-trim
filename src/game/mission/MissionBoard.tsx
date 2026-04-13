/**
 * MissionBoard - overlay UI for viewing and accepting missions at a port.
 *
 * Spawned by PortMenu when the player selects "Mission Board". Displays
 * available missions, the current active mission (if any), and allows
 * the player to accept a new mission.
 */

import { Fragment, type VNode } from "preact";
import { on } from "../../core/entity/handler";
import { KeyCode } from "../../core/io/Keys";
import { Modal } from "../../core/ui/Modal";
import type { MissionDef } from "../../editor/io/LevelFileFormat";
import { MissionManager } from "./MissionManager";
import "./MissionBoard.css";

export class MissionBoard extends Modal {
  private selectedIndex = 0;
  private missions: MissionDef[] = [];
  private manager!: MissionManager;

  constructor(private portId: string) {
    super(() => this.renderContent());
  }

  @on("afterAdded")
  onAfterAdded() {
    this.manager = this.game.entities.getSingleton(MissionManager);
    this.missions = this.manager.getAvailableMissions(this.portId);
  }

  private renderContent() {
    const activeMission = this.manager?.getActiveMission() ?? null;
    const hasActive = activeMission !== null;

    return (
      <div class="mission-board">
        <div class="mission-board__title">Mission Board</div>

        {hasActive && (
          <div class="mission-board__current">
            <div class="mission-board__current-label">Current Mission</div>
            <div class="mission-board__current-card">
              <div class="mission-board__current-name">
                {activeMission.def.name}
              </div>
              <div class="mission-board__current-desc">
                {activeMission.def.description}
              </div>
            </div>
          </div>
        )}

        {this.missions.length === 0 ? (
          <div class="mission-board__empty">
            No missions available at this port
          </div>
        ) : (
          <div class="mission-board__list">
            {this.missions.map((mission, i) => (
              <button
                class={`mission-board__entry ${i === this.selectedIndex ? "mission-board__entry--selected" : ""}`}
                onClick={() => this.acceptMission(i)}
              >
                <div class="mission-board__entry-name">{mission.name}</div>
                <div class="mission-board__entry-desc">
                  {mission.description}
                </div>
                <div class="mission-board__entry-rewards">
                  {this.renderRewards(mission)}
                </div>
              </button>
            ))}
          </div>
        )}

        <div class="mission-board__hint">
          {this.missions.length > 0 && !hasActive
            ? "Enter to accept / Esc to go back"
            : "Esc to go back"}
        </div>
      </div>
    );
  }

  private renderRewards(mission: MissionDef): VNode {
    const rewards = mission.rewards;
    return (
      <Fragment>
        {rewards?.money ? (
          <span class="mission-board__reward mission-board__reward-money">
            ${rewards.money}
          </span>
        ) : null}
        {rewards?.revealPorts && rewards.revealPorts.length > 0 ? (
          <span class="mission-board__reward mission-board__reward-ports">
            Reveals {rewards.revealPorts.length}{" "}
            {rewards.revealPorts.length === 1 ? "port" : "ports"}
          </span>
        ) : null}
      </Fragment>
    );
  }

  private acceptMission(index: number) {
    const activeMission = this.manager.getActiveMission();
    if (activeMission !== null) return; // Already have an active mission

    const mission = this.missions[index];
    if (!mission) return;

    this.manager.acceptMission(mission.id);
    this.destroy();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (this.missions.length === 0) return;

    if (key === "ArrowUp" || key === "ArrowLeft") {
      this.selectedIndex =
        (this.selectedIndex - 1 + this.missions.length) % this.missions.length;
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      this.selectedIndex = (this.selectedIndex + 1) % this.missions.length;
    } else if (key === "Enter" || key === "Space") {
      this.acceptMission(this.selectedIndex);
    }
  }
}
