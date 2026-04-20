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

interface Props {
  focusedIndex: number;
  onFocusBoat: (index: number) => void;
  onSelectBoat: (boatId: string) => void;
  onBack: () => void;
}

export function BoatSelectionPanel({
  focusedIndex,
  onFocusBoat,
  onSelectBoat,
  onBack,
}: Props) {
  const selected = BOAT_DEFS[focusedIndex];
  return (
    <>
      <div class="main-menu__page-title">Choose Your Boat</div>

      <div class="main-menu__split">
        <div class="main-menu__levels">
          {BOAT_DEFS.map((boat, i) => (
            <button
              class="main-menu__card"
              onClick={() => onSelectBoat(boat.id)}
              onFocus={() => onFocusBoat(i)}
              onMouseEnter={() => onFocusBoat(i)}
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

      <button class="main-menu__back" onClick={onBack}>
        ← Back
      </button>
    </>
  );
}
