import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { clamp, lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Wind } from "../Wind";
import { Hull } from "./Hull";

// Wind sock dimensions
const SOCK_BASE_LENGTH = 10;
const SOCK_MAX_LENGTH = 16;
const SOCK_WIDTH_START = 2;
const SOCK_WIDTH_END = 0.6;
const SOCK_SEGMENTS = 8;

// Animation parameters
const SOCK_WAVE_SPEED = 12;
const SOCK_MIN_WAVE_AMPLITUDE = 0.2; // At high wind
const SOCK_MAX_WAVE_AMPLITUDE = 1.5; // At low wind

// Wind speed reference (for scaling sock extension)
const WIND_SPEED_MIN = 20; // Below this, sock is limp
const WIND_SPEED_MAX = 150; // At this speed, sock is fully extended

export class WindSock extends BaseEntity {
  private sockSprite: GameSprite & Graphics;
  private sockTime: number = 0;

  constructor(
    private hull: Hull,
    private localPosition: V2d
  ) {
    super();

    this.sockSprite = createGraphics("sails");
    this.sprite = this.sockSprite;
  }

  onTick(dt: number) {
    this.sockTime += dt;
  }

  /**
   * Calculate the velocity of a point on the hull, accounting for rotation.
   * v_point = v_hull + omega x r
   * In 2D: v_tangential = [-omega * r.y, omega * r.x]
   */
  private getPointVelocity(worldOffset: V2d): V2d {
    const hullVel = V(this.hull.body.velocity);
    const omega = this.hull.body.angularVelocity;

    // Tangential velocity due to rotation
    const tangentialVel = V(-omega * worldOffset.y, omega * worldOffset.x);

    return hullVel.add(tangentialVel);
  }

  onRender() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const [hx, hy] = this.hull.body.position;
    const hullAngle = this.hull.body.angle;

    // Calculate world position of the sock attachment point
    const worldOffset = this.localPosition.rotate(hullAngle);
    const worldPos = worldOffset.add(V(hx, hy));

    // Calculate apparent wind at this point (accounting for rotation)
    const pointVelocity = this.getPointVelocity(worldOffset);
    const apparentWind = wind.getVelocityAtPoint(worldPos).sub(pointVelocity);
    const apparentWindSpeed = apparentWind.magnitude;
    const apparentWindAngle = Math.atan2(apparentWind.y, apparentWind.x);

    // Calculate sock extension and stiffness based on wind speed
    const windFactor = clamp(
      (apparentWindSpeed - WIND_SPEED_MIN) / (WIND_SPEED_MAX - WIND_SPEED_MIN),
      0,
      1
    );

    // Sock extends more with stronger wind
    const sockLength = lerp(SOCK_BASE_LENGTH, SOCK_MAX_LENGTH, windFactor);

    // Sock waves less (gets taut) with stronger wind
    const waveAmplitude = lerp(
      SOCK_MAX_WAVE_AMPLITUDE,
      SOCK_MIN_WAVE_AMPLITUDE,
      windFactor
    );

    this.sockSprite.clear();
    this.sockSprite.position.set(worldPos.x, worldPos.y);
    this.sockSprite.rotation = apparentWindAngle;

    // Build wavy sock polygon
    const sockPoints: V2d[] = [];

    // Top edge (going outward)
    for (let i = 0; i <= SOCK_SEGMENTS; i++) {
      const t = i / SOCK_SEGMENTS;
      const x = t * sockLength;
      const wave =
        Math.sin(this.sockTime * SOCK_WAVE_SPEED + t * Math.PI * 3) *
        waveAmplitude *
        t; // Wave increases toward tip
      const w = lerp(SOCK_WIDTH_START, SOCK_WIDTH_END, t);
      sockPoints.push(V(x, wave - w));
    }

    // Bottom edge (coming back)
    for (let i = SOCK_SEGMENTS; i >= 0; i--) {
      const t = i / SOCK_SEGMENTS;
      const x = t * sockLength;
      const wave =
        Math.sin(this.sockTime * SOCK_WAVE_SPEED + t * Math.PI * 3) *
        waveAmplitude *
        t;
      const w = lerp(SOCK_WIDTH_START, SOCK_WIDTH_END, t);
      sockPoints.push(V(x, wave + w));
    }

    this.sockSprite.poly(sockPoints).fill({ color: 0xff3333 });
  }
}
