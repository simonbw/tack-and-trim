import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { V } from "../../core/Vector";
import { Boat } from "./Boat";
import { LifelinesConfig } from "./BoatConfig";

/** Lifelines, stanchions, bow pulpit, and stern pulpit rendered on the hull deck. */
export class Lifelines extends BaseEntity {
  layer = "hull" as const;

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
    const t = this.boat.hull.tiltTransform;
    const cr = t.cosRoll;
    const sr = t.sinRoll;
    const sp = t.sinPitch;
    const deckZ = this.boat.config.tilt.zHeights.deck;
    const topZ = deckZ + this.config.stanchionHeight;

    const { color, tubeWidth, wireWidth } = this.config;

    // Project a hull-local (x, y) point at a given z-height to hull-local 2D,
    // matching the projection used by Hull and Rig:
    //   projX = x + z * sinPitch
    //   projY = y * cosRoll + z * sinRoll
    const projX = (x: number, z: number) => x + z * sp;
    const projY = (y: number, z: number) => y * cr + z * sr;

    draw.at({ pos: V(hx, hy), angle: hullAngle }, () => {
      // --- Stanchions (short posts from deck to rail height) ---
      for (const [sx, sy] of this.config.portStanchions) {
        draw.line(
          projX(sx, deckZ),
          projY(sy, deckZ),
          projX(sx, topZ),
          projY(sy, topZ),
          { color, width: tubeWidth },
        );
      }
      for (const [sx, sy] of this.config.starboardStanchions) {
        draw.line(
          projX(sx, deckZ),
          projY(sy, deckZ),
          projX(sx, topZ),
          projY(sy, topZ),
          { color, width: tubeWidth },
        );
      }

      // --- Bow pulpit (U-shaped rail at bow) ---
      this.drawStrokedPath(
        draw,
        this.config.bowPulpit,
        topZ,
        projX,
        projY,
        color,
        tubeWidth,
      );

      // --- Stern pulpit (rail at stern) ---
      this.drawStrokedPath(
        draw,
        this.config.sternPulpit,
        topZ,
        projX,
        projY,
        color,
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
        projX,
        projY,
        color,
        wireWidth,
      );
      this.drawLifeline(
        draw,
        this.config.bowPulpit,
        this.config.starboardStanchions,
        this.config.sternPulpit,
        false,
        topZ,
        projX,
        projY,
        color,
        wireWidth,
      );
    });
  }

  /** Draw a stroked open path at a given z-height with proper tilt projection. */
  private drawStrokedPath(
    draw: Draw,
    points: ReadonlyArray<readonly [number, number]>,
    z: number,
    projX: (x: number, z: number) => number,
    projY: (y: number, z: number) => number,
    color: number,
    width: number,
  ): void {
    if (points.length < 2) return;
    const path = draw.path();
    path.moveTo(projX(points[0][0], z), projY(points[0][1], z));
    for (let i = 1; i < points.length; i++) {
      path.lineTo(projX(points[i][0], z), projY(points[i][1], z));
    }
    path.stroke(color, width);
  }

  /** Draw a lifeline wire connecting pulpit ends through stanchion tops. */
  private drawLifeline(
    draw: Draw,
    bowPulpit: ReadonlyArray<readonly [number, number]>,
    stanchions: ReadonlyArray<readonly [number, number]>,
    sternPulpit: ReadonlyArray<readonly [number, number]>,
    isPort: boolean,
    z: number,
    projX: (x: number, z: number) => number,
    projY: (y: number, z: number) => number,
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
      const path = draw.path();
      path.moveTo(projX(points[0][0], z), projY(points[0][1], z));
      for (let i = 1; i < points.length; i++) {
        path.lineTo(projX(points[i][0], z), projY(points[i][1], z));
      }
      path.stroke(color, width);
    }
  }
}
