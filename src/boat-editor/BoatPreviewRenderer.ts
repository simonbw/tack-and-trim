/**
 * Renders a static boat preview from a BoatConfig.
 * No physics, no simulation — just the structural geometry.
 */

import { BaseEntity } from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import type { Draw } from "../core/graphics/Draw";
import { V } from "../core/Vector";
import {
  BoatConfig,
  HullConfig,
  RigConfig,
  RudderConfig,
} from "../game/boat/BoatConfig";
import { type HullMesh } from "../game/boat/Hull";
import { buildHullMeshFromProfiles } from "../game/boat/hull-profiles";
import type { BoatEditorCameraController } from "./BoatEditorCameraController";

export class BoatPreviewRenderer extends BaseEntity {
  private config: BoatConfig;
  private camera: BoatEditorCameraController;
  private mesh: HullMesh | null = null;

  constructor(config: BoatConfig, camera: BoatEditorCameraController) {
    super();
    this.config = config;
    this.camera = camera;
    this.rebuildMesh();
  }

  setConfig(config: BoatConfig): void {
    this.config = config;
    this.rebuildMesh();
  }

  private rebuildMesh(): void {
    this.mesh = buildHullMeshFromProfiles(this.config.hull.shape);
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const { config, camera, mesh } = this;
    if (!mesh) return;

    // Map orbit camera angles to tilt transform
    // yaw = rotation around boat, pitch = elevation
    const angle = -camera.yaw;
    const roll = 0;
    const pitch = camera.pitch;

    draw.at(
      {
        pos: V(0, 0),
        angle,
        tilt: { roll, pitch, zOffset: 0 },
      },
      () => {
        this.renderWaterPlane(draw);
        this.renderHull(draw, config.hull, mesh);
        this.renderKeel(draw, config);
        this.renderRudder(draw, config.rudder, config.tilt.zHeights.rudder);
        this.renderRig(draw, config.rig, config.hull.deckHeight);
        if (config.bowsprit) {
          this.renderBowsprit(
            draw,
            config.bowsprit,
            config.tilt.zHeights.bowsprit,
          );
        }
        if (config.lifelines) {
          this.renderLifelines(draw, config.lifelines, config.hull.deckHeight);
        }
      },
    );
  }

  private renderWaterPlane(draw: Draw): void {
    // Flat blue water plane for reference
    const size = 50;
    draw.fillRect(-size, -size, size * 2, size * 2, {
      color: 0x2244667,
      alpha: 0.3,
      z: 0,
    });
  }

  private renderHull(draw: Draw, hull: HullConfig, mesh: HullMesh): void {
    const {
      xyPositions,
      zValues,
      deckIndices,
      upperSideIndices,
      lowerSideIndices,
    } = mesh;

    const bottomColor = hull.colors.bottom ?? darken(hull.colors.fill, 0.65);
    const sideColor = hull.colors.side ?? darken(hull.colors.fill, 0.85);

    // Back-to-front: lower sides → upper sides → deck
    draw.renderer.submitTrianglesWithZ(
      xyPositions,
      lowerSideIndices,
      bottomColor,
      1.0,
      zValues,
    );
    draw.renderer.submitTrianglesWithZ(
      xyPositions,
      upperSideIndices,
      sideColor,
      1.0,
      zValues,
    );
    draw.renderer.submitTrianglesWithZ(
      xyPositions,
      deckIndices,
      hull.colors.fill,
      1.0,
      zValues,
    );

    // Gunwale outline
    const deckZ = hull.deckHeight;
    if (mesh.deckOutline) {
      draw.strokePolygon(
        mesh.deckOutline.map(([x, y]) => V(x, y)),
        { color: hull.colors.stroke, width: 0.25, z: deckZ },
      );
    }
  }

  private renderKeel(draw: Draw, config: BoatConfig): void {
    const keel = config.keel;
    const keelZ = config.tilt.zHeights.keel;
    const verts = keel.vertices;
    for (let i = 0; i < verts.length - 1; i++) {
      draw.line(verts[i].x, verts[i].y, verts[i + 1].x, verts[i + 1].y, {
        color: keel.color,
        width: 1,
        z: keelZ,
      });
    }
  }

  private renderRudder(
    draw: Draw,
    rudder: RudderConfig,
    rudderZ: number,
  ): void {
    // Rudder at its position, pointing aft (no steering angle in preview)
    draw.at({ pos: V(rudder.position.x, rudder.position.y) }, () => {
      draw.line(0, 0, -rudder.length, 0, {
        color: rudder.color,
        width: 0.5,
        z: rudderZ,
      });
    });
  }

  private renderRig(draw: Draw, rig: RigConfig, deckHeight: number): void {
    const mx = rig.mastPosition.x;
    const my = rig.mastPosition.y;
    const stayZ = rig.stays.deckHeight;

    // Standing rigging (forestay, shrouds, backstay)
    const stays = [
      rig.stays.forestay,
      rig.stays.portShroud,
      rig.stays.starboardShroud,
      rig.stays.backstay,
    ];
    for (const stay of stays) {
      draw.line(mx, my, stay.x, stay.y, {
        color: 0x999999,
        width: 0.1,
        z: stayZ,
      });
    }

    // Boom (resting along centerline)
    const boomZ = rig.mainsail.zFoot ?? 3;
    draw.fillRect(mx, -rig.boomWidth / 2, rig.boomLength, rig.boomWidth, {
      color: rig.colors.boom,
      z: boomZ,
    });

    // Mast
    const mastTopZ = 20; // approximate
    draw.line(mx, my, mx, my, {
      color: rig.colors.mast,
      width: 0.4,
      z: mastTopZ,
    });
    draw.fillCircle(mx, my, 0.3, {
      color: rig.colors.mast,
      z: deckHeight,
    });
  }

  private renderBowsprit(
    draw: Draw,
    bowsprit: NonNullable<BoatConfig["bowsprit"]>,
    bowspritZ: number,
  ): void {
    draw.fillRect(
      bowsprit.attachPoint.x,
      bowsprit.attachPoint.y - bowsprit.size.y / 2,
      bowsprit.size.x,
      bowsprit.size.y,
      { color: bowsprit.color, z: bowspritZ },
    );
  }

  private renderLifelines(
    draw: Draw,
    lifelines: NonNullable<BoatConfig["lifelines"]>,
    deckHeight: number,
  ): void {
    const topZ = deckHeight + lifelines.stanchionHeight;

    // Stanchions
    for (const s of lifelines.portStanchions) {
      draw.line(s[0], s[1], s[0], s[1], {
        color: lifelines.tubeColor,
        width: lifelines.tubeWidth,
        z: topZ,
      });
    }
    for (const s of lifelines.starboardStanchions) {
      draw.line(s[0], s[1], s[0], s[1], {
        color: lifelines.tubeColor,
        width: lifelines.tubeWidth,
        z: topZ,
      });
    }

    // Bow pulpit
    if (lifelines.bowPulpit.length > 1) {
      draw.renderer.setZ(topZ);
      const path = draw.path();
      path.moveTo(lifelines.bowPulpit[0][0], lifelines.bowPulpit[0][1]);
      for (let i = 1; i < lifelines.bowPulpit.length; i++) {
        path.lineTo(lifelines.bowPulpit[i][0], lifelines.bowPulpit[i][1]);
      }
      path.stroke(lifelines.tubeColor, lifelines.tubeWidth);
      draw.renderer.setZ(0);
    }

    // Stern pulpit
    if (lifelines.sternPulpit.length > 1) {
      draw.renderer.setZ(topZ);
      const path = draw.path();
      path.moveTo(lifelines.sternPulpit[0][0], lifelines.sternPulpit[0][1]);
      for (let i = 1; i < lifelines.sternPulpit.length; i++) {
        path.lineTo(lifelines.sternPulpit[i][0], lifelines.sternPulpit[i][1]);
      }
      path.stroke(lifelines.tubeColor, lifelines.tubeWidth);
      draw.renderer.setZ(0);
    }
  }
}

function darken(color: number, factor: number): number {
  const r = Math.floor(((color >> 16) & 0xff) * factor);
  const g = Math.floor(((color >> 8) & 0xff) * factor);
  const b = Math.floor((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
