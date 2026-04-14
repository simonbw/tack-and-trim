import type { LevelName } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import type { GameEventMap } from "../core/entity/Entity";
import { on } from "../core/entity/handler";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import { BOAT_DEFS } from "./catalog/BoatCatalog";
import "./BoatSelectionScreen.css";
import "./MainMenu.css";

function StatBar({ label, value }: { label: string; value: number }) {
  return (
    <div class="boat-selection__stat">
      <span class="boat-selection__stat-label">{label}</span>
      <div class="boat-selection__stat-bar">
        {Array.from({ length: 10 }, (_, i) => (
          <div
            class={`boat-selection__stat-pip ${i < value ? "boat-selection__stat-pip--filled" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

export class BoatSelectionScreen extends ReactEntity {
  /** Index of the boat shown in the detail pane. Driven by focus. */
  private focusedIndex = 0;

  constructor(private readonly levelName: LevelName) {
    super(() => {
      const selected = BOAT_DEFS[this.focusedIndex];
      return (
        <div class="main-menu">
          <div class="main-menu__page-title">Choose Your Boat</div>

          <div class="main-menu__split">
            <div class="main-menu__levels">
              {BOAT_DEFS.map((boat, i) => (
                <button
                  class="main-menu__card"
                  onClick={() => this.confirmSelection(i)}
                  onFocus={() => this.setFocused(i)}
                  onMouseEnter={() => this.setFocused(i)}
                >
                  {boat.name}
                </button>
              ))}
            </div>

            {selected && (
              <div class="main-menu__detail">
                <div class="main-menu__detail-name">{selected.name}</div>
                <div class="main-menu__detail-desc">{selected.description}</div>
                <div class="boat-selection__stats">
                  <StatBar label="Speed" value={selected.displayStats.speed} />
                  <StatBar
                    label="Stability"
                    value={selected.displayStats.stability}
                  />
                  <StatBar
                    label="Maneuverability"
                    value={selected.displayStats.maneuverability}
                  />
                  <StatBar
                    label="Durability"
                    value={selected.displayStats.durability}
                  />
                </div>
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

  private goBack() {
    // Defer the dispatch so that if we got here from a keyDown event, the
    // new NewGameMenu isn't visited by the same in-flight event dispatch
    // (Set iteration includes entries added mid-loop, which would cascade
    // the same ESC all the way up to MainMenu).
    const game = this.game;
    this.destroy();
    queueMicrotask(() => game.dispatch("showNewGameMenu", {}));
  }

  @on("afterAdded")
  onAfterAdded() {
    this.reactRender();
    focusFirst(this.el);
  }

  private setFocused(index: number) {
    this.focusedIndex = index;
  }

  private confirmSelection(index: number) {
    const boat = BOAT_DEFS[index];
    if (!boat) return;
    this.game.dispatch("boatSelected", {
      boatId: boat.id,
      levelName: this.levelName,
    });
    this.destroy();
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
