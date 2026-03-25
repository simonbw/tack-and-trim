import { LevelName, RESOURCES } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import type { SaveSlotInfo } from "./persistence/SaveFile";
import { SaveManager } from "./persistence/SaveManager";
import { listSaves, deleteSave } from "./persistence/SaveStorage";
import "./MainMenu.css";

const LEVEL_NAMES = Object.keys(RESOURCES.levels) as LevelName[];

function formatLevelName(name: string): string {
  // "default" → "Default", "vendoviIsland" → "Vendovi Island"
  const spaced = name.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

type MenuSection = "saves" | "levels";

interface MenuItem {
  section: MenuSection;
  index: number;
}

export class MainMenu extends ReactEntity {
  private saves: SaveSlotInfo[] = [];
  private selectedSection: MenuSection = "saves";
  private selectedSaveIndex = 0;
  private selectedLevelIndex = 0;

  constructor() {
    super(() => {
      const hasSaves = this.saves.length > 0;
      return (
        <div class="main-menu">
          <div class="main-menu__title">Tack & Trim</div>

          {hasSaves && (
            <div class="main-menu__section">
              <div class="main-menu__subtitle">Saved Games</div>
              <div class="main-menu__levels">
                {this.saves.map((save, i) => (
                  <button
                    class={`main-menu__card ${this.selectedSection === "saves" && i === this.selectedSaveIndex ? "main-menu__card--selected" : ""}`}
                    onClick={() => this.loadSave(i)}
                  >
                    <div class="main-menu__save-name">{save.saveName}</div>
                    <div class="main-menu__save-details">
                      {formatLevelName(save.levelId)} ·{" "}
                      {formatTimestamp(save.lastSaved)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="main-menu__section">
            <div class="main-menu__subtitle">New Game</div>
            <div class="main-menu__levels">
              {LEVEL_NAMES.map((name, i) => (
                <button
                  class={`main-menu__card ${this.selectedSection === "levels" && i === this.selectedLevelIndex ? "main-menu__card--selected" : ""}`}
                  onClick={() => this.selectLevel(i)}
                >
                  {formatLevelName(name)}
                </button>
              ))}
            </div>
          </div>
        </div>
      );
    });
  }

  @on("afterAdded")
  onAfterAdded() {
    this.saves = listSaves();
    // Default to saves section if saves exist, otherwise levels
    this.selectedSection = this.saves.length > 0 ? "saves" : "levels";
  }

  private loadSave(index: number) {
    const save = this.saves[index];
    if (!save) return;
    const saveManager = this.game.entities.tryGetSingleton(SaveManager);
    if (saveManager) {
      saveManager.loadFromSlot(save.slotId);
    }
    this.destroy();
  }

  private selectLevel(index: number) {
    const levelName = LEVEL_NAMES[index];
    this.game.dispatch("levelSelected", { levelName });
    this.destroy();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    const hasSaves = this.saves.length > 0;

    if (key === "ArrowUp") {
      if (this.selectedSection === "saves") {
        this.selectedSaveIndex =
          (this.selectedSaveIndex - 1 + this.saves.length) % this.saves.length;
      } else {
        if (this.selectedLevelIndex === 0 && hasSaves) {
          // Jump to saves section
          this.selectedSection = "saves";
          this.selectedSaveIndex = this.saves.length - 1;
        } else {
          this.selectedLevelIndex =
            (this.selectedLevelIndex - 1 + LEVEL_NAMES.length) %
            LEVEL_NAMES.length;
        }
      }
    } else if (key === "ArrowDown") {
      if (this.selectedSection === "saves") {
        if (this.selectedSaveIndex === this.saves.length - 1) {
          // Jump to levels section
          this.selectedSection = "levels";
          this.selectedLevelIndex = 0;
        } else {
          this.selectedSaveIndex++;
        }
      } else {
        this.selectedLevelIndex =
          (this.selectedLevelIndex + 1) % LEVEL_NAMES.length;
      }
    } else if (key === "Enter" || key === "Space") {
      if (this.selectedSection === "saves") {
        this.loadSave(this.selectedSaveIndex);
      } else {
        this.selectLevel(this.selectedLevelIndex);
      }
    } else if (key === "Delete" || key === "Backspace") {
      // Delete selected save
      if (this.selectedSection === "saves" && this.saves.length > 0) {
        const save = this.saves[this.selectedSaveIndex];
        deleteSave(save.slotId);
        this.saves = listSaves();
        if (this.saves.length === 0) {
          this.selectedSection = "levels";
        } else if (this.selectedSaveIndex >= this.saves.length) {
          this.selectedSaveIndex = this.saves.length - 1;
        }
      }
    }
  }
}
