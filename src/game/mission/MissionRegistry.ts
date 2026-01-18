import type { Mission, MissionCategory, MissionSaveData, UnlockCondition } from "./MissionTypes";
import { MissionPersistence } from "./MissionPersistence";

/**
 * Static registry for all mission definitions.
 * Missions are registered at module load time and queried at runtime.
 */
export class MissionRegistry {
  private static missions: Map<string, Mission> = new Map();

  /**
   * Register a mission definition.
   * Should be called at module load time.
   */
  static register(mission: Mission): void {
    if (this.missions.has(mission.id)) {
      console.warn(`Mission "${mission.id}" is already registered, overwriting`);
    }
    this.missions.set(mission.id, mission);
  }

  /**
   * Get a mission by ID.
   */
  static get(id: string): Mission | undefined {
    return this.missions.get(id);
  }

  /**
   * Get all registered missions.
   */
  static getAll(): Mission[] {
    return Array.from(this.missions.values());
  }

  /**
   * Get all missions that are currently unlocked.
   */
  static getUnlocked(saveData?: MissionSaveData): Mission[] {
    const data = saveData ?? MissionPersistence.load();
    return this.getAll().filter((mission) => this.isUnlocked(mission, data));
  }

  /**
   * Check if a specific mission is unlocked.
   */
  static isUnlocked(mission: Mission, saveData?: MissionSaveData): boolean {
    const data = saveData ?? MissionPersistence.load();

    // All conditions must be met
    return mission.unlockConditions.every((condition) =>
      this.checkCondition(condition, data)
    );
  }

  /**
   * Check a single unlock condition.
   */
  private static checkCondition(
    condition: UnlockCondition,
    saveData: MissionSaveData
  ): boolean {
    switch (condition.type) {
      case "always":
        return true;

      case "tutorialComplete":
        return saveData.tutorialComplete;

      case "missionComplete":
        return condition.missionId in saveData.completedMissions;

      case "missionCount": {
        const completedIds = Object.keys(saveData.completedMissions);

        if (condition.category) {
          // Count only missions in the specified category
          const categoryMissions = completedIds.filter((id) => {
            const mission = this.get(id);
            return mission?.category === condition.category;
          });
          return categoryMissions.length >= condition.count;
        } else {
          return completedIds.length >= condition.count;
        }
      }

      default:
        // Exhaustiveness check
        const _exhaustive: never = condition;
        return false;
    }
  }

  /**
   * Get missions by category.
   */
  static getByCategory(category: MissionCategory): Mission[] {
    return this.getAll().filter((m) => m.category === category);
  }

  /**
   * Get count of registered missions.
   */
  static count(): number {
    return this.missions.size;
  }

  /**
   * Clear all registered missions (for testing).
   */
  static clear(): void {
    this.missions.clear();
  }
}
