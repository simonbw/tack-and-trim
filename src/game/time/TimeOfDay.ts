/**
 * TimeOfDay entity - tracks game-world time separately from real elapsed time.
 *
 * Singleton entity that provides the source of truth for game-world time.
 * Used for time-dependent effects like tides.
 *
 * Default: 1 real second = 1 game minute (60x time scale),
 * so a full 24-hour cycle = 24 real minutes.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";

/** Seconds in a day */
const SECONDS_PER_DAY = 86400;

/** Seconds per hour */
const SECONDS_PER_HOUR = 3600;

/** Default time scale: game-world seconds per real second (1 = real-time) */
const DEFAULT_TIME_SCALE = 1;

/** Default starting hour (noon) */
const DEFAULT_STARTING_HOUR = 12;

/**
 * Configuration for TimeOfDay entity.
 */
export interface TimeOfDayConfig {
  /** Starting hour (0-24), default: 12 (noon) */
  startingHour?: number;
  /** Game-world seconds per real second, default: 60 */
  timeScale?: number;
}

/**
 * TimeOfDay singleton entity.
 *
 * Tracks game-world time and provides query methods for time-dependent systems.
 */
export class TimeOfDay extends BaseEntity {
  id = "timeOfDay";
  tickLayer = "environment" as const;

  /** Current time in seconds since midnight (0-86400) */
  private timeInSeconds: number;

  /** Time scale: game-world seconds per real second */
  private timeScale: number;

  constructor(config: TimeOfDayConfig = {}) {
    super();

    const startingHour = config.startingHour ?? DEFAULT_STARTING_HOUR;
    this.timeInSeconds = startingHour * SECONDS_PER_HOUR;
    this.timeScale = config.timeScale ?? DEFAULT_TIME_SCALE;
  }

  /**
   * Advance time each tick.
   */
  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    if (this.game.io.isKeyDown("KeyT")) {
      this.timeInSeconds += dt * this.timeScale * 5000;
    } else {
      this.timeInSeconds += dt * this.timeScale;
    }

    // Wrap at 24 hours
    while (this.timeInSeconds >= SECONDS_PER_DAY) {
      this.timeInSeconds -= SECONDS_PER_DAY;
    }
    while (this.timeInSeconds < 0) {
      this.timeInSeconds += SECONDS_PER_DAY;
    }
  }

  /**
   * Get the current hour (0-24, can be fractional).
   */
  getHour(): number {
    return this.timeInSeconds / SECONDS_PER_HOUR;
  }

  /**
   * Get the current time in seconds since midnight.
   */
  getTimeInSeconds(): number {
    return this.timeInSeconds;
  }

  /**
   * Set the time scale (game-world seconds per real second).
   */
  setTimeScale(scale: number): void {
    this.timeScale = scale;
  }

  /**
   * Get the current time scale.
   */
  getTimeScale(): number {
    return this.timeScale;
  }

  /**
   * Jump to a specific hour (0-24).
   */
  setHour(hour: number): void {
    this.timeInSeconds = hour * SECONDS_PER_HOUR;

    // Normalize to valid range
    while (this.timeInSeconds >= SECONDS_PER_DAY) {
      this.timeInSeconds -= SECONDS_PER_DAY;
    }
    while (this.timeInSeconds < 0) {
      this.timeInSeconds += SECONDS_PER_DAY;
    }
  }
}
