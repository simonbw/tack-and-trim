import { on } from "../../core/entity/handler";
import { KeyCode } from "../../core/io/Keys";
import { Modal } from "../../core/ui/Modal";
import { focusFirst, moveFocus } from "../../core/util/menuNav";
import { Boat } from "../boat/Boat";
import { ShipyardUI } from "../catalog/ShipyardUI";
import { MissionBoard } from "../mission/MissionBoard";
import "./PortMenu.css";

type PortMenuAction = "missionBoard" | "shipyard" | "castOff";
type SubMenu = "shipyard" | "missionBoard" | null;

const ACTIONS: { key: PortMenuAction; label: string }[] = [
  { key: "missionBoard", label: "Mission Board" },
  { key: "shipyard", label: "Shipyard" },
  { key: "castOff", label: "Cast Off" },
];

export class PortMenu extends Modal {
  private subMenuOpen: SubMenu = null;

  constructor(
    private portId: string,
    private portName: string,
  ) {
    super(() => (
      <div class="port-menu">
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
      </div>
    ));
  }

  @on("afterAdded")
  onAfterAdded() {
    this.reactRender();
    focusFirst(this.el);
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
    if (this.subMenuOpen) return;
    this.subMenuOpen = "shipyard";
    this.game.addEntity(new ShipyardUI());
    this.game.dispatch("openShipyard", {});
  }

  private openMissionBoard() {
    if (this.subMenuOpen) return;
    this.subMenuOpen = "missionBoard";
    this.game.addEntity(new MissionBoard(this.portId));
  }

  @on("closeShipyard")
  onCloseShipyard() {
    this.subMenuOpen = null;
    focusFirst(this.el);
  }

  private castOff() {
    const boat = this.game.entities.getById("boat") as Boat | undefined;
    if (boat) {
      boat.mooring.castOff();
    }
  }

  onEscape() {
    if (this.subMenuOpen) return;
    this.castOff();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    // Check if sub menus have closed themselves
    if (this.subMenuOpen === "missionBoard") {
      if (!this.game.entities.tryGetSingleton(MissionBoard)) {
        this.subMenuOpen = null;
        focusFirst(this.el);
      }
    }
    if (this.subMenuOpen) return;

    if (key === "ArrowUp" || key === "ArrowLeft") {
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      moveFocus(this.el, +1);
    }
  }
}
