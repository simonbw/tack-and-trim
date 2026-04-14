import type { LevelName } from "../../resources/resources";
import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import type { KeyCode } from "../core/io/Keys";
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
  private selectedIndex = 0;

  constructor(private readonly levelName: LevelName) {
    super(() => {
      const selected = BOAT_DEFS[this.selectedIndex];
      return (
        <div class="boat-selection">
          <div class="boat-selection__title">Choose Your Boat</div>
          <div class="boat-selection__body">
            <div class="boat-selection__list">
              {BOAT_DEFS.map((boat, i) => (
                <button
                  class={`boat-selection__item ${i === this.selectedIndex ? "boat-selection__item--selected" : ""}`}
                  onClick={() => this.confirmSelection(i)}
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
    if (key === "ArrowUp") {
      this.selectedIndex =
        (this.selectedIndex - 1 + BOAT_DEFS.length) % BOAT_DEFS.length;
    } else if (key === "ArrowDown") {
      this.selectedIndex = (this.selectedIndex + 1) % BOAT_DEFS.length;
    } else if (key === "Enter" || key === "Space") {
      this.confirmSelection(this.selectedIndex);
    }
  }
}
