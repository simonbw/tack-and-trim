import { BaseEntity } from "../../../core/entity/BaseEntity";
import type { Sail } from "./Sail";

/**
 * Stub for sail sound generation.
 * TODO: Implement with real cloth samples. Key signals available:
 * - Constraint tension via sail.constraints[i].equations[0].multiplier
 * - Particle direction reversals for luffing detection
 * - Rate of tension change for fill/loading events
 */
export class SailSoundGenerator extends BaseEntity {
  tickLayer = "effects" as const;

  constructor(private sail: Sail) {
    super();
  }
}
