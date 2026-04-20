import { Fragment, type VNode } from "preact";
import type { MissionDef } from "../../editor/io/LevelFileFormat";
import { MissionManager } from "./MissionManager";
import "./MissionBoard.css";

interface Props {
  manager: MissionManager;
  missions: MissionDef[];
  onAcceptMission: (missionId: string) => void;
}

export function MissionBoardPanel({
  manager,
  missions,
  onAcceptMission,
}: Props) {
  const activeMission = manager.getActiveMission();
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

      {missions.length === 0 ? (
        <div class="mission-board__empty">
          No missions available at this port
        </div>
      ) : (
        <div class="mission-board__list">
          {missions.map((mission) => (
            <button
              class="mission-board__entry"
              disabled={hasActive}
              onClick={() => onAcceptMission(mission.id)}
            >
              <div class="mission-board__entry-name">{mission.name}</div>
              <div class="mission-board__entry-desc">{mission.description}</div>
              <div class="mission-board__entry-rewards">
                {renderRewards(mission)}
              </div>
            </button>
          ))}
        </div>
      )}

      <div class="mission-board__hint">
        {missions.length > 0 && !hasActive
          ? "Enter to accept / Esc to go back"
          : "Esc to go back"}
      </div>
    </div>
  );
}

function renderRewards(mission: MissionDef): VNode {
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
