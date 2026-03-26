/**
 * MissionHUD - always-visible HUD element showing the current mission objective,
 * plus a temporary "Mission Complete" notification when a mission finishes.
 */

import { ReactEntity } from "../../core/ReactEntity";
import { on } from "../../core/entity/handler";
import { MissionManager } from "./MissionManager";
import "./MissionHUD.css";

const COMPLETION_DISPLAY_SECONDS = 4;

interface CompletionNotice {
  missionName: string;
  money?: number;
  revealPorts?: string[];
  timeRemaining: number;
}

export class MissionHUD extends ReactEntity {
  renderLayer = "hud" as const;
  private completionNotice: CompletionNotice | null = null;

  constructor() {
    super(() => this.renderContent());
  }

  @on("missionCompleted")
  onMissionCompleted({
    missionId,
    rewards,
  }: {
    missionId: string;
    rewards: { money?: number; revealPorts?: string[] };
  }) {
    // Look up the mission name from the MissionManager
    const manager = this.game?.entities.tryGetSingleton(MissionManager) ?? null;
    const def = manager?.getMissionDef(missionId);

    this.completionNotice = {
      missionName: def?.name ?? missionId,
      money: rewards.money,
      revealPorts: rewards.revealPorts,
      timeRemaining: COMPLETION_DISPLAY_SECONDS,
    };
  }

  @on("tick")
  onTick({ dt }: { dt: number }) {
    if (this.completionNotice) {
      this.completionNotice.timeRemaining -= dt;
      if (this.completionNotice.timeRemaining <= 0) {
        this.completionNotice = null;
      }
    }
  }

  private renderContent() {
    const manager = this.game?.entities.tryGetSingleton(MissionManager) ?? null;
    const active = manager?.getActiveMission() ?? null;

    return (
      <div className="mission-hud">
        {this.completionNotice && this.renderCompletion(this.completionNotice)}
        {active && this.renderObjective(active)}
      </div>
    );
  }

  private renderCompletion(notice: CompletionNotice) {
    const fading = notice.timeRemaining < 1;
    return (
      <div
        className={`mission-hud__completion ${fading ? "mission-hud__completion--fading" : ""}`}
      >
        <div className="mission-hud__completion-header">Mission Complete</div>
        <div className="mission-hud__completion-name">{notice.missionName}</div>
        {notice.money && (
          <div className="mission-hud__completion-reward">
            +{notice.money} gold
          </div>
        )}
      </div>
    );
  }

  private renderObjective(active: {
    def: {
      name: string;
      type: string;
      destinationPortId?: string;
      description: string;
    };
  }) {
    const objectiveText =
      active.def.type === "delivery" && active.def.destinationPortId
        ? `Sail to ${this.getPortName(active.def.destinationPortId)}`
        : active.def.description;

    return (
      <div className="mission-hud__panel">
        <div className="mission-hud__title">{active.def.name}</div>
        <div className="mission-hud__objective">
          {"\u27A4"} {objectiveText}
        </div>
      </div>
    );
  }

  private getPortName(portId: string): string {
    const portEntity = this.game?.entities.getById(portId);
    if (portEntity && "getName" in portEntity) {
      return (portEntity as { getName(): string }).getName();
    }
    return portId;
  }
}
