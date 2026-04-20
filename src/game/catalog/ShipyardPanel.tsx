import type { Game } from "../../core/Game";
import { Boat } from "../boat/Boat";
import { ProgressionManager } from "../progression/ProgressionManager";
import {
  BOAT_DEFS,
  BoatDef,
  getBoatDef,
  getUpgradeDef,
  UpgradeDef,
} from "./BoatCatalog";
import "./ShipyardUI.css";

export type ShipyardTabId = "boats" | "upgrades" | "repairs";
type TabId = ShipyardTabId;
export const SHIPYARD_TABS: { id: TabId; label: string }[] = [
  { id: "boats", label: "Boats" },
  { id: "upgrades", label: "Upgrades" },
  { id: "repairs", label: "Repairs" },
];

interface RepairEntry {
  label: string;
  health: number;
}

export interface ShipyardPanelProps {
  game: Game;
  activeTab: TabId;
  onSetTab: (tab: TabId) => void;
}

export function ShipyardPanel({
  game,
  activeTab,
  onSetTab,
}: ShipyardPanelProps) {
  const prog = game.entities.getSingleton(ProgressionManager);
  const boat = game.entities.getById("boat") as Boat | undefined;

  return (
    <div class="shipyard">
      <div class="shipyard__panel">
        <div class="shipyard__header">
          <div class="shipyard__title">Shipyard</div>
          <div class="shipyard__money">{prog.getMoney()} gold</div>
        </div>

        <div class="shipyard__tabs">
          {SHIPYARD_TABS.map((tab) => (
            <button
              class={`shipyard__tab ${tab.id === activeTab ? "shipyard__tab--active" : ""}`}
              onClick={() => onSetTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "boats" && renderBoatsTab(game, prog)}
        {activeTab === "upgrades" && renderUpgradesTab(game, prog)}
        {activeTab === "repairs" && renderRepairsTab(game, boat)}

        <div class="shipyard__footer">
          Esc to close / Tab to switch tabs / Arrow keys to browse
        </div>
      </div>
    </div>
  );
}

function renderBoatsTab(game: Game, prog: ProgressionManager) {
  return (
    <div class="shipyard__list">
      {BOAT_DEFS.map((def) => {
        const owned = prog.ownsBoat(def.id);
        const isCurrent = def.id === prog.getCurrentBoatId();
        const disabled = isCurrent || (!owned && prog.getMoney() < def.cost);
        const actionLabel = isCurrent ? "" : owned ? "Switch" : "Buy";
        return (
          <button
            class="shipyard__item"
            disabled={disabled}
            onClick={() => executeBoatAction(game, prog, def)}
          >
            <div class="shipyard__item-header">
              <span class="shipyard__item-name">
                {def.name}
                {isCurrent && (
                  <span class="shipyard__badge shipyard__badge--current">
                    {" "}
                    Current
                  </span>
                )}
                {owned && !isCurrent && (
                  <span class="shipyard__badge shipyard__badge--owned">
                    {" "}
                    Owned
                  </span>
                )}
              </span>
              <span class="shipyard__item-cost">
                {actionLabel && (
                  <span class="shipyard__item-action">{actionLabel}</span>
                )}
                {!owned && ` ${def.cost} gold`}
              </span>
            </div>
            <div class="shipyard__item-desc">{def.description}</div>
            {renderDisplayStats(def)}
          </button>
        );
      })}
    </div>
  );
}

function renderDisplayStats(def: BoatDef) {
  const stats = def.displayStats;
  const entries = [
    { label: "SPD", value: stats.speed },
    { label: "STB", value: stats.stability },
    { label: "DUR", value: stats.durability },
    { label: "MAN", value: stats.maneuverability },
  ];
  return (
    <div class="shipyard__stats">
      {entries.map(({ label, value }) => (
        <div class="shipyard__stat">
          <span class="shipyard__stat-label">{label}</span>
          <div class="shipyard__stat-bar">
            <div class="shipyard__stat-fill" style={`width: ${value * 10}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function renderUpgradesTab(game: Game, prog: ProgressionManager) {
  const boatId = prog.getCurrentBoatId();
  const boatDef = getBoatDef(boatId);
  if (!boatDef) {
    return <div class="shipyard__empty">No boat selected.</div>;
  }

  const availableUpgrades = boatDef.availableUpgrades
    .map((id) => getUpgradeDef(id))
    .filter((u): u is UpgradeDef => u !== undefined);

  if (availableUpgrades.length === 0) {
    return (
      <div class="shipyard__empty">No upgrades available for this boat.</div>
    );
  }

  return (
    <div class="shipyard__list">
      {availableUpgrades.map((def) => {
        const purchased = prog.hasUpgrade(boatId, def.id);
        const disabled = purchased || prog.getMoney() < def.cost;
        return (
          <button
            class="shipyard__item"
            disabled={disabled}
            onClick={() => executeUpgradeAction(game, prog, def)}
          >
            <div class="shipyard__item-header">
              <span class="shipyard__item-name">
                {def.name}
                {purchased && (
                  <span class="shipyard__badge shipyard__badge--owned">
                    {" "}
                    Installed
                  </span>
                )}
              </span>
              <span class="shipyard__item-cost">
                {!purchased && (
                  <>
                    <span class="shipyard__item-action">Buy</span>
                    {` ${def.cost} gold`}
                  </>
                )}
              </span>
            </div>
            <div class="shipyard__item-desc">{def.description}</div>
          </button>
        );
      })}
    </div>
  );
}

function getRepairEntries(boat: Boat | undefined): RepairEntry[] {
  if (!boat) return [];
  const entries: RepairEntry[] = [
    { label: "Hull", health: boat.hullDamage.getHealth() },
    { label: "Rudder", health: boat.rudderDamage.getHealth() },
    { label: "Mainsail", health: boat.mainSailDamage.getHealth() },
  ];
  if (boat.jibSailDamage) {
    entries.push({ label: "Jib", health: boat.jibSailDamage.getHealth() });
  }
  return entries;
}

function renderRepairsTab(game: Game, boat: Boat | undefined) {
  const entries = getRepairEntries(boat);
  if (entries.length === 0) {
    return <div class="shipyard__empty">No boat to repair.</div>;
  }

  const anyDamaged = entries.some((e) => e.health < 1);

  return (
    <div class="shipyard__list">
      <div class="shipyard__repair-card">
        {entries.map((entry) => {
          const pct = Math.round(entry.health * 100);
          const fillClass =
            pct >= 70
              ? "shipyard__repair-fill--good"
              : pct >= 40
                ? "shipyard__repair-fill--warn"
                : "shipyard__repair-fill--bad";
          return (
            <div class="shipyard__repair-item">
              <span class="shipyard__repair-label">{entry.label}</span>
              <div class="shipyard__repair-bar">
                <div
                  class={`shipyard__repair-fill ${fillClass}`}
                  style={`width: ${pct}%`}
                />
              </div>
              <span class="shipyard__repair-pct">{pct}%</span>
            </div>
          );
        })}

        <button
          class="shipyard__action shipyard__repair-all"
          disabled={!anyDamaged}
          onClick={() => game.dispatch("repairBoat", {})}
        >
          Repair All (Free)
        </button>
      </div>
    </div>
  );
}

function executeBoatAction(game: Game, prog: ProgressionManager, def: BoatDef) {
  if (prog.ownsBoat(def.id)) {
    if (def.id !== prog.getCurrentBoatId()) {
      game.dispatch("switchBoat", { boatId: def.id });
    }
  } else {
    if (prog.getMoney() >= def.cost) {
      game.dispatch("buyBoat", { boatId: def.id });
    }
  }
}

function executeUpgradeAction(
  game: Game,
  prog: ProgressionManager,
  def: UpgradeDef,
) {
  const boatId = prog.getCurrentBoatId();
  if (!prog.hasUpgrade(boatId, def.id) && prog.getMoney() >= def.cost) {
    game.dispatch("buyUpgrade", { boatId, upgradeId: def.id });
  }
}
