import { ReactEntity } from "../../core/ReactEntity";
import { on } from "../../core/entity/handler";
import { KeyCode } from "../../core/io/Keys";
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

type TabId = "boats" | "upgrades" | "repairs";
const TABS: { id: TabId; label: string }[] = [
  { id: "boats", label: "Boats" },
  { id: "upgrades", label: "Upgrades" },
  { id: "repairs", label: "Repairs" },
];

interface RepairEntry {
  label: string;
  health: number;
}

export class ShipyardUI extends ReactEntity {
  private activeTab: TabId = "boats";
  private selectedIndex = 0;

  constructor() {
    super(() => this.renderContent());
  }

  private get progression(): ProgressionManager {
    return this.game.entities.getSingleton(ProgressionManager);
  }

  private get boat(): Boat | undefined {
    return this.game.entities.getById("boat") as Boat | undefined;
  }

  // ============================================
  // Render
  // ============================================

  private renderContent() {
    const prog = this.progression;
    return (
      <div class="shipyard">
        <div class="shipyard__panel">
          <div class="shipyard__header">
            <div class="shipyard__title">Shipyard</div>
            <div class="shipyard__money">{prog.getMoney()} gold</div>
          </div>

          <div class="shipyard__tabs">
            {TABS.map((tab) => (
              <button
                class={`shipyard__tab ${tab.id === this.activeTab ? "shipyard__tab--active" : ""}`}
                onClick={() => this.setTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {this.activeTab === "boats" && this.renderBoatsTab(prog)}
          {this.activeTab === "upgrades" && this.renderUpgradesTab(prog)}
          {this.activeTab === "repairs" && this.renderRepairsTab()}

          <div class="shipyard__footer">
            Esc to close / Tab to switch tabs / Arrow keys to browse
          </div>
        </div>
      </div>
    );
  }

  // ============================================
  // Boats Tab
  // ============================================

  private renderBoatsTab(prog: ProgressionManager) {
    return (
      <div class="shipyard__list">
        {BOAT_DEFS.map((def, i) => {
          const owned = prog.ownsBoat(def.id);
          const isCurrent = def.id === prog.getCurrentBoatId();
          return (
            <div
              class={`shipyard__item ${i === this.selectedIndex ? "shipyard__item--selected" : ""}`}
              onClick={() => {
                this.selectedIndex = i;
                this.executeBoatAction(def);
              }}
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
                  {owned ? "" : `${def.cost} gold`}
                </span>
              </div>
              <div class="shipyard__item-desc">{def.description}</div>
              {this.renderDisplayStats(def)}
              {i === this.selectedIndex && !isCurrent && (
                <button
                  class={`shipyard__action ${!owned && prog.getMoney() < def.cost ? "shipyard__action--disabled" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    this.executeBoatAction(def);
                  }}
                >
                  {owned ? "Switch" : "Buy"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  private renderDisplayStats(def: BoatDef) {
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
              <div
                class="shipyard__stat-fill"
                style={`width: ${value * 10}%`}
              />
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ============================================
  // Upgrades Tab
  // ============================================

  private renderUpgradesTab(prog: ProgressionManager) {
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
        {availableUpgrades.map((def, i) => {
          const purchased = prog.hasUpgrade(boatId, def.id);
          return (
            <div
              class={`shipyard__item ${i === this.selectedIndex ? "shipyard__item--selected" : ""}`}
              onClick={() => {
                this.selectedIndex = i;
                if (!purchased) this.executeUpgradeAction(def);
              }}
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
                  {purchased ? "" : `${def.cost} gold`}
                </span>
              </div>
              <div class="shipyard__item-desc">{def.description}</div>
              {i === this.selectedIndex && !purchased && (
                <button
                  class={`shipyard__action ${prog.getMoney() < def.cost ? "shipyard__action--disabled" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    this.executeUpgradeAction(def);
                  }}
                >
                  Buy
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ============================================
  // Repairs Tab
  // ============================================

  private getRepairEntries(): RepairEntry[] {
    const boat = this.boat;
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

  private renderRepairsTab() {
    const entries = this.getRepairEntries();
    if (entries.length === 0) {
      return <div class="shipyard__empty">No boat to repair.</div>;
    }

    const anyDamaged = entries.some((e) => e.health < 1);

    return (
      <div class="shipyard__list">
        <div class="shipyard__item">
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
            class={`shipyard__action shipyard__repair-all ${!anyDamaged ? "shipyard__action--disabled" : ""}`}
            onClick={() => this.executeRepair()}
          >
            Repair All (Free)
          </button>
        </div>
      </div>
    );
  }

  // ============================================
  // Actions
  // ============================================

  private executeBoatAction(def: BoatDef) {
    const prog = this.progression;
    if (prog.ownsBoat(def.id)) {
      if (def.id !== prog.getCurrentBoatId()) {
        this.game.dispatch("switchBoat", { boatId: def.id });
      }
    } else {
      if (prog.getMoney() >= def.cost) {
        this.game.dispatch("buyBoat", { boatId: def.id });
      }
    }
  }

  private executeUpgradeAction(def: UpgradeDef) {
    const prog = this.progression;
    const boatId = prog.getCurrentBoatId();
    if (!prog.hasUpgrade(boatId, def.id) && prog.getMoney() >= def.cost) {
      this.game.dispatch("buyUpgrade", { boatId, upgradeId: def.id });
    }
  }

  private executeRepair() {
    this.game.dispatch("repairBoat", {});
  }

  private close() {
    this.game.dispatch("closeShipyard", {});
    this.destroy();
  }

  // ============================================
  // Tab Switching
  // ============================================

  private setTab(tab: TabId) {
    this.activeTab = tab;
    this.selectedIndex = 0;
  }

  private cycleTab(direction: 1 | -1) {
    const currentIdx = TABS.findIndex((t) => t.id === this.activeTab);
    const nextIdx = (currentIdx + direction + TABS.length) % TABS.length;
    this.setTab(TABS[nextIdx].id);
  }

  private getListLength(): number {
    if (this.activeTab === "boats") return BOAT_DEFS.length;
    if (this.activeTab === "upgrades") {
      const boatDef = getBoatDef(this.progression.getCurrentBoatId());
      return boatDef ? boatDef.availableUpgrades.length : 0;
    }
    return 0; // repairs tab has no selectable list
  }

  // ============================================
  // Keyboard Navigation
  // ============================================

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "Escape") {
      this.close();
      return;
    }

    if (key === "Tab") {
      this.cycleTab(1);
      return;
    }

    const listLen = this.getListLength();

    if (key === "ArrowUp") {
      if (listLen > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + listLen) % listLen;
      }
    } else if (key === "ArrowDown") {
      if (listLen > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % listLen;
      }
    } else if (key === "ArrowLeft") {
      this.cycleTab(-1);
    } else if (key === "ArrowRight") {
      this.cycleTab(1);
    } else if (key === "Enter" || key === "Space") {
      this.executeSelected();
    }
  }

  private executeSelected() {
    if (this.activeTab === "boats") {
      const def = BOAT_DEFS[this.selectedIndex];
      if (def) this.executeBoatAction(def);
    } else if (this.activeTab === "upgrades") {
      const boatDef = getBoatDef(this.progression.getCurrentBoatId());
      if (boatDef) {
        const upgradeId = boatDef.availableUpgrades[this.selectedIndex];
        const def = upgradeId ? getUpgradeDef(upgradeId) : undefined;
        if (def) this.executeUpgradeAction(def);
      }
    } else if (this.activeTab === "repairs") {
      this.executeRepair();
    }
  }
}
