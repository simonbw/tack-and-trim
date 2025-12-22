import { Graphics } from "pixi.js";
import BaseEntity from "../../core/entity/BaseEntity";
import { createGraphics, GameSprite } from "../../core/entity/GameSprite";
import { lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Wind } from "../Wind";
import { Hull } from "./Hull";
import { Rig } from "./Rig";

const FLAG_LENGTH = 12;
const FLAG_WIDTH_START = 1.5;
const FLAG_WIDTH_END = 0.8;
const FLAG_SEGMENTS = 6;
const FLAG_WAVE_SPEED = 10;
const FLAG_WAVE_AMPLITUDE = 1;

export class WindIndicator extends BaseEntity {
  private flagSprite: GameSprite & Graphics;
  private flagTime: number = 0;

  constructor(
    private hull: Hull,
    private rig: Rig
  ) {
    super();

    this.flagSprite = createGraphics("sails");
    this.sprite = this.flagSprite;
  }

  onTick(dt: number) {
    this.flagTime += dt;
  }

  onRender() {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    if (!wind) return;

    const [mx, my] = this.rig.getMastWorldPosition();

    // Calculate apparent wind (wind relative to boat motion)
    const boatVel = V(this.hull.body.velocity);
    const apparentWind = wind.getVelocity().sub(boatVel);
    const apparentWindAngle = Math.atan2(apparentWind.y, apparentWind.x);

    this.flagSprite.clear();
    this.flagSprite.position.set(mx, my);
    this.flagSprite.rotation = apparentWindAngle;

    // Build wavy flag polygon
    const flagPoints: V2d[] = [];
    for (let i = 0; i <= FLAG_SEGMENTS; i++) {
      const t = i / FLAG_SEGMENTS;
      const x = t * FLAG_LENGTH;
      const wave =
        Math.sin(this.flagTime * FLAG_WAVE_SPEED + t * Math.PI * 2) *
        FLAG_WAVE_AMPLITUDE *
        t;
      const w = lerp(FLAG_WIDTH_START, FLAG_WIDTH_END, t);
      flagPoints.push(V(x, wave - w));
    }
    for (let i = FLAG_SEGMENTS; i >= 0; i--) {
      const t = i / FLAG_SEGMENTS;
      const x = t * FLAG_LENGTH;
      const wave =
        Math.sin(this.flagTime * FLAG_WAVE_SPEED + t * Math.PI * 2) *
        FLAG_WAVE_AMPLITUDE *
        t;
      const w = lerp(FLAG_WIDTH_START, FLAG_WIDTH_END, t);
      flagPoints.push(V(x, wave + w));
    }
    this.flagSprite.poly(flagPoints).fill({ color: 0xff3333 });
  }
}
