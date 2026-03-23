import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import "./GameOverScreen.css";

type GameOverAction = "restart" | "menu";
const ACTIONS: { key: GameOverAction; label: string }[] = [
  { key: "restart", label: "Restart Level" },
  { key: "menu", label: "Main Menu" },
];

export class GameOverScreen extends ReactEntity {
  private selectedIndex = 0;

  constructor() {
    super(() => (
      <div class="game-over">
        <div class="game-over__title">Sunk!</div>
        <div class="game-over__actions">
          {ACTIONS.map(({ key, label }, i) => (
            <button
              class={`game-over__button ${i === this.selectedIndex ? "game-over__button--selected" : ""}`}
              onClick={() => this.execute(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    ));
  }

  private execute(action: GameOverAction) {
    if (action === "restart") {
      this.game.dispatch("restartLevel", {});
    } else {
      this.game.dispatch("returnToMenu", {});
    }
    this.destroy();
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
