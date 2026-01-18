import type { MissionSaveData, MissionCompletion } from "./MissionTypes";

const STORAGE_KEY = "tack-and-trim-missions";

/**
 * Default save data for new players.
 */
function getDefaultSaveData(): MissionSaveData {
  return {
    completedMissions: {},
    tutorialComplete: false,
  };
}

/**
 * Handles persistence of mission progress to localStorage.
 */
export class MissionPersistence {
  /**
   * Load save data from localStorage.
   * Returns default data if nothing is saved or data is corrupted.
   */
  static load(): MissionSaveData {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return getDefaultSaveData();
      }

      const parsed = JSON.parse(raw);

      // Validate structure
      if (
        typeof parsed !== "object" ||
        typeof parsed.completedMissions !== "object" ||
        typeof parsed.tutorialComplete !== "boolean"
      ) {
        console.warn("Invalid mission save data, using defaults");
        return getDefaultSaveData();
      }

      return parsed as MissionSaveData;
    } catch (e) {
      console.warn("Failed to load mission save data:", e);
      return getDefaultSaveData();
    }
  }

  /**
   * Save data to localStorage.
   */
  static save(data: MissionSaveData): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("Failed to save mission data:", e);
    }
  }

  /**
   * Mark a mission as complete and update best time.
   */
  static markMissionComplete(missionId: string, timeSeconds: number): void {
    const data = this.load();

    const existing = data.completedMissions[missionId];
    if (existing) {
      // Update best time if this run was faster
      if (existing.bestTime === undefined || timeSeconds < existing.bestTime) {
        existing.bestTime = timeSeconds;
      }
    } else {
      // First completion
      data.completedMissions[missionId] = {
        completedAt: Date.now(),
        bestTime: timeSeconds,
      };
    }

    this.save(data);
  }

  /**
   * Check if a specific mission has been completed.
   */
  static isMissionComplete(missionId: string): boolean {
    const data = this.load();
    return missionId in data.completedMissions;
  }

  /**
   * Get completion info for a mission, or undefined if not completed.
   */
  static getMissionCompletion(missionId: string): MissionCompletion | undefined {
    const data = this.load();
    return data.completedMissions[missionId];
  }

  /**
   * Get the count of completed missions, optionally filtered by category.
   * Note: Category filtering requires the MissionRegistry to look up mission info.
   */
  static getCompletedMissionCount(): number {
    const data = this.load();
    return Object.keys(data.completedMissions).length;
  }

  /**
   * Check if the tutorial has been completed.
   */
  static isTutorialComplete(): boolean {
    const data = this.load();
    return data.tutorialComplete;
  }

  /**
   * Mark the tutorial as complete.
   */
  static markTutorialComplete(): void {
    const data = this.load();
    data.tutorialComplete = true;
    this.save(data);
  }

  /**
   * Clear all save data (for debugging/testing).
   */
  static clearAll(): void {
    localStorage.removeItem(STORAGE_KEY);
  }
}
