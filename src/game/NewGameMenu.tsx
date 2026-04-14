import { LevelName, RESOURCES } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import type {
  LevelDisplayInfo,
  LevelFileJSON,
} from "../editor/io/LevelFileFormat";
import { formatLevelName } from "./menuFormatting";
import "./MainMenu.css";

interface LevelEntry {
  name: LevelName;
  displayName: string;
  info: LevelDisplayInfo | undefined;
}

const DIFFICULTY_LABEL: Record<
  NonNullable<LevelDisplayInfo["difficulty"]>,
  string
> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  expert: "Expert",
};

const DIFFICULTY_ORDER: Record<
  NonNullable<LevelDisplayInfo["difficulty"]>,
  number
> = {
  beginner: 0,
  intermediate: 1,
  expert: 2,
};

function buildEntries(): LevelEntry[] {
  const names = Object.keys(RESOURCES.levels) as LevelName[];
  return names
    .map((name) => {
      const file = RESOURCES.levels[name] as LevelFileJSON;
      return {
        name,
        displayName: file.name ?? formatLevelName(name),
        info: file.displayInfo,
      };
    })
    .sort((a, b) => {
      const da = a.info?.difficulty;
      const db = b.info?.difficulty;
      // Levels with no difficulty set sort to the end.
      const oa = da ? DIFFICULTY_ORDER[da] : Infinity;
      const ob = db ? DIFFICULTY_ORDER[db] : Infinity;
      if (oa !== ob) return oa - ob;
      return a.displayName.localeCompare(b.displayName);
    });
}

export class NewGameMenu extends ReactEntity {
  private entries: LevelEntry[] = buildEntries();
  private focusedIndex = 0;

  constructor() {
    super(() => {
      const focused = this.entries[this.focusedIndex];
      return (
        <div class="main-menu">
          <div class="main-menu__page-title">New Game</div>

          <div class="main-menu__split">
            <div class="main-menu__levels">
              {this.entries.map((entry, i) => (
                <button
                  class="main-menu__card"
                  onClick={() => this.selectLevel(entry.name)}
                  onFocus={() => this.setFocused(i)}
                  onMouseEnter={() => this.setFocused(i)}
                >
                  {entry.displayName}
                </button>
              ))}
            </div>

            {focused && (
              <div class="main-menu__detail">
                <div class="main-menu__detail-name">{focused.displayName}</div>
                {focused.info?.difficulty && (
                  <div
                    class={`main-menu__badge main-menu__badge--${focused.info.difficulty}`}
                  >
                    {DIFFICULTY_LABEL[focused.info.difficulty]}
                  </div>
                )}
                {focused.info?.description && (
                  <div class="main-menu__detail-desc">
                    {focused.info.description}
                  </div>
                )}
              </div>
            )}
          </div>

          <button class="main-menu__back" onClick={() => this.goBack()}>
            ← Back
          </button>
        </div>
      );
    });
  }

  @on("afterAdded")
  onAfterAdded() {
    this.reactRender();
    focusFirst(this.el);
  }

  private setFocused(index: number) {
    if (this.focusedIndex === index) return;
    this.focusedIndex = index;
    this.reactRender();
  }

  private selectLevel(levelName: LevelName) {
    this.game.dispatch("levelSelected", { levelName });
    this.destroy();
  }

  private goBack() {
    // Defer the dispatch so that if we got here from a keyDown event, the
    // new MainMenu isn't visited by the same in-flight event dispatch.
    const game = this.game;
    this.destroy();
    queueMicrotask(() => game.dispatch("showMainMenu", {}));
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
