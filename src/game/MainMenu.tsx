import { ReactEntity } from "../core/ReactEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import { LoadGameMenu } from "./LoadGameMenu";
import { formatLevelName, formatTimestamp } from "./menuFormatting";
import { NewGameMenu } from "./NewGameMenu";
import type { SaveSlotInfo } from "./persistence/SaveFile";
import { SaveManager } from "./persistence/SaveManager";
import { getMostRecentSave, listSaves } from "./persistence/SaveStorage";
import "./MainMenu.css";

export class MainMenu extends ReactEntity {
  private hasSaves = false;
  private mostRecent: SaveSlotInfo | null = null;

  constructor() {
    super(() => {
      const continueDisabled = this.mostRecent === null;
      const loadDisabled = !this.hasSaves;
      return (
        <div class="main-menu">
          <div class="main-menu__title">Tack & Trim</div>

          <div class="main-menu__buttons">
            <button
              class="main-menu__card"
              disabled={continueDisabled}
              onClick={() => this.continueGame()}
            >
              <div class="main-menu__card-label">Continue</div>
              {this.mostRecent && (
                <div class="main-menu__save-details">
                  {this.mostRecent.saveName} ·{" "}
                  {formatLevelName(this.mostRecent.levelId)} ·{" "}
                  {formatTimestamp(this.mostRecent.lastSaved)}
                </div>
              )}
            </button>
            <button
              class="main-menu__card"
              disabled={loadDisabled}
              onClick={() => this.openLoadGame()}
            >
              Load Game
            </button>
            <button class="main-menu__card" onClick={() => this.openNewGame()}>
              New Game
            </button>
          </div>
        </div>
      );
    });
  }

  @on("afterAdded")
  onAfterAdded() {
    const saves = listSaves();
    this.hasSaves = saves.length > 0;
    this.mostRecent = getMostRecentSave();
    this.reactRender();
    focusFirst(this.el);
  }

  private continueGame() {
    if (!this.mostRecent) return;
    const saveManager = this.game.entities.tryGetSingleton(SaveManager);
    if (saveManager) {
      saveManager.loadFromSlot(this.mostRecent.slotId);
    }
    this.destroy();
  }

  private openLoadGame() {
    this.game.addEntity(new LoadGameMenu());
    this.destroy();
  }

  private openNewGame() {
    this.game.addEntity(new NewGameMenu());
    this.destroy();
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "ArrowUp" || key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      event.preventDefault();
      moveFocus(this.el, +1);
    }
  }
}
