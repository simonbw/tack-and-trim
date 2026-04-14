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
  private pendingDeleteSlotId: string | null = null;

  constructor() {
    super(() => (
      <div class="main-menu">
        <div class="main-menu__page-title">Load Game</div>

        {this.saves.length === 0 ? (
          <div class="main-menu__empty">No saved games.</div>
        ) : (
          <div class="main-menu__levels">
            {this.saves.map((save) =>
              this.pendingDeleteSlotId === save.slotId
                ? this.renderConfirm(save)
                : this.renderSave(save),
            )}
          </div>
        )}

        <button class="main-menu__back" onClick={() => this.goBack()}>
          ← Back
        </button>
      </div>
    ));
  }

  private renderSave(save: SaveSlotInfo) {
    return (
      <div class="main-menu__save-entry">
        <button
          class="main-menu__card main-menu__card--save"
          onClick={() => this.loadSave(save.slotId)}
          onKeyDown={(e) => this.onSaveKeyDown(e, save.slotId)}
        >
          <div class="main-menu__save-name">{save.saveName}</div>
          <div class="main-menu__save-details">
            {formatLevelName(save.levelId)} · {formatTimestamp(save.lastSaved)}
          </div>
        </button>
        <button
          class="main-menu__delete"
          tabIndex={-1}
          aria-label={`Delete save "${save.saveName}"`}
          onClick={(e) => {
            e.stopPropagation();
            this.requestDelete(save.slotId);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  private renderConfirm(save: SaveSlotInfo) {
    return (
      <div class="main-menu__card main-menu__card--confirm">
        <div class="main-menu__confirm-prompt">Delete “{save.saveName}”?</div>
        <div class="main-menu__confirm-actions">
          <button
            class="main-menu__confirm-button main-menu__confirm-button--danger"
            onClick={() => this.confirmDelete(save.slotId)}
          >
            Delete
          </button>
          <button
            class="main-menu__confirm-button"
            onClick={() => this.cancelDelete()}
          >
            Cancel
          </button>
        </div>
      </div>
    );
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

  private requestDelete(slotId: string) {
    this.pendingDeleteSlotId = slotId;
    this.reactRender();
    // Focus the Cancel button (second action) as the safe default.
    const actions = this.el.querySelectorAll<HTMLButtonElement>(
      ".main-menu__confirm-button",
    );
    actions[actions.length - 1]?.focus();
  }

  private confirmDelete(slotId: string) {
    deleteSave(slotId);
    this.pendingDeleteSlotId = null;
    this.saves = listSaves();
    this.reactRender();
    focusFirst(this.el);
  }

  private cancelDelete() {
    this.pendingDeleteSlotId = null;
    this.reactRender();
    focusFirst(this.el);
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
      this.requestDelete(slotId);
    }
  }

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Escape") {
      event.preventDefault();
      if (this.pendingDeleteSlotId !== null) {
        this.cancelDelete();
      } else {
        this.goBack();
      }
    } else if (key === "ArrowUp" || key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      event.preventDefault();
      moveFocus(this.el, +1);
    }
  }
}
