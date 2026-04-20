import { ReactEntity } from "../../core/ReactEntity";
import type { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { focusFirst, moveFocus } from "../../core/util/menuNav";
import { Boat } from "../boat/Boat";
import {
  SHIPYARD_TABS,
  ShipyardPanel,
  type ShipyardTabId,
} from "../catalog/ShipyardPanel";
import type { MissionDef } from "../../editor/io/LevelFileFormat";
import { MissionBoardPanel } from "../mission/MissionBoardPanel";
import { MissionManager } from "../mission/MissionManager";
import "./PortMenu.css";

type PortMenuAction = "missionBoard" | "shipyard" | "castOff";
type Submenu = null | "shipyard" | "missionBoard";

const ACTIONS: { key: PortMenuAction; label: string }[] = [
  { key: "missionBoard", label: "Mission Board" },
  { key: "shipyard", label: "Shipyard" },
  { key: "castOff", label: "Cast Off" },
];

export class PortMenu extends ReactEntity {
  private submenu: Submenu = null;
  private shipyardTab: ShipyardTabId = "boats";
  private missions: MissionDef[] = [];

  constructor(
    private portId: string,
    private portName: string,
  ) {
    super(() => (
      <div class="port-menu">
        {this.submenu === null && this.renderRoot()}
        {this.submenu === "shipyard" && (
          <ShipyardPanel
            game={this.game}
            activeTab={this.shipyardTab}
            onSetTab={(tab) => this.setShipyardTab(tab)}
          />
        )}
        {this.submenu === "missionBoard" && (
          <MissionBoardPanel
            manager={this.game.entities.getSingleton(MissionManager)}
            missions={this.missions}
            onAcceptMission={(id) => this.acceptMission(id)}
          />
        )}
      </div>
    ));
  }

  private renderRoot() {
    return (
      <>
        <div class="port-menu__title">{this.portName}</div>
        <div class="port-menu__subtitle">Port Services</div>
        <div class="port-menu__actions">
          {ACTIONS.map(({ key, label }) => (
            <button
              class={`port-menu__button ${key === "castOff" ? "port-menu__button--cast-off" : ""}`}
              onClick={() => this.execute(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </>
    );
  }

  onAdd() {
    super.onAdd();
    if (!this.game!.paused) this.game!.pause();
  }

  onDestroy(data: GameEventMap["destroy"]) {
    if (data.game.paused) data.game.unpause();
    super.onDestroy(data);
  }

  @on("afterAdded")
  onAfterAdded() {
    this.reactRender();
    focusFirst(this.el);
  }

  private setSubmenu(next: Submenu) {
    this.submenu = next;
    this.reactRender();
    this.focusForSubmenu();
  }

  private focusForSubmenu() {
    if (this.submenu === "shipyard") {
      const list = this.el.querySelector<HTMLElement>(".shipyard__list");
      if (list) {
        focusFirst(list);
        return;
      }
    }
    focusFirst(this.el);
  }

  private setShipyardTab(tab: ShipyardTabId) {
    this.shipyardTab = tab;
    this.reactRender();
    const list = this.el.querySelector<HTMLElement>(".shipyard__list");
    if (list) focusFirst(list);
  }

  private cycleShipyardTab(direction: 1 | -1) {
    const idx = SHIPYARD_TABS.findIndex((t) => t.id === this.shipyardTab);
    const next =
      (idx + direction + SHIPYARD_TABS.length) % SHIPYARD_TABS.length;
    this.setShipyardTab(SHIPYARD_TABS[next].id);
  }

  private execute(action: PortMenuAction) {
    switch (action) {
      case "missionBoard":
        this.openMissionBoard();
        break;
      case "shipyard":
        this.openShipyard();
        break;
      case "castOff":
        this.castOff();
        break;
    }
  }

  private openShipyard() {
    this.shipyardTab = "boats";
    this.setSubmenu("shipyard");
  }

  private openMissionBoard() {
    const manager = this.game.entities.getSingleton(MissionManager);
    this.missions = manager.getAvailableMissions(this.portId);
    this.setSubmenu("missionBoard");
  }

  private acceptMission(missionId: string) {
    const manager = this.game.entities.getSingleton(MissionManager);
    if (manager.getActiveMission() !== null) return;
    manager.acceptMission(missionId);
    this.destroy();
  }

  private castOff() {
    const boat = this.game.entities.getById("boat") as Boat | undefined;
    if (boat) {
      boat.mooring.castOff();
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Escape") {
      event.preventDefault();
      if (this.submenu !== null) {
        this.setSubmenu(null);
      } else {
        this.castOff();
      }
      return;
    }

    if (this.submenu === "shipyard") {
      if (key === "Tab" || key === "ArrowRight") {
        this.cycleShipyardTab(1);
        return;
      }
      if (key === "ArrowLeft") {
        this.cycleShipyardTab(-1);
        return;
      }
      const list = this.el.querySelector<HTMLElement>(".shipyard__list");
      if (!list) return;
      if (key === "ArrowUp") moveFocus(list, -1);
      else if (key === "ArrowDown") moveFocus(list, +1);
      return;
    }

    if (this.submenu === "missionBoard") {
      if (this.missions.length === 0) return;
      if (key === "ArrowUp" || key === "ArrowLeft") {
        moveFocus(this.el, -1);
      } else if (key === "ArrowDown" || key === "ArrowRight") {
        moveFocus(this.el, +1);
      }
      return;
    }

    // Root menu
    if (key === "ArrowUp" || key === "ArrowLeft") {
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      moveFocus(this.el, +1);
    }
  }
}
