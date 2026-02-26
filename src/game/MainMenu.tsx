import { LevelName, RESOURCES } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import "./MainMenu.css";

const LEVEL_NAMES = Object.keys(RESOURCES.levels) as LevelName[];

function formatLevelName(name: string): string {
  // "default" → "Default", "vendoviIsland" → "Vendovi Island"
  const spaced = name.replace(/([A-Z])/g, " $1");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export class MainMenu extends ReactEntity {
  private selectedIndex = 0;

  constructor() {
    super(() => (
      <div class="main-menu">
        <div class="main-menu__title">Tack & Trim</div>
        <div class="main-menu__subtitle">Select a Level</div>
        <div class="main-menu__levels">
          {LEVEL_NAMES.map((name, i) => (
            <button
              class={`main-menu__card ${i === this.selectedIndex ? "main-menu__card--selected" : ""}`}
              onClick={() => this.selectLevel(i)}
            >
              {formatLevelName(name)}
            </button>
          ))}
        </div>
      </div>
    ));
  }

  private selectLevel(index: number) {
    const levelName = LEVEL_NAMES[index];
    this.game.dispatch("levelSelected", { levelName });
    this.destroy();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "ArrowUp" || key === "ArrowLeft") {
      this.selectedIndex =
        (this.selectedIndex - 1 + LEVEL_NAMES.length) % LEVEL_NAMES.length;
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      this.selectedIndex = (this.selectedIndex + 1) % LEVEL_NAMES.length;
    } else if (key === "Enter" || key === "Space") {
      this.selectLevel(this.selectedIndex);
    }
  }
}
