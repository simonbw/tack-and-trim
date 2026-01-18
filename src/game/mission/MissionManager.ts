import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { KeyCode } from "../../core/io/Keys";
import { V, type ReadonlyV2d } from "../../core/Vector";
import type { Boat } from "../boat/Boat";
import { WaterInfo } from "../water/WaterInfo";
import { WindInfo } from "../wind/WindInfo";
import type { MissionContext } from "./MissionContext";
import { MissionPersistence } from "./MissionPersistence";
import { MissionRegistry } from "./MissionRegistry";
import { MissionSpot, type MissionSpotState } from "./MissionSpot";
import type {
  ActiveMissionState,
  Mission,
  MissionSaveData,
} from "./MissionTypes";
import { createObjectiveChecker, type ObjectiveChecker } from "./objectives";
import { MissionCompletePopup } from "./ui/MissionCompletePopup";
import { MissionPreviewPopup } from "./ui/MissionPreviewPopup";
import { PauseMenu } from "./ui/PauseMenu";
import { Waypoint } from "./Waypoint";

/**
 * Central manager for the mission system.
 * Coordinates mission spots, active mission state, and UI.
 */
export class MissionManager extends BaseEntity {
  id = "missionManager";

  private saveData: MissionSaveData;
  private missionSpots: MissionSpot[] = [];

  // Active mission state
  private activeMission: ActiveMissionState | null = null;
  private activeMissionDef: Mission | null = null;
  private objectiveCheckers: ObjectiveChecker[] = [];
  private activeWaypoints: Waypoint[] = [];
  private context: MissionContext | null = null;
  private previousBoatPosition: ReadonlyV2d = V(0, 0);

  // UI state
  private previewPopup: MissionPreviewPopup | null = null;
  private currentPreviewSpot: MissionSpot | null = null;
  private pauseMenu: PauseMenu | null = null;
  private completePopup: MissionCompletePopup | null = null;

  // Track if we need to show completion popup after mission ends
  private pendingCompletion: {
    mission: Mission;
    success: boolean;
    time: number;
    failReason?: string;
  } | null = null;

  constructor() {
    super();
    this.saveData = MissionPersistence.load();
  }

  @on("afterAdded")
  onAfterAdded(): void {
    // Spawn mission spots for all registered missions
    this.spawnMissionSpots();
  }

  private spawnMissionSpots(): void {
    const missions = MissionRegistry.getAll();

    for (const mission of missions) {
      const state = this.getMissionSpotState(mission);
      const spot = new MissionSpot(mission, state);

      // Set up interaction callback
      spot.onInteract = () => this.startMission(mission.id);

      this.game!.addEntity(spot);
      this.missionSpots.push(spot);
    }
  }

  private getMissionSpotState(mission: Mission): MissionSpotState {
    if (!MissionRegistry.isUnlocked(mission, this.saveData)) {
      return "locked";
    }
    if (this.activeMission?.missionId === mission.id) {
      return "active";
    }
    if (mission.id in this.saveData.completedMissions) {
      return "completed";
    }
    return "available";
  }

  /**
   * Refresh all mission spot states (e.g., after completing a mission).
   */
  private refreshMissionSpots(): void {
    this.saveData = MissionPersistence.load();

    for (const spot of this.missionSpots) {
      const state = this.getMissionSpotState(spot.getMission());
      spot.setState(state);
    }
  }

  /**
   * Start a mission by ID.
   */
  startMission(missionId: string): void {
    const mission = MissionRegistry.get(missionId);
    if (!mission) {
      console.warn(`Mission "${missionId}" not found`);
      return;
    }

    if (this.activeMission) {
      console.warn("Cannot start mission while another is active");
      return;
    }

    // Get boat reference
    const boat = this.game!.entities.getById("boat") as Boat | undefined;
    if (!boat) {
      console.warn("Cannot start mission: boat not found");
      return;
    }

    // Initialize mission state
    const startTime = performance.now();
    const startPosition = boat.getPosition().clone();

    this.activeMission = {
      missionId,
      startTime,
      objectiveStates: mission.objectives.map(() => ({
        complete: false,
      })),
      currentObjectiveIndex: 0,
      failed: false,
    };

    this.activeMissionDef = mission;
    this.previousBoatPosition = startPosition;

    // Create objective checkers
    this.objectiveCheckers = mission.objectives.map((def) =>
      createObjectiveChecker(def)
    );

    // Initialize context
    this.context = {
      boat,
      windInfo: WindInfo.fromGame(this.game!),
      waterInfo: WaterInfo.fromGame(this.game!),
      missionStartPosition: startPosition,
      missionStartTime: startTime,
      currentTime: startTime,
      elapsedTime: 0,
      previousBoatPosition: startPosition,
    };

    // Create waypoints for objectives
    this.setupWaypoints(mission);

    // Update spot state
    const spot = this.missionSpots.find((s) => s.getMission().id === missionId);
    if (spot) {
      spot.setState("active");
    }

    // Hide preview popup
    this.hidePreview();

    // Dispatch event
    this.game!.dispatch("missionStarted", { missionId });

    // Activate first objective's waypoint
    this.updateActiveWaypoint();
  }

  private setupWaypoints(mission: Mission): void {
    // Clean up any existing waypoints
    this.clearWaypoints();

    // Create waypoints for reach and checkpoint objectives
    for (let i = 0; i < mission.objectives.length; i++) {
      const obj = mission.objectives[i];

      if (obj.type === "reach") {
        const waypoint = new Waypoint(obj.position, obj.radius, obj.label);
        waypoint.setState("inactive");
        this.game!.addEntity(waypoint);
        this.activeWaypoints.push(waypoint);
      } else if (obj.type === "checkpoint") {
        // Create waypoint for each checkpoint
        for (let j = 0; j < obj.waypoints.length; j++) {
          const label = obj.labels?.[j];
          const waypoint = new Waypoint(obj.waypoints[j], obj.radius, label);
          waypoint.setState("inactive");
          this.game!.addEntity(waypoint);
          this.activeWaypoints.push(waypoint);
        }
      }
    }
  }

  private clearWaypoints(): void {
    for (const waypoint of this.activeWaypoints) {
      waypoint.destroy();
    }
    this.activeWaypoints = [];
  }

  private updateActiveWaypoint(): void {
    if (!this.activeMission) return;

    const currentIndex = this.activeMission.currentObjectiveIndex;

    // Update all waypoints
    for (let i = 0; i < this.activeWaypoints.length; i++) {
      if (i < currentIndex) {
        this.activeWaypoints[i].setState("completed");
      } else if (i === currentIndex) {
        this.activeWaypoints[i].setState("active");
      } else {
        this.activeWaypoints[i].setState("inactive");
      }
    }
  }

  /**
   * Complete the current mission successfully.
   */
  private completeMission(): void {
    if (!this.activeMission || !this.activeMissionDef) return;

    const elapsedTime =
      (performance.now() - this.activeMission.startTime) / 1000;

    // Save completion
    MissionPersistence.markMissionComplete(
      this.activeMission.missionId,
      elapsedTime
    );

    // Dispatch event
    this.game!.dispatch("missionComplete", {
      missionId: this.activeMission.missionId,
      time: elapsedTime,
    });

    // Check for newly unlocked missions
    this.checkNewUnlocks();

    // Store pending completion for popup
    this.pendingCompletion = {
      mission: this.activeMissionDef,
      success: true,
      time: elapsedTime,
    };

    // Clean up mission state (but not UI yet)
    this.endMission();

    // Show completion popup
    this.showCompletionPopup();
  }

  /**
   * Fail the current mission.
   */
  private failMission(reason: string): void {
    if (!this.activeMission || !this.activeMissionDef) return;

    const elapsedTime =
      (performance.now() - this.activeMission.startTime) / 1000;

    this.activeMission.failed = true;
    this.activeMission.failReason = reason;

    // Dispatch event
    this.game!.dispatch("missionFailed", {
      missionId: this.activeMission.missionId,
      reason,
    });

    // Store pending completion for popup
    this.pendingCompletion = {
      mission: this.activeMissionDef,
      success: false,
      time: elapsedTime,
      failReason: reason,
    };

    // Clean up mission state (but not UI yet)
    this.endMission();

    // Show completion popup
    this.showCompletionPopup();
  }

  /**
   * Show the mission completion popup.
   */
  private showCompletionPopup(): void {
    if (!this.pendingCompletion) return;

    const { mission, success, time, failReason } = this.pendingCompletion;
    const bestTime = MissionPersistence.getMissionCompletion(mission.id)?.bestTime;

    // Pause the game while showing popup
    this.game!.pause();

    // Create popup
    this.completePopup = this.game!.addEntity(
      new MissionCompletePopup({
        mission,
        success,
        time,
        bestTime,
        failReason,
      })
    );

    // Set up callbacks
    this.completePopup.onRetry = () => {
      this.hideCompletionPopup();
      this.game!.unpause();
      this.startMission(mission.id);
    };

    this.completePopup.onLeave = () => {
      this.hideCompletionPopup();
      this.game!.unpause();
    };

    // Render immediately
    this.completePopup.reactRender();

    this.pendingCompletion = null;
  }

  /**
   * Hide the completion popup.
   */
  private hideCompletionPopup(): void {
    if (this.completePopup) {
      this.completePopup.destroy();
      this.completePopup = null;
    }
  }

  /**
   * Quit the current mission.
   */
  quitMission(): void {
    if (!this.activeMission) return;

    // Dispatch event
    this.game!.dispatch("missionQuit", {
      missionId: this.activeMission.missionId,
    });

    this.endMission();
  }

  /**
   * Restart the current mission.
   */
  restartMission(): void {
    if (!this.activeMission) return;

    const missionId = this.activeMission.missionId;
    this.endMission();
    this.startMission(missionId);
  }

  /**
   * Clean up after mission ends (success, failure, or quit).
   */
  private endMission(): void {
    this.clearWaypoints();
    this.objectiveCheckers = [];
    this.activeMission = null;
    this.activeMissionDef = null;
    this.context = null;

    // Refresh spot states
    this.refreshMissionSpots();
  }

  /**
   * Check if any new missions were unlocked.
   */
  private checkNewUnlocks(): void {
    const newSaveData = MissionPersistence.load();
    const missions = MissionRegistry.getAll();

    for (const mission of missions) {
      const wasUnlocked = MissionRegistry.isUnlocked(mission, this.saveData);
      const isNowUnlocked = MissionRegistry.isUnlocked(mission, newSaveData);

      if (!wasUnlocked && isNowUnlocked) {
        this.game!.dispatch("missionUnlocked", { missionId: mission.id });
      }
    }

    this.saveData = newSaveData;
  }

  /**
   * Get the currently active mission, if any.
   */
  getActiveMission(): ActiveMissionState | null {
    return this.activeMission;
  }

  /**
   * Get the definition of the active mission, if any.
   */
  getActiveMissionDef(): Mission | null {
    return this.activeMissionDef;
  }

  /**
   * Check if a mission is currently active.
   */
  isMissionActive(): boolean {
    return this.activeMission !== null;
  }

  /**
   * Get elapsed time of current mission in seconds.
   */
  getElapsedTime(): number {
    if (!this.activeMission) return 0;
    return (performance.now() - this.activeMission.startTime) / 1000;
  }

  @on("tick")
  onTick(dt: number): void {
    this.updateProximityUI();

    if (this.activeMission && this.context) {
      this.updateActiveMission(dt);
    }
  }

  private updateProximityUI(): void {
    // Find the closest available spot that player is in range of
    let closestSpot: MissionSpot | null = null;

    for (const spot of this.missionSpots) {
      if (spot.isPlayerInRange() && spot.getState() !== "locked") {
        // If already have a closest, skip (could add distance check)
        if (!closestSpot) {
          closestSpot = spot;
        }
      }
    }

    // Show/hide preview based on proximity
    if (closestSpot && closestSpot.getState() !== "active") {
      if (this.currentPreviewSpot !== closestSpot) {
        this.showPreview(closestSpot);
      }
    } else if (this.currentPreviewSpot) {
      this.hidePreview();
    }
  }

  private showPreview(spot: MissionSpot): void {
    const mission = spot.getMission();
    const completion = MissionPersistence.getMissionCompletion(mission.id);

    if (!this.previewPopup) {
      this.previewPopup = this.game!.addEntity(
        new MissionPreviewPopup({
          mission,
          isCompleted: !!completion,
          bestTime: completion?.bestTime,
        })
      );
    } else {
      this.previewPopup.updateMission(mission);
      this.previewPopup.show();
    }

    this.currentPreviewSpot = spot;
  }

  private hidePreview(): void {
    if (this.previewPopup) {
      this.previewPopup.hide();
    }
    this.currentPreviewSpot = null;
  }

  private updateActiveMission(dt: number): void {
    if (!this.activeMission || !this.activeMissionDef || !this.context) return;

    const boat = this.context.boat;

    // Update context
    const now = performance.now();
    this.context.currentTime = now;
    this.context.elapsedTime = (now - this.activeMission.startTime) / 1000;
    this.context.previousBoatPosition = this.previousBoatPosition;
    this.previousBoatPosition = boat.getPosition().clone();

    // Check time limit
    if (this.activeMissionDef.timeLimit) {
      if (this.context.elapsedTime > this.activeMissionDef.timeLimit) {
        this.failMission("Time limit exceeded");
        return;
      }
    }

    // Check current objective
    const currentIndex = this.activeMission.currentObjectiveIndex;
    if (currentIndex >= this.objectiveCheckers.length) {
      // All objectives complete
      this.completeMission();
      return;
    }

    const checker = this.objectiveCheckers[currentIndex];
    const result = checker.check(this.context);

    if (result.status === "complete") {
      // Update state
      this.activeMission.objectiveStates[currentIndex].complete = true;
      this.activeMission.currentObjectiveIndex++;

      // Dispatch event
      this.game!.dispatch("missionObjectiveComplete", {
        missionId: this.activeMission.missionId,
        objectiveIndex: currentIndex,
      });

      // Update waypoint states
      this.updateActiveWaypoint();

      // Check if that was the last objective
      if (
        this.activeMission.currentObjectiveIndex >=
        this.objectiveCheckers.length
      ) {
        this.completeMission();
      }
    } else if (result.status === "failed") {
      this.failMission(result.reason);
    }
  }

  @on("tutorialComplete")
  onTutorialComplete(): void {
    // Mark tutorial as complete in persistence
    MissionPersistence.markTutorialComplete();
    // Refresh spots to show newly unlocked missions
    this.refreshMissionSpots();
  }

  @on("keyDown")
  onKeyDown(keyCode: KeyCode): void {
    if (keyCode === "Escape") {
      this.handleEscape();
    }
  }

  /**
   * Handle Escape key press - toggle pause menu.
   */
  private handleEscape(): void {
    // Don't open pause if completion popup is showing
    if (this.completePopup) return;

    if (this.game!.paused && this.pauseMenu) {
      // Unpause
      this.hidePauseMenu();
      this.game!.unpause();
    } else if (!this.game!.paused) {
      // Pause
      this.game!.pause();
      this.showPauseMenu();
    }
  }

  /**
   * Show the pause menu.
   */
  private showPauseMenu(): void {
    this.pauseMenu = this.game!.addEntity(
      new PauseMenu({
        activeMission: this.activeMissionDef ?? undefined,
        elapsedTime: this.activeMission
          ? (performance.now() - this.activeMission.startTime) / 1000
          : undefined,
      })
    );

    // Set up callbacks
    this.pauseMenu.onResume = () => {
      this.hidePauseMenu();
      this.game!.unpause();
    };

    this.pauseMenu.onRestartMission = () => {
      if (this.activeMission) {
        const missionId = this.activeMission.missionId;
        this.hidePauseMenu();
        this.endMission();
        this.game!.unpause();
        this.startMission(missionId);
      }
    };

    this.pauseMenu.onEndMission = () => {
      if (this.activeMission) {
        this.hidePauseMenu();
        this.quitMission();
        this.game!.unpause();
      }
    };

    this.pauseMenu.onQuitToMenu = () => {
      // For now, just refresh the page to go back to menu
      // In a real implementation, you'd dispatch a gameQuit event
      window.location.reload();
    };

    // Render immediately
    this.pauseMenu.reactRender();
  }

  /**
   * Hide the pause menu.
   */
  private hidePauseMenu(): void {
    if (this.pauseMenu) {
      this.pauseMenu.destroy();
      this.pauseMenu = null;
    }
  }

  @on("destroy")
  onDestroy(): void {
    // Clean up waypoints
    this.clearWaypoints();

    // Clean up spots
    for (const spot of this.missionSpots) {
      spot.destroy();
    }
    this.missionSpots = [];

    // Clean up UI
    if (this.previewPopup) {
      this.previewPopup.destroy();
      this.previewPopup = null;
    }
    if (this.pauseMenu) {
      this.pauseMenu.destroy();
      this.pauseMenu = null;
    }
    if (this.completePopup) {
      this.completePopup.destroy();
      this.completePopup = null;
    }
  }
}
