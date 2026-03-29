import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { V } from "../../core/Vector";
import { Boat } from "./Boat";
import { LifelinesConfig } from "./BoatConfig";

/** Lifelines, stanchions, bow pulpit, and stern pulpit rendered on the hull deck. */
export class Lifelines extends BaseEntity {
  layer = "boat" as const;

  private boat: Boat;
  private config: LifelinesConfig;

  constructor(boat: Boat, config: LifelinesConfig) {
    super();
    this.boat = boat;
    this.config = config;
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const hullBody = this.boat.hull.body;
    const [hx, hy] = hullBody.position;
    const hullAngle = hullBody.angle;
    const roll = this.boat.hull.body.roll;
    const pitch = this.boat.hull.body.pitch;
    const zOffset = this.boat.hull.body.z;
    const deckZ = this.boat.config.hull.deckHeight;
    const topZ = deckZ + this.config.stanchionHeight;

    const { tubeColor, wireColor, tubeWidth, wireWidth } = this.config;

    draw.at(
      { pos: V(hx, hy), angle: hullAngle, tilt: { roll, pitch, zOffset } },
      () => {
        // --- Stanchions (short posts from deck to rail height) ---
        for (const [sx, sy] of this.config.portStanchions) {
          draw.line(sx, sy, sx, sy, {
            color: tubeColor,
            width: tubeWidth,
            z: topZ,
          });
        }
        for (const [sx, sy] of this.config.starboardStanchions) {
          draw.line(sx, sy, sx, sy, {
            color: tubeColor,
            width: tubeWidth,
            z: topZ,
          });
        }

        // --- Bow pulpit (U-shaped rail at bow) ---
        this.drawStrokedPath(
          draw,
          this.config.bowPulpit,
          topZ,
          tubeColor,
          tubeWidth,
        );

        // --- Stern pulpit (rail at stern) ---
        this.drawStrokedPath(
          draw,
          this.config.sternPulpit,
          topZ,
          tubeColor,
          tubeWidth,
        );

        // --- Lifeline wires (connect stanchion tops, bow to stern per side) ---
        this.drawLifeline(
          draw,
          this.config.bowPulpit,
          this.config.portStanchions,
          this.config.sternPulpit,
          true,
          topZ,
          wireColor,
          wireWidth,
        );
        this.drawLifeline(
          draw,
          this.config.bowPulpit,
          this.config.starboardStanchions,
          this.config.sternPulpit,
          false,
          topZ,
          wireColor,
          wireWidth,
        );
      },
    );
  }

  /** Draw a stroked open path at a given z-height. Coordinates are body-local. */
  private drawStrokedPath(
    draw: Draw,
    points: ReadonlyArray<readonly [number, number]>,
    z: number,
    color: number,
    width: number,
  ): void {
    if (points.length < 2) return;
    draw.renderer.setZ(z);
    const path = draw.path();
    path.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
      path.lineTo(points[i][0], points[i][1]);
    }
    path.stroke(color, width);
    draw.renderer.setZ(0);
  }

  /** Draw a lifeline wire connecting pulpit ends through stanchion tops. */
  private drawLifeline(
    draw: Draw,
    bowPulpit: ReadonlyArray<readonly [number, number]>,
    stanchions: ReadonlyArray<readonly [number, number]>,
    sternPulpit: ReadonlyArray<readonly [number, number]>,
    isPort: boolean,
    z: number,
    color: number,
    width: number,
  ): void {
    if (stanchions.length === 0) return;

    const points: [number, number][] = [];

    // Start from the appropriate end of the bow pulpit
    if (bowPulpit.length > 0) {
      const bp = isPort ? bowPulpit[bowPulpit.length - 1] : bowPulpit[0];
      points.push([bp[0], bp[1]]);
    }

    // Through stanchion tops
    for (const s of stanchions) {
      points.push([s[0], s[1]]);
    }

    // End at the appropriate end of the stern pulpit
    if (sternPulpit.length > 0) {
      const sp = isPort ? sternPulpit[sternPulpit.length - 1] : sternPulpit[0];
      points.push([sp[0], sp[1]]);
    }

    if (points.length >= 2) {
      draw.renderer.setZ(z);
      const path = draw.path();
      path.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        path.lineTo(points[i][0], points[i][1]);
      }
      path.stroke(color, width);
      draw.renderer.setZ(0);
    }
  }
}
