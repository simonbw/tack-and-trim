import { LevelName, RESOURCES } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import type { SaveSlotInfo } from "./persistence/SaveFile";
import { SaveManager } from "./persistence/SaveManager";
import { deleteSave, listSaves } from "./persistence/SaveStorage";
import "./MainMenu.css";

const LEVEL_NAMES = (Object.keys(RESOURCES.levels) as LevelName[]).sort(
  (a, b) => {
    if (a === "default") return -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  },
);

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

export class MainMenu extends ReactEntity {
  private saves: SaveSlotInfo[] = [];

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
            </div>
          )}

          <div class="main-menu__section">
            <div class="main-menu__subtitle">New Game</div>
            <div class="main-menu__levels">
              {LEVEL_NAMES.map((name) => (
                <button
                  class="main-menu__card"
                  onClick={() => this.selectLevel(name)}
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

  private selectLevel(levelName: LevelName) {
    this.game.dispatch("levelSelected", { levelName });
    this.destroy();
  }

  private onSaveKeyDown(e: KeyboardEvent, slotId: string) {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSave(slotId);
      const prev = document.activeElement as HTMLElement | null;
      this.saves = listSaves();
      this.reactRender();
      // Focus shifted: try to focus a sibling, else fall through to first.
      if (prev && !document.body.contains(prev)) {
        focusFirst(this.el);
      }
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
