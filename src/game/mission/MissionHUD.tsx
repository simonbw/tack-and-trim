/**
 * MissionHUD - always-visible HUD element showing the current mission objective.
 */

import { ReactEntity } from "../../core/ReactEntity";
import { MissionManager } from "./MissionManager";
import "./MissionHUD.css";

export class MissionHUD extends ReactEntity {
  renderLayer = "hud" as const;

  constructor() {
    super(() => this.renderContent());
  }

  private renderContent() {
    const manager = this.game?.entities.tryGetSingleton(MissionManager) ?? null;
    const active = manager?.getActiveMission() ?? null;

    if (!active) {
      return <div />;
    }

    // Build objective text based on mission type
    const objectiveText =
      active.def.type === "delivery"
        ? `Sail to ${this.getPortName(active.def.destinationPortId)}`
        : active.def.description;

    return (
      <div className="mission-hud">
        <div className="mission-hud__panel">
          <div className="mission-hud__title">{active.def.name}</div>
          <div className="mission-hud__objective">
            {"\u27A4"} {objectiveText}
          </div>
        </div>
      </div>
    );
  }

  /**
   * Resolve a port ID to a display name. Falls back to the raw ID
   * if no Port entity with that ID is found.
   */
  private getPortName(portId: string): string {
    const portEntity = this.game?.entities.getById(portId);
    if (portEntity && "getName" in portEntity) {
      return (portEntity as { getName(): string }).getName();
    }
    return portId;
  }
}
