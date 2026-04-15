import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import { Modal } from "../core/ui/Modal";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import "./PauseMenu.css";
import { SaveManager } from "./persistence/SaveManager";

type PauseAction = "resume" | "save" | "restart" | "mainMenu";

const ACTIONS: { key: PauseAction; label: string }[] = [
  { key: "resume", label: "Resume" },
  { key: "save", label: "Save Game" },
  { key: "restart", label: "Restart Level" },
  { key: "mainMenu", label: "Return to Main Menu" },
];

export class PauseMenu extends Modal {
  protected pausesGame = true;

  constructor() {
    super(() => (
      <div class="pause-menu">
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
      </div>
    ));
  }

  @on("afterAdded")
  onAfterAdded() {
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
      case "mainMenu":
        this.game.dispatch("returnToMenu", {});
        return;
    }
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "ArrowUp" || key === "ArrowLeft") {
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      moveFocus(this.el, +1);
    }
  }
}
