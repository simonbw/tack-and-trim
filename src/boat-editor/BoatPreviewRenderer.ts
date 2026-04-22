/**
 * Renders a boat preview from a BoatConfig by constructing a real Boat
 * instance off-game (never added to the Game, so no physics or events fire)
 * and reparenting its BoatRenderer child into the preview entity so the
 * renderer gets registered with the game and draws on its own.
 *
 * The camera's orbit (yaw / pitch) is written into the hull body's
 * orientation matrix each render, just before the renderer draws.
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
  }

  setConfig(config: BoatConfig): void {
    // Destroy the old renderer so it stops drawing, then build a fresh Boat
    // and adopt its renderer.
    this.renderer.destroy();
    this.boat = new Boat(V(0, 0), config);
    this.renderer = findBoatRenderer(this.boat);
    this.addChild(this.renderer, true);
  }

  @on("render")
  onRender({ draw }: { dt: number; draw: Draw }) {
    // Fires before the child BoatRenderer's render handler (add order),
    // so pose updates land before drawing.
    const body = this.boat.hull.body;
    body.position.set(V(0, 0));
    body.z = 0;

    // Write the orientation matrix as Rz(yaw) · Ry(-pitch) · Rx(-roll),
    // matching draw.at()'s tilt convention so Body's roll/pitch getters
    // extract the same values we put in (and toWorldFrame3D stays correct
    // for BoatRenderer helpers that transform per-body points).
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
    body._angle = yaw;

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
