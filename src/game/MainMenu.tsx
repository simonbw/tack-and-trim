import type { LevelName } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import { BoatSelectionPanel } from "./BoatSelectionPanel";
import { LoadGamePanel } from "./LoadGamePanel";
import { formatLevelName, formatTimestamp } from "./menuFormatting";
import { NewGamePanel } from "./NewGamePanel";
import type { SaveSlotInfo } from "./persistence/SaveFile";
import { SaveManager } from "./persistence/SaveManager";
import {
  deleteSave,
  getMostRecentSave,
  listSaves,
} from "./persistence/SaveStorage";
import { SettingsPanel } from "./SettingsPanel";
import "./MainMenu.css";

type Submenu =
  | null
  | "settings"
  | "loadGame"
  | "newGame"
  | { kind: "boatSelect"; level: LevelName };

export class MainMenu extends ReactEntity {
  private submenu: Submenu = null;

  // Root menu state
  private hasSaves = false;
  private mostRecent: SaveSlotInfo | null = null;

  // Load-game state
  private saves: SaveSlotInfo[] = [];
  private pendingDeleteSlotId: string | null = null;

  // New-game / boat-select focused index
  private levelFocusedIndex = 0;
  private boatFocusedIndex = 0;

  constructor() {
    super(() => {
      return (
        <div class="main-menu">
          {this.submenu === null && this.renderRoot()}
          {this.submenu === "settings" && (
            <SettingsPanel
              onBack={() => this.setSubmenu(null)}
              onChange={() => this.reactRender()}
            />
          )}
          {this.submenu === "loadGame" && (
            <LoadGamePanel
              saves={this.saves}
              pendingDeleteSlotId={this.pendingDeleteSlotId}
              onBack={() => this.setSubmenu(null)}
              onLoad={(slotId) => this.loadSave(slotId)}
              onRequestDelete={(slotId) => this.requestDelete(slotId)}
              onConfirmDelete={(slotId) => this.confirmDelete(slotId)}
              onCancelDelete={() => this.cancelDelete()}
            />
          )}
          {this.submenu === "newGame" && (
            <NewGamePanel
              focusedIndex={this.levelFocusedIndex}
              onFocusLevel={(i) => this.setLevelFocused(i)}
              onSelectLevel={(name) => this.selectLevel(name)}
              onBack={() => this.setSubmenu(null)}
            />
          )}
          {typeof this.submenu === "object" &&
            this.submenu !== null &&
            this.submenu.kind === "boatSelect" &&
            (() => {
              const level = this.submenu.level;
              return (
                <BoatSelectionPanel
                  focusedIndex={this.boatFocusedIndex}
                  onFocusBoat={(i) => this.setBoatFocused(i)}
                  onSelectBoat={(boatId) => this.confirmBoat(boatId, level)}
                  onBack={() => this.setSubmenu("newGame")}
                />
              );
            })()}
        </div>
      );
    });
  }

  private renderRoot() {
    const continueDisabled = this.mostRecent === null;
    const loadDisabled = !this.hasSaves;
    return (
      <>
        <div class="main-menu__title">Tack & Trim</div>
        <div class="main-menu__buttons">
          <button
            class="main-menu__card"
            disabled={continueDisabled}
            onClick={() => this.continueGame()}
          >
            <div class="main-menu__card-label">Continue</div>
            <div class="main-menu__save-details">
              {this.mostRecent
                ? `${this.mostRecent.saveName} · ${formatLevelName(this.mostRecent.levelId)} · ${formatTimestamp(this.mostRecent.lastSaved)}`
                : "No saved games"}
            </div>
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
          <button class="main-menu__card" onClick={() => this.openSettings()}>
            Settings
          </button>
        </div>
      </>
    );
  }

  @on("afterAdded")
  onAfterAdded() {
    this.refreshSavesSummary();
    this.reactRender();
    focusFirst(this.el);
  }

  private refreshSavesSummary() {
    const saves = listSaves();
    this.hasSaves = saves.length > 0;
    this.mostRecent = getMostRecentSave();
  }

  private setSubmenu(next: Submenu) {
    this.submenu = next;
    this.reactRender();
    focusFirst(this.el);
  }

  // Root actions

  private continueGame() {
    if (!this.mostRecent) return;
    const saveManager = this.game.entities.tryGetSingleton(SaveManager);
    if (saveManager) {
      saveManager.loadFromSlot(this.mostRecent.slotId);
    }
    this.destroy();
  }

  private openLoadGame() {
    this.saves = listSaves();
    this.pendingDeleteSlotId = null;
    this.setSubmenu("loadGame");
  }

  private openNewGame() {
    this.levelFocusedIndex = 0;
    this.setSubmenu("newGame");
  }

  private openSettings() {
    this.setSubmenu("settings");
  }

  // Load-game actions

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
    const actions = this.el.querySelectorAll<HTMLButtonElement>(
      ".main-menu__confirm-button",
    );
    actions[actions.length - 1]?.focus();
  }

  private confirmDelete(slotId: string) {
    deleteSave(slotId);
    this.pendingDeleteSlotId = null;
    this.saves = listSaves();
    this.refreshSavesSummary();
    this.reactRender();
    focusFirst(this.el);
  }

  private cancelDelete() {
    this.pendingDeleteSlotId = null;
    this.reactRender();
    focusFirst(this.el);
  }

  // New-game / boat-select actions

  private setLevelFocused(index: number) {
    if (this.levelFocusedIndex === index) return;
    this.levelFocusedIndex = index;
    this.reactRender();
  }

  private setBoatFocused(index: number) {
    if (this.boatFocusedIndex === index) return;
    this.boatFocusedIndex = index;
    this.reactRender();
  }

  private selectLevel(levelName: LevelName) {
    this.game.dispatch("levelSelected", { levelName });
    this.boatFocusedIndex = 0;
    this.setSubmenu({ kind: "boatSelect", level: levelName });
  }

  private confirmBoat(boatId: string, levelName: LevelName) {
    this.game.dispatch("boatSelected", { boatId, levelName });
    this.destroy();
  }

  // Keyboard

  @on("keyDown")
  onKeyDown({ key, event }: GameEventMap["keyDown"]) {
    if (key === "Escape") {
      event.preventDefault();
      if (this.submenu === null) return;
      if (this.submenu === "loadGame" && this.pendingDeleteSlotId !== null) {
        this.cancelDelete();
        return;
      }
      if (
        typeof this.submenu === "object" &&
        this.submenu.kind === "boatSelect"
      ) {
        this.setSubmenu("newGame");
        return;
      }
      this.setSubmenu(null);
      return;
    }
    if (key === "ArrowUp" || key === "ArrowLeft") {
      event.preventDefault();
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      event.preventDefault();
      moveFocus(this.el, +1);
    }
  }
}
