import { on } from "../../core/entity/handler";
import { KeyCode } from "../../core/io/Keys";
import { Modal } from "../../core/ui/Modal";
import { focusFirst, moveFocus } from "../../core/util/menuNav";
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

export class ShipyardUI extends Modal {
  private activeTab: TabId = "boats";

  constructor() {
    super(() => this.renderContent());
  }

  @on("afterAdded")
  onAfterAdded() {
    this.reactRender();
    this.focusActiveList();
  }

  private get progression(): ProgressionManager {
    return this.game.entities.getSingleton(ProgressionManager);
  }

  private get boat(): Boat | undefined {
    return this.game.entities.getById("boat") as Boat | undefined;
  }

  private getListContainer(): HTMLElement | null {
    return this.el.querySelector<HTMLElement>(".shipyard__list");
  }

  private focusActiveList() {
    const list = this.getListContainer();
    if (list) focusFirst(list);
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
        {BOAT_DEFS.map((def) => {
          const owned = prog.ownsBoat(def.id);
          const isCurrent = def.id === prog.getCurrentBoatId();
          const disabled = isCurrent || (!owned && prog.getMoney() < def.cost);
          const actionLabel = isCurrent ? "" : owned ? "Switch" : "Buy";
          return (
            <button
              class="shipyard__item"
              disabled={disabled}
              onClick={() => this.executeBoatAction(def)}
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
              {this.renderDisplayStats(def)}
            </button>
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
        {availableUpgrades.map((def) => {
          const purchased = prog.hasUpgrade(boatId, def.id);
          const disabled = purchased || prog.getMoney() < def.cost;
          return (
            <button
              class="shipyard__item"
              disabled={disabled}
              onClick={() => this.executeUpgradeAction(def)}
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
    this.reactRender();
    this.focusActiveList();
  }

  private cycleTab(direction: 1 | -1) {
    const currentIdx = TABS.findIndex((t) => t.id === this.activeTab);
    const nextIdx = (currentIdx + direction + TABS.length) % TABS.length;
    this.setTab(TABS[nextIdx].id);
  }

  // ============================================
  // Keyboard Navigation
  // ============================================

  onEscape() {
    this.close();
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "Tab" || key === "ArrowRight") {
      this.cycleTab(1);
      return;
    }
    if (key === "ArrowLeft") {
      this.cycleTab(-1);
      return;
    }

    const list = this.getListContainer();
    if (!list) return;

    if (key === "ArrowUp") {
      moveFocus(list, -1);
    } else if (key === "ArrowDown") {
      moveFocus(list, +1);
    }
  }
}
