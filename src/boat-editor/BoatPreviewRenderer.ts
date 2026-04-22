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
   * Shadow the hull body's Euler getters (angle / roll / pitch) with direct
   * reads of the camera orbit. The class-level getters extract angles from
   * the orientation matrix via atan2, which suffers a 180° flip whenever
   * pitch crosses ±π/2 (cos(pitch) goes negative). Bypassing extraction
   * keeps BoatRenderer's tilt consistent with the water plane at every
   * orientation.
   */
  private installPoseOverrides(): void {
    const body = this.boat.hull.body;
    const camera = this.camera;
    const noop = () => {};
    Object.defineProperty(body, "angle", {
      configurable: true,
      get: () => camera.yaw,
      set: noop,
    });
    Object.defineProperty(body, "roll", {
      configurable: true,
      get: () => camera.roll,
      set: noop,
    });
    Object.defineProperty(body, "pitch", {
      configurable: true,
      get: () => camera.pitch,
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

    // Write the orientation matrix as Rz(yaw) · Ry(-pitch) · Rx(-roll),
    // matching draw.at()'s tilt convention so toWorldFrame3D maps
    // body-local points through the same rotation BoatRenderer applies.
    const yaw = this.camera.yaw;
    const pitch = this.camera.pitch;
    const roll = this.camera.roll;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const R = body.orientation;
    R[0] = cy * cp;
    R[1] = cy * sp * sr - sy * cr;
    R[2] = -cy * sp * cr - sy * sr;
    R[3] = sy * cp;
    R[4] = sy * sp * sr + cy * cr;
    R[5] = -sy * sp * cr + cy * sr;
    R[6] = sp;
    R[7] = -cp * sr;
    R[8] = cp * cr;

    // Flat water plane beneath the boat for reference. Draw inside the
    // same (yaw, pitch, roll) tilt context so it rotates with the boat.
    const size = 50;
    draw.at(
      {
        pos: V(0, 0),
        angle: yaw,
        tilt: { roll, pitch, zOffset: 0 },
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
