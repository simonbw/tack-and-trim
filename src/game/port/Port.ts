import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import type { Body } from "../../core/physics/body/Body";
import { createRigid2D } from "../../core/physics/body/bodyFactories";
import { Box } from "../../core/physics/shapes/Box";
import { V, V2d } from "../../core/Vector";
import type { PortData } from "../../editor/io/LevelFileFormat";
import { computeTiltProjection } from "../boat/tessellation";
import { TiltDraw } from "../boat/TiltDraw";

// Dock dimensions in feet
const DOCK_LENGTH = 50; // ft — long enough for the largest boats
const DOCK_WIDTH = 5; // ft

// Bounding radius for view-frustum culling: half the deck's diagonal.
const CULL_RADIUS = Math.hypot(DOCK_LENGTH, DOCK_WIDTH) / 2;

// Cleat positions along dock length from shore end (0 = shore, 1 = tip)
// Placed mid-gap between pilings (pilings sit at ratios 0.0, 0.2, 0.4, ...)
const BOW_CLEAT_RATIO = 0.7; // near the tip, centered between pilings
const STERN_CLEAT_RATIO = 0.3; // near shore, centered between pilings

// Piling / stringer / cleat dimensions
const PILING_RADIUS = 0.6; // ft
const PILING_SPACING = 10; // ft along the length
const PILING_OUTBOARD = 0.5; // ft outside the deck edge
const STRINGER_INSET = 0.4; // ft inboard from the deck edge
const STRINGER_WIDTH = 0.6; // ft
const DECK_BOARD_WIDTH = 0.75; // ft along length
const DECK_BOARD_GAP = 0.15; // ft gap between planks
const CLEAT_EDGE_INSET = 0.7; // ft from dock edge
const CLEAT_HORN_HALF = 0.45; // half-length of the horizontal horn
const CLEAT_POST_WIDTH = 0.25;
const CLEAT_HORN_WIDTH = 0.3;

// Z heights (waterline = 0)
const DECK_HEIGHT = 2.5;
const STRINGER_Z = DECK_HEIGHT - 0.5;
const PILING_Z = DECK_HEIGHT + 2;
const CLEAT_BASE_Z = DECK_HEIGHT + 0.05;
const CLEAT_HORN_Z = DECK_HEIGHT + 0.5;

// Colors
const DECK_BOARD_COLOR = 0x9a7420;
const PILING_COLOR = 0x4a3014; // darker wood than the deck
const CLEAT_COLOR = 0x2b2b2b;

export class Port extends BaseEntity {
  tags = ["port"];
  layer = "boat" as const;
  body: Body;

  private portData: PortData;

  // Local-space cleat positions (relative to dock center, before rotation)
  private bowCleatLocal: V2d;
  private sternCleatLocal: V2d;

  constructor(data: PortData) {
    super();

    this.portData = data;

    // Compute local cleat positions along the dock's length axis
    // The dock extends in the local +x direction from shore
    // Center of dock is at DOCK_LENGTH/2 along x
    const halfLength = DOCK_LENGTH / 2;
    const cleatY = DOCK_WIDTH / 2 - CLEAT_EDGE_INSET;
    this.bowCleatLocal = V(-halfLength + DOCK_LENGTH * BOW_CLEAT_RATIO, cleatY);
    this.sternCleatLocal = V(
      -halfLength + DOCK_LENGTH * STERN_CLEAT_RATIO,
      cleatY,
    );

    // Create static body for collision
    this.body = createRigid2D({
      motion: "static",
      position: [data.position.x, data.position.y],
      angle: data.angle,
    });
    this.body.addShape(new Box({ width: DOCK_LENGTH, height: DOCK_WIDTH }));
  }

  getId(): string {
    return this.portData.id;
  }

  getName(): string {
    return this.portData.name;
  }

  getPosition(): V2d {
    return V(this.body.position);
  }

  getAngle(): number {
    return this.body.angle;
  }

  /** Get bow cleat position in world space */
  getBowCleatWorld(): V2d {
    return this.body.toWorldFrame(this.bowCleatLocal);
  }

  /** Get stern cleat position in world space */
  getSternCleatWorld(): V2d {
    return this.body.toWorldFrame(this.sternCleatLocal);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const [x, y] = this.body.position;
    if (!draw.camera.isVisible(x, y, CULL_RADIUS)) return;
    const angle = this.body.angle;
    const halfW = DOCK_WIDTH / 2;
    const halfL = DOCK_LENGTH / 2;

    const tilt = computeTiltProjection(angle, 0, 0);

    draw.at({ pos: V(x, y), angle, tilt: { roll: 0, pitch: 0 } }, () => {
      const renderer = draw.renderer;
      const td = new TiltDraw(renderer, tilt);
      const quadIndices = [0, 1, 2, 0, 2, 3];
      const flatZ = (z: number) => [z, z, z, z];

      // --- 1. Pilings: flat disks above the deck --------------------------
      const numPilings = Math.round(DOCK_LENGTH / PILING_SPACING) + 1;
      const pilingY = halfW + PILING_OUTBOARD;
      for (let i = 0; i < numPilings; i++) {
        const px = -halfL + (i * DOCK_LENGTH) / (numPilings - 1);
        for (const py of [-pilingY, pilingY]) {
          td.circle(px, py, PILING_Z, PILING_RADIUS, 16, PILING_COLOR);
        }
      }

      // --- 2. Mooring cleats: pair on each side at bow and stern ---------
      const cleatInsetY = halfW - CLEAT_EDGE_INSET;
      for (const cx of [this.bowCleatLocal.x, this.sternCleatLocal.x]) {
        for (const cy of [-cleatInsetY, cleatInsetY]) {
          for (const dx of [-CLEAT_HORN_HALF, CLEAT_HORN_HALF]) {
            td.line(
              cx + dx,
              cy,
              CLEAT_BASE_Z,
              cx + dx,
              cy,
              CLEAT_HORN_Z,
              CLEAT_POST_WIDTH,
              CLEAT_COLOR,
              1,
              true,
            );
          }
          td.line(
            cx - CLEAT_HORN_HALF,
            cy,
            CLEAT_HORN_Z,
            cx + CLEAT_HORN_HALF,
            cy,
            CLEAT_HORN_Z,
            CLEAT_HORN_WIDTH,
            CLEAT_COLOR,
            1,
            true,
          );
        }
      }

      // --- 3. Deck boards: crosswise planks with gaps --------------------
      const boardPitch = DECK_BOARD_WIDTH + DECK_BOARD_GAP;
      const numBoards = Math.floor(DOCK_LENGTH / boardPitch);
      const boardStartX = -halfL + (DOCK_LENGTH - numBoards * boardPitch) / 2;
      for (let i = 0; i < numBoards; i++) {
        const x0 = boardStartX + i * boardPitch;
        const x1 = x0 + DECK_BOARD_WIDTH;
        renderer.submitTrianglesWithZ(
          [
            [x0, -halfW],
            [x1, -halfW],
            [x1, halfW],
            [x0, halfW],
          ],
          quadIndices,
          DECK_BOARD_COLOR,
          1,
          flatZ(DECK_HEIGHT),
        );
      }

      // --- 4. Stringers: long beams under the deck boards ----------------
      // Rendered last; depth test rejects them where deck boards already
      // wrote, so they only appear through the gaps between planks.
      const stringerYs = [-halfW + STRINGER_INSET, 0, halfW - STRINGER_INSET];
      for (const sy of stringerYs) {
        renderer.submitTrianglesWithZ(
          [
            [-halfL, sy - STRINGER_WIDTH / 2],
            [halfL, sy - STRINGER_WIDTH / 2],
            [halfL, sy + STRINGER_WIDTH / 2],
            [-halfL, sy + STRINGER_WIDTH / 2],
          ],
          quadIndices,
          PILING_COLOR,
          1,
          flatZ(STRINGER_Z),
        );
      }
    });
  }
}
