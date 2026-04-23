import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { Boat } from "./Boat";
import { WakeParticle } from "./WakeParticle";

// Below this much flux, a source is too weak to be worth spawning a particle.
const MIN_SOURCE_FLUX = 0.01; // ft³/s

export class Wake extends BaseEntity {
  layer = "wake" as const;
  tickLayer = "effects" as const;

  boat: Boat;

  constructor(boat: Boat) {
    super();
    this.boat = boat;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const hull = this.boat.hull;
    const count = hull.waveSourceCount;
    for (let i = 0; i < count; i++) {
      const src = hull.getWaveSource(i);
      const totalFlux = src.pushFlux + src.suckFlux;
      if (totalFlux < MIN_SOURCE_FLUX) continue;
      this.game.addEntity(
        new WakeParticle({
          worldX: src.worldX,
          worldY: src.worldY,
          pushFlux: src.pushFlux,
          suckFlux: src.suckFlux,
          halfWidth: src.halfWidth,
          groupSpeed: src.groupSpeed,
          dt,
        }),
      );
    }
  }
}
