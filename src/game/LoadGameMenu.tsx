import { ReactEntity } from "../core/ReactEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import { formatLevelName, formatTimestamp } from "./menuFormatting";
import type { SaveSlotInfo } from "./persistence/SaveFile";
import { SaveManager } from "./persistence/SaveManager";
import { deleteSave, listSaves } from "./persistence/SaveStorage";
import "./MainMenu.css";

export class LoadGameMenu extends ReactEntity {
  private saves: SaveSlotInfo[] = [];

  constructor() {
    super(() => (
      <div class="main-menu">
        <div class="main-menu__page-title">Load Game</div>

        {this.saves.length === 0 ? (
          <div class="main-menu__empty">No saved games.</div>
        ) : (
          <div class="main-menu__levels">
            {this.saves.map((save) => (
              <button
                class="main-menu__card"
                onClick={() => this.loadSave(save.slotId)}
                onKeyDown={(e) => this.onSaveKeyDown(e, save.slotId)}
              >
                <div class="main-menu__save-name">{save.saveName}</div>
                <div class="main-menu__save-details">
                  {formatLevelName(save.levelId)} ·{" "}
                  {formatTimestamp(save.lastSaved)}
                </div>
              </button>
            ))}
          </div>
        )}

        <button class="main-menu__back" onClick={() => this.goBack()}>
          ← Back
        </button>
      </div>
    ));
  }

  @on("afterAdded")
  onAfterAdded() {
    this.saves = listSaves();
    this.reactRender();
    focusFirst(this.el);
  }

  private loadSave(slotId: string) {
    const saveManager = this.game.entities.tryGetSingleton(SaveManager);
    if (saveManager) {
      saveManager.loadFromSlot(slotId);
    }
    this.destroy();
  }

  private goBack() {
    // Defer the dispatch so that if we got here from a keyDown event, the
    // new MainMenu isn't visited by the same in-flight event dispatch.
    const game = this.game;
    this.destroy();
    queueMicrotask(() => game.dispatch("showMainMenu", {}));
  }

  private onSaveKeyDown(e: KeyboardEvent, slotId: string) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSave(slotId);
      const prev = document.activeElement as HTMLElement | null;
      this.saves = listSaves();
      this.reactRender();
      if (prev && !document.body.contains(prev)) {
        focusFirst(this.el);
      }
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Escape") {
      this.goBack();
    } else if (key === "ArrowUp" || key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      event.preventDefault();
      moveFocus(this.el, +1);
    }
  }
}
