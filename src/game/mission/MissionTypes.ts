import type { ReadonlyV2d } from "../../core/Vector";

/** Difficulty rating from 1 (easiest) to 5 (hardest) */
export type MissionDifficulty = 1 | 2 | 3 | 4 | 5;

/** Mission categories for organization and unlock requirements */
export type MissionCategory = "training" | "racing" | "exploration" | "challenge";

/**
 * Core mission definition - describes a mission that can be started from the world.
 */
export interface Mission {
  /** Unique identifier for this mission */
  id: string;

  /** Display name shown to player */
  name: string;

  /** Description explaining what the mission involves */
  description: string;

  /** Difficulty rating */
  difficulty: MissionDifficulty;

  /** Category for grouping and unlock requirements */
  category: MissionCategory;

  /** World position where the mission spot is located */
  spotPosition: ReadonlyV2d;

  /** Conditions that must be met to unlock this mission */
  unlockConditions: UnlockCondition[];

  /** The objectives to complete this mission */
  objectives: ObjectiveDefinition[];

  /** Optional time limit in seconds - mission fails if exceeded */
  timeLimit?: number;

  /** Optional rewards for completing this mission */
  rewards?: MissionReward;
}

/**
 * Conditions that determine if a mission is unlocked.
 * Multiple conditions are AND'd together.
 */
export type UnlockCondition =
  | { type: "always" } // Always unlocked
  | { type: "tutorialComplete" } // Tutorial must be finished
  | { type: "missionComplete"; missionId: string } // Specific mission must be done
  | { type: "missionCount"; count: number; category?: MissionCategory }; // N missions completed

/**
 * Definitions for mission objectives.
 * Each type has specific parameters for validation.
 */
export type ObjectiveDefinition =
  | ReachObjectiveDefinition
  | CheckpointObjectiveDefinition
  | GateObjectiveDefinition
  | SpeedObjectiveDefinition
  | HeadingObjectiveDefinition
  | SurvivalObjectiveDefinition;

/** Sail to a target location */
export interface ReachObjectiveDefinition {
  type: "reach";
  /** Target position in world coordinates */
  position: ReadonlyV2d;
  /** Radius around the position that counts as "reached" */
  radius: number;
  /** Optional label for this waypoint */
  label?: string;
}

/** Pass through a series of waypoints in order */
export interface CheckpointObjectiveDefinition {
  type: "checkpoint";
  /** Ordered list of waypoint positions */
  waypoints: ReadonlyV2d[];
  /** Radius for each waypoint */
  radius: number;
  /** Optional labels for each waypoint */
  labels?: string[];
}

/** Pass through a gate (line between two points) */
export interface GateObjectiveDefinition {
  type: "gate";
  /** Start point of the gate line */
  start: ReadonlyV2d;
  /** End point of the gate line */
  end: ReadonlyV2d;
  /** Optional label for this gate */
  label?: string;
}

/** Achieve or maintain a target speed */
export interface SpeedObjectiveDefinition {
  type: "speed";
  /** Target speed in knots */
  targetKnots: number;
  /** How long the speed must be maintained (seconds) */
  duration: number;
}

/** Maintain a specific heading */
export interface HeadingObjectiveDefinition {
  type: "heading";
  /** Target heading in radians */
  targetAngle: number;
  /** Acceptable deviation in radians */
  tolerance: number;
  /** How long the heading must be maintained (seconds) */
  duration: number;
}

/** Complete the mission without failing conditions */
export interface SurvivalObjectiveDefinition {
  type: "survival";
  /** Fail if any collision occurs */
  noCollisions?: boolean;
}

/**
 * Rewards granted when a mission is completed.
 */
export interface MissionReward {
  /** Achievement unlocked on completion */
  unlocksAchievement?: string;
  // Future: cosmetics, boat upgrades, etc.
}

/**
 * Runtime state for an active mission.
 */
export interface ActiveMissionState {
  /** ID of the mission being played */
  missionId: string;

  /** Timestamp when the mission started */
  startTime: number;

  /** Current state of each objective */
  objectiveStates: ObjectiveState[];

  /** Index of the current active objective */
  currentObjectiveIndex: number;

  /** Whether the mission has failed */
  failed: boolean;

  /** Reason for failure if failed */
  failReason?: string;
}

/**
 * Runtime state for a single objective.
 */
export interface ObjectiveState {
  /** Whether this objective is complete */
  complete: boolean;

  /** Progress value (interpretation depends on objective type) */
  progress?: number;

  /** Additional state data (e.g., which checkpoints have been passed) */
  data?: unknown;
}

/**
 * Persisted save data for mission progress.
 */
export interface MissionSaveData {
  /** Map of mission ID to completion info */
  completedMissions: Record<string, MissionCompletion>;

  /** Whether the tutorial has been completed */
  tutorialComplete: boolean;
}

/**
 * Information about a completed mission.
 */
export interface MissionCompletion {
  /** Timestamp of first completion */
  completedAt: number;

  /** Best completion time in seconds */
  bestTime?: number;

  /** IDs of bonus objectives that were completed */
  bonusObjectivesCompleted?: string[];
}
