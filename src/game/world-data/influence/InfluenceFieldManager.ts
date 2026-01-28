/**
 * Influence field manager (stub for editor compatibility).
 * This system computes terrain influence on waves for visual effects.
 * This is a temporary stub while the new world system is being implemented.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";

/**
 * Progress tracking for influence field computation tasks.
 */
export interface TaskProgress {
  wind: number;
}

/**
 * Manages computation of terrain influence fields for wave rendering.
 * Stub implementation that does nothing but satisfies the editor's needs.
 */
export class InfluenceFieldManager extends BaseEntity {
  constructor() {
    super();
    this.id = "influenceFieldManager";
  }

  @on("afterAdded")
  async onAfterAdded(): Promise<void> {
    // Stub: immediately mark as complete
    setTimeout(() => {
      this.game.dispatch("influenceFieldsReady", {});
    }, 100);
  }

  /**
   * Recompute influence fields (stub).
   */
  async recompute(): Promise<void> {
    // Stub: immediately mark as complete
    setTimeout(() => {
      this.game.dispatch("influenceFieldsReady", {});
    }, 100);
  }

  /**
   * Get computation progress (stub).
   * TODO (Phase 2+): Track actual progress during field computation.
   */
  getProgress(): TaskProgress {
    return { wind: 1.0 }; // Report as complete
  }
}
