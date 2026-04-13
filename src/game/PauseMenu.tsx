import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import { Modal } from "../core/ui/Modal";
import "./PauseMenu.css";

type PauseAction = "resume" | "restart" | "mainMenu";

const ACTIONS: { key: PauseAction; label: string }[] = [
  { key: "resume", label: "Resume" },
  { key: "restart", label: "Restart Level" },
  { key: "mainMenu", label: "Return to Main Menu" },
];

export class PauseMenu extends Modal {
  protected pausesGame = true;
  private selectedIndex = 0;

  constructor() {
    super(() => (
      <div class="pause-menu">
        <div class="pause-menu__title">Paused</div>
        <div class="pause-menu__actions">
          {ACTIONS.map(({ key, label }, i) => (
            <button
              class={`pause-menu__button ${i === this.selectedIndex ? "pause-menu__button--selected" : ""}`}
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

  private execute(action: PauseAction) {
    switch (action) {
      case "resume":
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
      this.selectedIndex =
        (this.selectedIndex - 1 + ACTIONS.length) % ACTIONS.length;
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      this.selectedIndex = (this.selectedIndex + 1) % ACTIONS.length;
    } else if (key === "Enter" || key === "Space") {
      this.execute(ACTIONS[this.selectedIndex].key);
    }
  }
}
