import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { V, V2d } from "../core/Vector";
import { WindQuery } from "./world/wind/WindQuery";

// Tree dimensions (world units = feet)
const BRANCH_COUNT = 12; // Total control points in canopy polygon (must be even)
const OUTER_RADIUS = 12; // Branch tip radius
const INNER_RADIUS = 8; // Valley radius between branch tips
const TRUNK_RADIUS = 1.5;

// Wind sway
const SWAY_SCALE = 0.15; // Tip displacement per ft/s of wind speed
const SWAY_FREQ = 1.8; // Oscillation frequency (rad/s)

const CANOPY_COLOR = 0x1a4010;
const TRUNK_COLOR = 0x3d2008;

export class Tree extends BaseEntity {
  layer = "main" as const;
  private readonly position: V2d;
  private readonly phaseOffset: number;
  private time = 0;
  private readonly windQuery: WindQuery;

  constructor(x: number, y: number) {
    super();
    this.position = V(x, y);
    this.phaseOffset = Math.random() * Math.PI * 2;
    this.windQuery = this.addChild(new WindQuery(() => [this.position]));
  }

  @on("render")
  onRender({ dt, draw }: { dt: number; draw: Draw }) {
    this.time += dt;

    let windVelX = 0;
    let windVelY = 0;
    let windSpeed = 0;
    if (this.windQuery.length > 0) {
      const result = this.windQuery.get(0);
      windSpeed = result.speed;
      const vel = result.velocity; // cached V2d — read immediately
      windVelX = vel.x;
      windVelY = vel.y;
    }

    // Oscillation for liveliness (two components for figure-8-ish motion)
    const oscillation = Math.sin(this.time * SWAY_FREQ + this.phaseOffset);
    const oscillationPerp =
      Math.cos(this.time * SWAY_FREQ + this.phaseOffset) * 0.3;

    // Wind direction unit vector and perpendicular
    const invSpeed = windSpeed > 0.01 ? 1 / windSpeed : 0;
    const windDirX = windVelX * invSpeed;
    const windDirY = windVelY * invSpeed;
    const perpX = -windDirY;
    const perpY = windDirX;

    // Tip displacement: steady downwind lean + oscillation
    const swayAmount = windSpeed * SWAY_SCALE;
    const tipDx =
      windDirX * swayAmount * (1 + oscillation * 0.3) +
      perpX * swayAmount * oscillationPerp;
    const tipDy =
      windDirY * swayAmount * (1 + oscillation * 0.3) +
      perpY * swayAmount * oscillationPerp;

    draw.at({ pos: this.position }, () => {
      // Canopy: star polygon with alternating tip/valley radii, tips displaced by wind
      const points: V2d[] = [];
      for (let i = 0; i < BRANCH_COUNT; i++) {
        const angle = (i / BRANCH_COUNT) * Math.PI * 2;
        const isTip = i % 2 === 0;
        const r = isTip ? OUTER_RADIUS : INNER_RADIUS;
        const swayScale = isTip ? 1.0 : 0.25;
        points.push(
          V(
            r * Math.cos(angle) + tipDx * swayScale,
            r * Math.sin(angle) + tipDy * swayScale,
          ),
        );
      }
      draw.fillSmoothPolygon(points, { color: CANOPY_COLOR, tension: 0.4 });

      // Trunk visible at center
      draw.fillCircle(0, 0, TRUNK_RADIUS, { color: TRUNK_COLOR });
    });
  }
}
