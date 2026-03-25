/**
 * MissionManager - singleton entity that manages the mission/progression system.
 *
 * Tracks available, active, and completed missions. Listens for port mooring
 * events to automatically detect mission completion.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { MissionDef } from "../../editor/io/LevelFileFormat";
import type { ActiveMission } from "./MissionTypes";

export class MissionManager extends BaseEntity {
  id = "missionManager";

  private readonly missionDefs: readonly MissionDef[];
  private activeMission: ActiveMission | null = null;
  private readonly completedMissionIds = new Set<string>();
  private readonly revealedPortIds = new Set<string>();
  private money: number = 0;

  constructor(missions: MissionDef[]) {
    super();
    this.missionDefs = missions;
  }

  /**
   * Get missions available at a given port, filtering by prerequisites.
   */
  getAvailableMissions(portId: string): MissionDef[] {
    return this.missionDefs.filter((mission) => {
      // Must originate from this port
      if (mission.sourcePortId !== portId) return false;
      // Must not already be completed
      if (this.completedMissionIds.has(mission.id)) return false;
      // Must not be the currently active mission
      if (this.activeMission?.def.id === mission.id) return false;
      // All prerequisites must be completed
      if (mission.prerequisites?.completedMissions) {
        for (const prereq of mission.prerequisites.completedMissions) {
          if (!this.completedMissionIds.has(prereq)) return false;
        }
      }
      // Must meet money prerequisite
      if (
        mission.prerequisites?.money !== undefined &&
        this.money < mission.prerequisites.money
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Accept a mission by ID. Sets it as the active mission and dispatches
   * the missionAccepted event.
   */
  acceptMission(missionId: string): void {
    if (this.activeMission !== null) {
      console.warn(
        `[MissionManager] Cannot accept mission "${missionId}" — already have active mission "${this.activeMission.def.id}"`,
      );
      return;
    }

    const def = this.missionDefs.find((m) => m.id === missionId);
    if (!def) {
      console.warn(
        `[MissionManager] Mission "${missionId}" not found in level data`,
      );
      return;
    }

    if (this.completedMissionIds.has(missionId)) {
      console.warn(
        `[MissionManager] Mission "${missionId}" is already completed`,
      );
      return;
    }

    this.activeMission = {
      def,
      startTime: this.game.elapsedTime,
    };

    this.game.dispatch("missionAccepted", { missionId });
  }

  /**
   * Complete the currently active mission, granting rewards.
   */
  completeMission(): void {
    if (!this.activeMission) {
      console.warn("[MissionManager] No active mission to complete");
      return;
    }

    const { def } = this.activeMission;
    const rewards = def.rewards ?? {};

    // Grant money reward
    if (rewards.money) {
      this.money += rewards.money;
    }

    // Reveal ports
    if (rewards.revealPorts) {
      for (const portId of rewards.revealPorts) {
        this.revealedPortIds.add(portId);
      }
    }

    // Track completion
    this.completedMissionIds.add(def.id);
    this.activeMission = null;

    this.game.dispatch("missionCompleted", {
      missionId: def.id,
      rewards: {
        money: rewards.money,
        revealPorts: rewards.revealPorts,
      },
    });
  }

  /**
   * Listen for boat mooring events to check for delivery mission completion.
   */
  @on("boatMoored")
  onBoatMoored({ portId }: { portId: string }): void {
    if (!this.activeMission) return;
    if (this.activeMission.def.type !== "delivery") return;
    if (this.activeMission.def.destinationPortId !== portId) return;

    this.completeMission();
  }

  // ---- State accessors for HUD and save/load ----

  getActiveMission(): ActiveMission | null {
    return this.activeMission;
  }

  getCompletedMissionIds(): ReadonlySet<string> {
    return this.completedMissionIds;
  }

  getRevealedPortIds(): ReadonlySet<string> {
    return this.revealedPortIds;
  }

  getMoney(): number {
    return this.money;
  }

  // ---- Save/load state ----

  /**
   * Get serializable state for the save system.
   */
  getState(): {
    completedMissionIds: string[];
    currentMissionId: string | undefined;
    money: number;
    revealedPortIds: string[];
  } {
    return {
      completedMissionIds: [...this.completedMissionIds],
      currentMissionId: this.activeMission?.def.id,
      money: this.money,
      revealedPortIds: [...this.revealedPortIds],
    };
  }

  /**
   * Restore state from the save system.
   */
  setState(state: {
    completedMissionIds?: string[];
    currentMissionId?: string;
    money?: number;
    revealedPortIds?: string[];
  }): void {
    this.completedMissionIds.clear();
    if (state.completedMissionIds) {
      for (const id of state.completedMissionIds) {
        this.completedMissionIds.add(id);
      }
    }

    this.revealedPortIds.clear();
    if (state.revealedPortIds) {
      for (const id of state.revealedPortIds) {
        this.revealedPortIds.add(id);
      }
    }

    this.money = state.money ?? 0;

    // Restore active mission
    this.activeMission = null;
    if (state.currentMissionId) {
      const def = this.missionDefs.find((m) => m.id === state.currentMissionId);
      if (def) {
        this.activeMission = {
          def,
          startTime: this.game.elapsedTime,
        };
      }
    }
  }
}
