import { ReactEntity } from "../../core/ReactEntity";
import { on } from "../../core/entity/handler";
import { KeyCode } from "../../core/io/Keys";
import { Boat } from "../boat/Boat";
import { ShipyardUI } from "../catalog/ShipyardUI";
import "./PortMenu.css";

type PortMenuAction = "missionBoard" | "shipyard" | "castOff";

const ACTIONS: { key: PortMenuAction; label: string }[] = [
  { key: "missionBoard", label: "Mission Board" },
  { key: "shipyard", label: "Shipyard" },
  { key: "castOff", label: "Cast Off" },
];

export class PortMenu extends ReactEntity {
  private selectedIndex = 0;
  private shipyardOpen = false;

  constructor(
    private portId: string,
    private portName: string,
  ) {
    super(() => (
      <div class="port-menu">
        <div class="port-menu__title">{this.portName}</div>
        <div class="port-menu__subtitle">Port Services</div>
        <div class="port-menu__actions">
          {ACTIONS.map(({ key, label }, i) => (
            <button
              class={`port-menu__button ${key === "castOff" ? "port-menu__button--cast-off" : ""} ${i === this.selectedIndex ? "port-menu__button--selected" : ""}`}
              onClick={() => this.execute(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    ));
  }

  private execute(action: PortMenuAction) {
    switch (action) {
      case "missionBoard":
        console.log("Mission Board: Coming soon");
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
    if (this.shipyardOpen) return;
    this.shipyardOpen = true;
    this.game.addEntity(new ShipyardUI());
    this.game.dispatch("openShipyard", {});
  }

  @on("closeShipyard")
  onCloseShipyard() {
    this.shipyardOpen = false;
  }

  private castOff() {
    const boat = this.game.entities.getById("boat") as Boat | undefined;
    if (boat) {
      boat.anchor.retrieve();
    }
    this.game.dispatch("boatUnmoored", { portId: this.portId });
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (this.shipyardOpen) return;

    if (key === "Escape") {
      this.castOff();
      return;
    }

    if (key === "ArrowUp" || key === "ArrowLeft") {
      this.selectedIndex =
        (this.selectedIndex - 1 + ACTIONS.length) % ACTIONS.length;
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      this.selectedIndex = (this.selectedIndex + 1) % ACTIONS.length;
    } else if (key === "Enter" || key === "Space") {
      this.execute(ACTIONS[this.selectedIndex].key);
    }
  }
}
