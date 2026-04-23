/**
 * Renders a boat preview from a BoatConfig by constructing a real Boat
 * instance off-game (never added to the Game, so no physics or events fire)
 * and reparenting its BoatRenderer child into the preview entity so the
 * renderer gets registered with the game and draws on its own.
 *
 * The camera orbit (yaw / pitch / roll) is exposed to BoatRenderer two
 * ways: the hull body's Euler getters are shadowed to return camera
 * values directly (avoiding atan2 flip at pitch = ±π/2), and the body's
 * orientation matrix is written each render so toWorldFrame3D-based
 * helpers (rope rendering, block positions) see the same orientation.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { V } from "../core/Vector";
import { Boat } from "../game/boat/Boat";
import { BoatRenderer } from "../game/boat/BoatRenderer";
import type { BoatConfig } from "../game/boat/BoatConfig";
import type { BoatEditorCameraController } from "./BoatEditorCameraController";

export class BoatPreviewRenderer extends BaseEntity {
  private camera: BoatEditorCameraController;
  private boat: Boat;
  private renderer: BoatRenderer;

  // draw.at Euler decomposition of the current orbit, refreshed every
  // render; referenced by the pose overrides and the water-plane tilt.
  private drawAngle = 0;
  private drawPitch = 0;
  private drawRoll = 0;

  constructor(config: BoatConfig, camera: BoatEditorCameraController) {
    super();
    this.camera = camera;
    this.boat = new Boat(V(0, 0), config);
    this.renderer = findBoatRenderer(this.boat);
    this.addChild(this.renderer, true);
    this.installPoseOverrides();
  }

  setConfig(config: BoatConfig): void {
    // Destroy the old renderer so it stops drawing, then build a fresh Boat
    // and adopt its renderer.
    this.renderer.destroy();
    this.boat = new Boat(V(0, 0), config);
    this.renderer = findBoatRenderer(this.boat);
    this.addChild(this.renderer, true);
    this.installPoseOverrides();
  }

  /**
   * Shadow the hull body's Euler getters with the draw.at Z-Y-X
   * decomposition of the turntable rotation. BoatRenderer passes these
   * straight to draw.at, so the boat gets rendered with the exact
   * orientation matrix we wrote into body.orientation.
   */
  private installPoseOverrides(): void {
    const body = this.boat.hull.body;
    const self = this;
    const noop = () => {};
    Object.defineProperty(body, "angle", {
      configurable: true,
      get: () => self.drawAngle,
      set: noop,
    });
    Object.defineProperty(body, "pitch", {
      configurable: true,
      get: () => self.drawPitch,
      set: noop,
    });
    Object.defineProperty(body, "roll", {
      configurable: true,
      get: () => self.drawRoll,
      set: noop,
    });
  }

  @on("render")
  onRender({ draw }: { dt: number; draw: Draw }) {
    // Fires before the child BoatRenderer's render handler (add order),
    // so pose updates land before drawing.
    const body = this.boat.hull.body;
    body.position.set(V(0, 0));
    body.z = 0;

    // Turntable rotation: Rx(+pitch) · Rz(yaw). Yaw is applied in the
    // body frame first (spinning the boat around its mast axis), then
    // the whole thing tilts around the boat's forward axis toward the
    // port side as pitch increases. The mast stays upright on screen
    // regardless of how far you've orbited.
    const yaw = this.camera.yaw;
    const pitch = this.camera.pitch;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const R = body.orientation;
    R[0] = cy;
    R[1] = -sy;
    R[2] = 0;
    R[3] = cp * sy;
    R[4] = cp * cy;
    R[5] = -sp;
    R[6] = sp * sy;
    R[7] = sp * cy;
    R[8] = cp;

    // Decompose that rotation into draw.at's Z-Y-X Euler triple so we
    // can pass matching (angle, pitch_da, roll_da) to BoatRenderer and
    // to the water plane.
    this.drawAngle = Math.atan2(cp * sy, cy);
    this.drawPitch = Math.asin(sp * sy);
    this.drawRoll = Math.atan2(-sp * cy, cp);

    // Flat water plane beneath the boat for reference. Uses the
    // matching draw.at Euler triple so it rotates with the boat.
    const size = 50;
    draw.at(
      {
        pos: V(0, 0),
        angle: this.drawAngle,
        tilt: {
          roll: this.drawRoll,
          pitch: this.drawPitch,
          zOffset: 0,
        },
      },
      () => {
        draw.fillRect(-size, -size, size * 2, size * 2, {
          color: 0x224466,
          alpha: 0.3,
          z: 0,
        });
      },
    );
  }
}

function findBoatRenderer(boat: Boat): BoatRenderer {
  const renderer = boat.children?.find(
    (c): c is BoatRenderer => c instanceof BoatRenderer,
  );
  if (!renderer) throw new Error("Boat has no BoatRenderer child");
  return renderer;
}
