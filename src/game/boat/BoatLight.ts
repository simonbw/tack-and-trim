import { on } from "../../core/entity/handler";
import { V } from "../../core/Vector";
import { V3d } from "../../core/Vector3";
import { Light } from "../lighting/Light";
import { TimeOfDay } from "../time/TimeOfDay";
import type { Boat } from "./Boat";

/**
 * Warm masthead-style light that follows the boat.
 *
 * Mounted at the mast position partway up the spar (a "spreader light"
 * height — half the masthead z). The light's world (x, y) is computed each
 * tick via the hull body's full 3D orientation, so when the boat heels the
 * light visibly swings out to leeward, the way a real masthead light does.
 *
 * Only on at night: ramps up between 6pm and 7pm and back down between 5am
 * and 6am. The fade window keeps the transition from being a jarring on/off
 * pop while still honouring the "on at 7pm, off at 6am" intent.
 *
 * PEAK_INTENSITY is the contribution at r = 0 — the rasterizer's
 * 1/(1 + (d/halfDistance)^2) attenuation falls off fast, so this is what a
 * deck tile right under the mast sees, not what's spread over the radius.
 * Combined with the screen-blend in the lighting shaders it caps at 1.0.
 *
 * HALF_DISTANCE is the world-space distance at which brightness drops to
 * 1/2 of peak — pick this for the "size" of the bright core.
 */
const PEAK_INTENSITY = 0.18;
const HALF_DISTANCE = 4;
/** Fraction of the masthead z to mount the light at. 0.5 ≈ spreader-light height. */
const MAST_FRACTION = 0.5;

export class BoatLight extends Light {
  // Boat-local mount point on the mast; constant across ticks.
  private readonly localX: number;
  private readonly localY: number;
  private readonly localZ: number;
  // Reused output to keep the per-tick projection allocation-free.
  private readonly worldOut = new V3d(0, 0, 0);

  constructor(private boat: Boat) {
    const mastPos = boat.config.rig.mastPosition;
    const lightZ = boat.rig.getMastTopZ() * MAST_FRACTION;

    super({
      position: V(0, 0),
      color: [1.0, 0.85, 0.6],
      radius: 30,
      halfDistance: HALF_DISTANCE,
      intensity: 0,
    });

    this.localX = mastPos.x;
    this.localY = mastPos.y;
    this.localZ = lightZ;
    this.updatePosition();
  }

  private updatePosition() {
    const w = this.boat.hull.body.toWorldFrame3D(
      this.localX,
      this.localY,
      this.localZ,
      this.worldOut,
    );
    this.position[0] = w[0];
    this.position[1] = w[1];
  }

  @on("tick")
  onTick() {
    this.updatePosition();

    const tod = this.game.entities.tryGetSingleton(TimeOfDay);
    const night = tod ? nightFactor(tod.getTimeInSeconds()) : 1;
    this.intensity =
      PEAK_INTENSITY * night * flicker(this.game.elapsedUnpausedTime);
  }
}

/**
 * Subtle lantern-style flicker: sum of three sines at incommensurate
 * frequencies so it never perfectly repeats. Total swing ~+/-7% — visible
 * if you stop and watch, easy to ignore otherwise.
 */
function flicker(t: number): number {
  return (
    1 +
    0.04 * Math.sin(t * 2.1) +
    0.02 * Math.sin(t * 5.7 + 1.3) +
    0.01 * Math.sin(t * 11.3 + 2.7)
  );
}

/**
 * Smooth on/off curve over the 24-hour clock. Reaches 1 by 7pm, holds
 * through midnight, drops back to 0 by 6am. Hour-wide ramps on each side.
 */
function nightFactor(timeInSeconds: number): number {
  const hours = timeInSeconds / 3600;
  // Hours from midnight, wrapped: 0 at midnight, 12 at noon.
  const distFromMidnight = Math.min(hours, 24 - hours);
  // 1 when distFromMidnight ≤ 5 (between 7pm and 5am), 0 when ≥ 6, smooth
  // between (1-hour fade centered on 6:30pm and 5:30am).
  return smoothstep(6, 5, distFromMidnight);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
