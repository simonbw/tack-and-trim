import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { Boat } from "../boat/Boat";
import { getBoatDef, getUpgradeDef } from "../catalog/BoatCatalog";

/**
 * Singleton entity that tracks player progression state:
 * money, owned boats, installed upgrades, and current boat.
 *
 * Listens for buy/switch/repair events from the ShipyardUI and processes them.
 */
export class ProgressionManager extends BaseEntity {
  id = "progressionManager";

  private money: number = 0;
  private currentBoatId: string = "shaff-s7";

  /** Map of boat ID -> set of owned upgrade IDs */
  private ownedBoats: Map<string, Set<string>> = new Map();

  constructor() {
    super();
    this.ownedBoats.set("shaff-s7", new Set());
  }

  // ============================================
  // Money
  // ============================================

  getMoney(): number {
    return this.money;
  }

  spendMoney(amount: number): boolean {
    if (amount > this.money) return false;
    this.money -= amount;
    return true;
  }

  addMoney(amount: number): void {
    this.money += amount;
  }

  // ============================================
  // Boats
  // ============================================

  getOwnedBoats(): string[] {
    return [...this.ownedBoats.keys()];
  }

  getCurrentBoatId(): string {
    return this.currentBoatId;
  }

  ownsBoat(id: string): boolean {
    return this.ownedBoats.has(id);
  }

  // ============================================
  // Upgrades
  // ============================================

  hasUpgrade(boatId: string, upgradeId: string): boolean {
    const upgrades = this.ownedBoats.get(boatId);
    return upgrades !== undefined && upgrades.has(upgradeId);
  }

  getUpgradesForBoat(boatId: string): string[] {
    const upgrades = this.ownedBoats.get(boatId);
    return upgrades ? [...upgrades] : [];
  }

  // ============================================
  // Actions
  // ============================================

  buyBoat(boatId: string): boolean {
    if (this.ownsBoat(boatId)) return false;
    const def = getBoatDef(boatId);
    if (!def) return false;
    if (!this.spendMoney(def.cost)) return false;
    this.ownedBoats.set(boatId, new Set());
    return true;
  }

  buyUpgrade(boatId: string, upgradeId: string): boolean {
    if (!this.ownsBoat(boatId)) return false;
    if (this.hasUpgrade(boatId, upgradeId)) return false;
    const def = getUpgradeDef(upgradeId);
    if (!def) return false;
    if (!this.spendMoney(def.cost)) return false;
    this.ownedBoats.get(boatId)!.add(upgradeId);
    return true;
  }

  switchBoat(boatId: string): boolean {
    if (!this.ownsBoat(boatId)) return false;
    if (boatId === this.currentBoatId) return false;
    this.currentBoatId = boatId;
    return true;
  }

  // ============================================
  // Event Handlers
  // ============================================

  @on("buyBoat")
  onBuyBoat({ boatId }: { boatId: string }) {
    this.buyBoat(boatId);
  }

  @on("buyUpgrade")
  onBuyUpgrade({ boatId, upgradeId }: { boatId: string; upgradeId: string }) {
    this.buyUpgrade(boatId, upgradeId);
  }

  @on("switchBoat")
  onSwitchBoat({ boatId }: { boatId: string }) {
    this.switchBoat(boatId);
  }

  /** Restore state from a save file's progression data. */
  restoreFromSave(data: {
    money: number;
    currentBoatId: string;
    ownedBoats: { boatId: string; purchasedUpgrades: string[] }[];
  }): void {
    this.money = data.money;
    this.currentBoatId = data.currentBoatId;
    this.ownedBoats.clear();
    for (const { boatId, purchasedUpgrades } of data.ownedBoats) {
      this.ownedBoats.set(boatId, new Set(purchasedUpgrades));
    }
  }

  @on("repairBoat")
  onRepairBoat() {
    const boat = this.game.entities.getById("boat") as Boat | undefined;
    if (!boat) return;

    // Repairs are free for now
    boat.hullDamage.setHealth(1.0);
    boat.rudderDamage.setHealth(1.0);
    boat.mainSailDamage.setHealth(1.0);
    if (boat.jibSailDamage) {
      boat.jibSailDamage.setHealth(1.0);
    }
  }
}
