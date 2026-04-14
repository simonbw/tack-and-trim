import type { LevelName } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import type { KeyCode } from "../core/io/Keys";
import { focusFirst, moveFocus } from "../core/util/menuNav";
import { BOAT_DEFS } from "./catalog/BoatCatalog";
import "./BoatSelectionScreen.css";

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
        <div class="boat-selection">
          <div class="boat-selection__title">Choose Your Boat</div>
          <div class="boat-selection__body">
            <div class="boat-selection__list">
              {BOAT_DEFS.map((boat, i) => (
                <button
                  class="boat-selection__item"
                  onClick={() => this.confirmSelection(i)}
                  onFocus={() => this.setFocused(i)}
                >
                  {boat.name}
                </button>
              ))}
            </div>

            {selected && (
              <div class="boat-selection__detail">
                <div class="boat-selection__boat-name">{selected.name}</div>
                <div class="boat-selection__boat-desc">
                  {selected.description}
                </div>
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
          <div class="boat-selection__hint">↑↓ to browse · Enter to sail</div>
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
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "ArrowUp" || key === "ArrowLeft") {
      moveFocus(this.el, -1);
    } else if (key === "ArrowDown" || key === "ArrowRight") {
      moveFocus(this.el, +1);
    }
  }
}
