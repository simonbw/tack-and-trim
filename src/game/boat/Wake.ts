import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { GameEventMap } from "../../core/entity/Entity";
import { V2d } from "../../core/Vector";
import { Boat } from "./Boat";
import { WakeParticle } from "./WakeParticle";

const MIN_SPEED = 1; // ft/s — below this, no wake

export class Wake extends BaseEntity {
  layer = "wake" as const;
  tickLayer = "effects" as const;

  private lastPos: V2d | null = null;

  boat: Boat;
  private spawnLocal: V2d;
  private amplitudeScale: number;
  private waterlineLength: number;
  private beam: number;

  constructor(boat: Boat, spawnLocal: V2d, amplitudeScale: number = 1) {
    super();
    this.boat = boat;
    this.spawnLocal = spawnLocal;
    this.amplitudeScale = amplitudeScale;

    // Derive hull dimensions from waterline vertices (where hull meets water)
    const verts =
      boat.config.hull.waterlineVertices ?? boat.config.hull.vertices;
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const v of verts) {
      if (v.x < minX) minX = v.x;
      if (v.x > maxX) maxX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.y > maxY) maxY = v.y;
    }
    this.waterlineLength = maxX - minX;
    this.beam = maxY - minY;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const speed = this.boat.getVelocity().magnitude;
    if (speed < MIN_SPEED) return;

    const body = this.boat.hull.body;
    const pos = body.toWorldFrame(this.spawnLocal);

    // Shift wake spawn position based on heel — heeled boat digs leeward edge in
    const roll = this.boat.roll;
    if (Math.abs(roll) > 0.01) {
      const leewardShift = Math.sin(roll) * this.beam * 0.3;
      const angle = body.angle;
      pos[0] -= leewardShift * Math.sin(angle);
      pos[1] += leewardShift * Math.cos(angle);
    }

    // Actual distance moved since last spawn
    const spacing = this.lastPos ? this.lastPos.distanceTo(pos) : speed * dt;

    this.lastPos = pos;

    // Increase wake amplitude when heeled (leeward edge digs in more)
    const heelAmplitudeBoost = 1 + Math.abs(roll) * 0.5;

    const particle = new WakeParticle(
      pos,
      speed,
      this.waterlineLength,
      this.beam,
      spacing,
      this.amplitudeScale * heelAmplitudeBoost,
    );
    this.game.addEntity(particle);
  }
}
