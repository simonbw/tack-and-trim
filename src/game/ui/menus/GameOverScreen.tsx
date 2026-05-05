import { ReactEntity } from "../../../core/ReactEntity";
import { on } from "../../../core/entity/handler";
import { KeyCode } from "../../../core/io/Keys";
import { focusFirst, moveFocus } from "../../../core/util/menuNav";
import { SaveManager } from "../../persistence/SaveManager";
import { getMostRecentSave } from "../../persistence/SaveStorage";
import "./GameOverScreen.css";

type GameOverAction = "loadSave" | "restart" | "menu";
const ACTIONS: { key: GameOverAction; label: string }[] = [
  { key: "loadSave", label: "Load Last Save" },
  { key: "restart", label: "Restart Level" },
  { key: "menu", label: "Main Menu" },
];

export class GameOverScreen extends ReactEntity {
  constructor() {
    super(() => (
      <div class="game-over">
        <div class="game-over__title">Sunk!</div>
        <div class="game-over__actions">
          {ACTIONS.map(({ key, label }) => (
            <button class="game-over__button" onClick={() => this.execute(key)}>
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

  private execute(action: GameOverAction) {
    if (action === "loadSave") {
      const recentSave = getMostRecentSave();
      if (recentSave) {
        const saveManager = this.game.entities.tryGetSingleton(SaveManager);
        if (saveManager) {
          saveManager.loadFromSlot(recentSave.slotId);
          this.destroy();
          return;
        }
      }
      this.game.dispatch("restartLevel", {});
    } else if (action === "restart") {
      this.game.dispatch("restartLevel", {});
    } else {
      this.game.dispatch("returnToMenu", {});
    }
    this.destroy();
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
