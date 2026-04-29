import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { rUniform } from "../../core/util/Random";
import { V, V2d } from "../../core/Vector";
import { WeatherState } from "./WeatherState";
import { WindQuery } from "../world/wind/WindQuery";

/** Particles per unit of `rainIntensity` at full intensity = 1. */
const BASE_COUNT = 800;
/** Spawn / despawn rate cap, particles per second. */
const SPAWN_RATE = 1200;
/** World units per second the particles fall. */
const TERMINAL_VELOCITY = 30;
/** How wide the streak is on screen. */
const STREAK_PIXEL_WIDTH = 1.0;
/** Streak length in seconds of motion (length = velocity * this). */
const STREAK_DURATION = 0.06;
/** Translucency. */
const STREAK_ALPHA = 0.45;
/** Streak color. Slightly cool white. */
const STREAK_COLOR = 0xcfdfff;
/** How far above the viewport rain spawns (avoids pop-in for fast wind). */
const SPAWN_MARGIN_ABOVE = 4;
/** Horizontal spawn margin to either side, scaled by viewport width. */
const SPAWN_MARGIN_HORIZONTAL = 0.25;

class RainDrop {
  pos: V2d = V(0, 0);
  vel: V2d = V(0, TERMINAL_VELOCITY);
}

export class RainParticles extends BaseEntity {
  layer = "windParticles" as const;
  tickLayer = "environment" as const;

  private particles: RainDrop[] = [];
  private windQuery: WindQuery;

  constructor() {
    super();
    this.windQuery = this.addChild(
      new WindQuery(() => this.particles.map((p) => p.pos.clone())),
    );
  }

  @on("render")
  onRender({ dt, draw }: { dt: number; draw: Draw }) {
    if (!this.game) return;
    const weather = this.game.entities.tryGetSingleton(WeatherState);
    const intensity = weather?.rainIntensity ?? 0;
    const target = Math.round(intensity * BASE_COUNT);

    const viewport = this.game.camera.getWorldViewport();

    const diff = target - this.particles.length;
    const maxChange = Math.ceil(SPAWN_RATE * dt);
    const change = Math.min(Math.abs(diff), maxChange) * Math.sign(diff);
    if (change > 0) {
      for (let i = 0; i < change; i++) {
        this.particles.push(this.spawnDrop(viewport, weather));
      }
    } else if (change < 0) {
      this.particles.length = Math.max(0, this.particles.length + change);
    }

    const windResults = this.windQuery.results;

    const cullTop = viewport.top - SPAWN_MARGIN_ABOVE * 4;
    const cullBottom = viewport.bottom + 4;
    const cullLeft =
      viewport.left - viewport.width * SPAWN_MARGIN_HORIZONTAL - 4;
    const cullRight =
      viewport.right + viewport.width * SPAWN_MARGIN_HORIZONTAL + 4;

    const widthWorld = STREAK_PIXEL_WIDTH / this.game.camera.z;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const wind = i < windResults.length ? windResults[i].velocity : null;
      const vx = wind ? wind.x : 0;
      const vy = (wind ? wind.y : 0) + TERMINAL_VELOCITY;
      p.vel.set(vx, vy);
      p.pos.x += vx * dt;
      p.pos.y += vy * dt;

      if (
        p.pos.y > cullBottom ||
        p.pos.y < cullTop ||
        p.pos.x < cullLeft ||
        p.pos.x > cullRight
      ) {
        const respawn = this.spawnDrop(viewport, weather);
        p.pos.set(respawn.pos);
        p.vel.set(respawn.vel);
        continue;
      }

      const tailX = p.pos.x - vx * STREAK_DURATION;
      const tailY = p.pos.y - vy * STREAK_DURATION;
      draw.line(p.pos.x, p.pos.y, tailX, tailY, {
        color: STREAK_COLOR,
        alpha: STREAK_ALPHA,
        width: widthWorld,
      });
    }
  }

  private spawnDrop(
    viewport: { left: number; right: number; top: number; width: number },
    weather: WeatherState | null | undefined,
  ): RainDrop {
    const drop = new RainDrop();
    // Bias the spawn band against the wind so streaks blow into the viewport.
    const wind = weather?.getEffectiveWindBase();
    const windX = wind ? wind.x : 0;
    const windBias = -Math.sign(windX) * viewport.width * 0.25;
    const margin = viewport.width * SPAWN_MARGIN_HORIZONTAL;
    const x = rUniform(
      viewport.left - margin + windBias,
      viewport.right + margin + windBias,
    );
    const y = viewport.top - rUniform(0, SPAWN_MARGIN_ABOVE);
    drop.pos.set(x, y);
    drop.vel.set(windX, TERMINAL_VELOCITY);
    return drop;
  }
}
