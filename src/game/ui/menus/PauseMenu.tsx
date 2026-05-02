import { ReactEntity } from "../../../core/ReactEntity";
import type { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";
import { focusFirst, moveFocus } from "../../../core/util/menuNav";
import { SaveManager } from "../../persistence/SaveManager";
import { SettingsPanel } from "./SettingsPanel";
import "./PauseMenu.css";

type PauseAction = "resume" | "save" | "restart" | "settings" | "mainMenu";
type Submenu = null | "settings";

const ACTIONS: { key: PauseAction; label: string }[] = [
  { key: "resume", label: "Resume" },
  { key: "save", label: "Save Game" },
  { key: "restart", label: "Restart Level" },
  { key: "settings", label: "Settings" },
  { key: "mainMenu", label: "Return to Main Menu" },
];

export class PauseMenu extends ReactEntity {
  private submenu: Submenu = null;

  constructor() {
    super(() => (
      <div class="pause-menu">
        {this.submenu === null && this.renderMain()}
        {this.submenu === "settings" && (
          <SettingsPanel
            onBack={() => this.setSubmenu(null)}
            onChange={() => this.reactRender()}
          />
        )}
      </div>
    ));
  }

  private renderMain() {
    return (
      <>
        <div class="pause-menu__title">Paused</div>
        <div class="pause-menu__actions">
          {ACTIONS.map(({ key, label }) => (
            <button
              class="pause-menu__button"
              onClick={() => this.execute(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div class="pause-menu__hint">Esc to resume</div>
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
    focusFirst(this.el);
  }

  private execute(action: PauseAction) {
    switch (action) {
      case "resume":
        this.destroy();
        return;
      case "save":
        this.game.entities.getSingleton(SaveManager).save();
        this.destroy();
        return;
      case "restart":
        this.game.dispatch("restartLevel", {});
        return;
      case "settings":
        this.setSubmenu("settings");
        return;
      case "mainMenu":
        this.game.dispatch("returnToMenu", {});
        return;
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Escape") {
      event.preventDefault();
      if (this.submenu !== null) {
        this.setSubmenu(null);
      } else {
        this.destroy();
      }
      return;
    }
    if (key === "ArrowUp" || key === "ArrowLeft") {
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      moveFocus(this.el, +1);
    }
  }
}
