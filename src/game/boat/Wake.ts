import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { Boat } from "./Boat";
import { FoamParticle } from "./FoamParticle";
import { WakeParticle } from "./WakeParticle";

// Below this, a source is too weak to bother spawning a particle for.
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

    // Coherent ring waves — emitted every tick from waterline sources.
    const waveCount = hull.waveSourceCount;
    for (let i = 0; i < waveCount; i++) {
      const src = hull.getWaveSource(i);
      if (src.pushFlux <= MIN_SOURCE_FLUX) continue;
      this.game.addEntity(
        new WakeParticle({
          worldX: src.worldX,
          worldY: src.worldY,
          pushFlux: src.pushFlux,
          halfWidth: src.halfWidth,
          groupSpeed: src.groupSpeed,
          dt,
        }),
      );
    }

    // Foam blobs — round-robin throttled, bounded particles/tick.
    const foamCount = hull.foamSourceCount;
    for (let i = 0; i < foamCount; i++) {
      const src = hull.getFoamSource(i);
      if (src.avgFlux <= MIN_SOURCE_FLUX) continue;
      this.game.addEntity(
        new FoamParticle({
          worldX: src.worldX,
          worldY: src.worldY,
          avgFlux: src.avgFlux,
          halfWidth: src.halfWidth,
          groupSpeed: src.groupSpeed,
        }),
      );
    }
  }
}
