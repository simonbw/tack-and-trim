import BaseEntity from "../core/entity/BaseEntity";
import Entity from "../core/entity/Entity";
import type Body from "../core/physics/body/Body";
import StaticBody from "../core/physics/body/StaticBody";

const MAX_POSITION = 10000;
const MAX_VELOCITY = 1000;

/**
 * Validates physics state after each physics step and resets any bodies
 * that have gone unstable (NaN/Infinity values or extreme positions/velocities).
 *
 * This is a safety net for debugging unstable physics - it shouldn't be needed
 * in a stable simulation but prevents bodies from flying off to infinity.
 */
export class PhysicsValidator extends BaseEntity {
  onAfterPhysicsStep() {
    for (const body of this.game!.world.bodies) {
      if (body instanceof StaticBody) continue;

      const [x, y] = body.position;
      const [vx, vy] = body.velocity;

      // Check for NaN/Infinity or extreme positions
      const positionBad =
        !isFinite(x) ||
        !isFinite(y) ||
        Math.abs(x) > MAX_POSITION ||
        Math.abs(y) > MAX_POSITION;
      const velocityBad = !isFinite(vx) || !isFinite(vy);

      if (positionBad || velocityBad) {
        const owner = (body as Body & { owner?: Entity }).owner;
        console.warn(
          "Physics instability detected, resetting body:",
          owner?.constructor?.name ?? "unknown",
          {
            position: [x, y],
            velocity: [vx, vy],
            angularVelocity: body.angularVelocity,
          },
        );
        body.position.set(0, 0);
        body.velocity.set(0, 0);
        body.angularVelocity = 0;
        continue;
      }

      // Clamp extreme velocities
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > MAX_VELOCITY) {
        const owner = (body as Body & { owner?: Entity }).owner;
        console.warn(
          "Physics velocity clamped:",
          owner?.constructor?.name ?? "unknown",
          { speed, maxVelocity: MAX_VELOCITY },
        );
        const scale = MAX_VELOCITY / speed;
        body.velocity[0] *= scale;
        body.velocity[1] *= scale;
      }
    }
  }
}
