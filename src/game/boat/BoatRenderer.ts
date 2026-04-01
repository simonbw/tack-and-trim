import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { lerp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import type { Boat } from "./Boat";
import type { BoatConfig } from "./BoatConfig";
import {
  MeshContribution,
  TiltProjection,
  computeTiltProjection,
  roundCorners,
  subdivideSmooth,
  tessellateScreenCircle,
  tessellateLineToQuad,
  tessellatePolylineToStrip,
  tessellateRectToTris,
  tessellateRotatedRectToTris,
  tessellateScreenWidthLine,
  tessellateScreenWidthPolyline,
} from "./tessellation";

/**
 * Unified boat renderer that collects geometry from all boat components
 * and submits it through a single tilt context with per-vertex z-values.
 *
 * This fixes z-ordering issues caused by the previous approach where each
 * component rendered independently with inconsistent z-handling.
 */
export class BoatRenderer extends BaseEntity {
  layer = "boat" as const;

  private config: BoatConfig;

  // Pre-built static meshes (hull-local, computed once)
  private keelMesh: MeshContribution | null = null;
  private bowspritMesh: MeshContribution | null = null;

  constructor(private boat: Boat) {
    super();
    this.config = boat.config;
    this.buildStaticMeshes();
  }

  private buildStaticMeshes() {
    // Keel: polyline at keelZ
    const keel = this.boat.keel;
    const keelVertices = keel.getVertices();
    const keelZ = keel.getKeelZ();
    const keelPoints: [number, number][] = keelVertices.map((v) => [v.x, v.y]);
    const keelZValues = keelPoints.map(() => keelZ);
    this.keelMesh = tessellatePolylineToStrip(
      keelPoints,
      keelZValues,
      1,
      keel.getColor(),
    );

    // Bowsprit
    if (this.boat.bowsprit) {
      const bs = this.boat.bowsprit;
      const bowspritZ = this.config.tilt.zHeights.bowsprit;
      this.bowspritMesh = tessellateRectToTris(
        bs.localPosition.x,
        bs.localPosition.y - bs.size.y / 2,
        bs.size.x,
        bs.size.y,
        bowspritZ,
        bs.getColor(),
      );
    }
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const hull = this.boat.hull;
    const hullBody = hull.body;
    const [x, y] = hullBody.position;

    // Precompute tilt projection for screen-width tessellation
    const tilt = computeTiltProjection(
      hullBody.angle,
      hullBody.roll,
      hullBody.pitch,
    );

    draw.at(
      {
        pos: V(x, y),
        angle: hullBody.angle,
        tilt: {
          roll: hullBody.roll,
          pitch: hullBody.pitch,
          zOffset: hullBody.z,
        },
      },
      () => {
        const renderer = draw.renderer;

        // === 1. Keel (deepest, drawn first) ===
        this.submitMesh(renderer, this.keelMesh);

        // === 2. Rudder blade (underwater, flat — hull-local width is correct) ===
        this.renderRudder(renderer);

        // === 3. Hull mesh (lower sides → upper sides → deck) ===
        const {
          xyPositions,
          zValues,
          lowerSideIndices,
          upperSideIndices,
          deckIndices,
          ringSize,
        } = hull.getHeightMeshData();

        renderer.submitTrianglesWithZ(
          xyPositions,
          lowerSideIndices,
          hull.getBottomColor(),
          1.0,
          zValues,
        );
        renderer.submitTrianglesWithZ(
          xyPositions,
          upperSideIndices,
          hull.getSideColor(),
          1.0,
          zValues,
        );
        renderer.submitTrianglesWithZ(
          xyPositions,
          deckIndices,
          hull.getFillColor(),
          1.0,
          zValues,
        );

        // === 4. Gunwale stroke ===
        const deckZ = hull.getHeightMeshData().zValues[0]; // deck ring z
        const gunwalePoints: [number, number][] = [];
        for (let i = 0; i < ringSize; i++) {
          gunwalePoints.push(xyPositions[i]);
        }
        const gunwaleZValues = gunwalePoints.map(() => deckZ);
        const gunwaleMesh = tessellatePolylineToStrip(
          gunwalePoints,
          gunwaleZValues,
          0.25,
          hull.getStrokeColor(),
          1,
          true,
        );
        this.submitMesh(renderer, gunwaleMesh);

        // === 5. Tiller ===
        this.renderTiller(renderer);

        // === 6. Bowsprit ===
        this.submitMesh(renderer, this.bowspritMesh);
        if (this.boat.bowsprit) {
          const bs = this.boat.bowsprit;
          const bsZ = this.config.tilt.zHeights.bowsprit;
          const tipX = bs.localPosition.x + bs.size.x;
          const tipY = bs.localPosition.y;
          this.submitMesh(
            renderer,
            tessellateScreenCircle(
              tipX,
              tipY,
              bsZ,
              bs.size.y / 2,
              16,
              tilt,
              bs.getColor(),
            ),
          );
        }

        // === 7. Boom (cylindrical — screen-width) ===
        this.renderBoom(renderer, tilt);

        // === 8. Standing rigging (wires — screen-width) ===
        this.renderStandingRigging(renderer, tilt);

        // === 9. Lifeline stanchions (tubes — screen-width) ===
        this.renderStanchions(renderer, tilt);

        // === 10. Lifeline pulpits and wires (screen-width) ===
        this.renderLifelineWires(renderer, tilt);

        // === 11. Sheets/ropes ===
        this.renderSheet(renderer, this.boat.mainsheet);
        if (this.boat.portJibSheet) {
          this.renderSheet(renderer, this.boat.portJibSheet);
        }
        if (this.boat.starboardJibSheet) {
          this.renderSheet(renderer, this.boat.starboardJibSheet);
        }

        // === 12. Mast (cylindrical — screen-width, tallest, drawn last) ===
        this.renderMast(renderer, tilt);
      },
    );
  }

  private submitMesh(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    mesh: MeshContribution | null,
  ) {
    if (!mesh || mesh.indices.length === 0) return;
    renderer.submitTrianglesWithZ(
      mesh.positions,
      mesh.indices,
      mesh.color,
      mesh.alpha,
      mesh.zValues,
    );
  }

  private renderRudder(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
  ) {
    const rudder = this.boat.rudder;
    const relAngle = rudder.getTillerAngleOffset();
    const pivot = rudder.getPosition();
    const rudderZ = rudder.getRudderZ();
    const rudderLength = rudder.getLength();

    // Blade tip in hull-local coords
    const cos = Math.cos(relAngle);
    const sin = Math.sin(relAngle);
    const tipX = pivot.x - rudderLength * cos;
    const tipY = pivot.y - rudderLength * sin;

    // Rudder extends from hull bottom (z ~ 0 at pivot) down to rudderZ at tip
    const pivotZ = rudderZ * 0.3; // pivot is shallower
    const mesh = tessellateLineToQuad(
      pivot.x,
      pivot.y,
      pivotZ,
      tipX,
      tipY,
      rudderZ,
      0.5,
      rudder.getColor(),
    );
    this.submitMesh(renderer, mesh);
  }

  private renderTiller(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
  ) {
    const rudder = this.boat.rudder;
    const tillerAngle = rudder.getTillerAngleOffset();
    const tillerPos = rudder.getPosition();
    const deckZ = this.config.hull.deckHeight;
    const tillerLength = 3;
    const tillerWidth = 0.25;

    // Tiller outline (larger rect drawn first, slightly behind in z)
    const outline = tessellateRotatedRectToTris(
      tillerPos.x,
      tillerPos.y,
      -0.05,
      -tillerWidth / 2 - 0.05,
      tillerLength + 0.1,
      tillerWidth + 0.1,
      tillerAngle,
      deckZ - 0.01,
      0x664422,
    );
    this.submitMesh(renderer, outline);

    // Tiller fill (on top of outline)
    const fill = tessellateRotatedRectToTris(
      tillerPos.x,
      tillerPos.y,
      0,
      -tillerWidth / 2,
      tillerLength,
      tillerWidth,
      tillerAngle,
      deckZ,
      0x886633,
    );
    this.submitMesh(renderer, fill);
  }

  private renderBoom(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const rig = this.boat.rig;
    const hullAngle = this.boat.hull.body.angle;
    const boomRelAngle = rig.body.angle - hullAngle;
    const mastPos = rig.getMastPosition();
    const boomLength = rig.getBoomLength();
    const boomZ = rig.getBoomZ();

    // Boom endpoints in hull-local coords
    const cos = Math.cos(boomRelAngle);
    const sin = Math.sin(boomRelAngle);
    const endX = mastPos.x - boomLength * cos;
    const endY = mastPos.y - boomLength * sin;

    // Boom body (cylindrical — screen-width)
    const boomMesh = tessellateScreenWidthLine(
      mastPos.x,
      mastPos.y,
      boomZ,
      endX,
      endY,
      boomZ,
      rig.getBoomWidth(),
      tilt,
      rig.getBoomColor(),
    );
    this.submitMesh(renderer, boomMesh);

    // Boom end caps (match line width for flush rounded ends)
    const boomCapR = rig.getBoomWidth() / 2;
    this.submitMesh(
      renderer,
      tessellateScreenCircle(
        mastPos.x,
        mastPos.y,
        boomZ,
        boomCapR,
        16,
        tilt,
        rig.getBoomColor(),
      ),
    );
    this.submitMesh(
      renderer,
      tessellateScreenCircle(
        endX,
        endY,
        boomZ,
        boomCapR,
        16,
        tilt,
        rig.getBoomColor(),
      ),
    );
  }

  private renderStandingRigging(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();
    const stays = rig.getStays();
    const deckHeight = stays.deckHeight;

    const attachments = [
      stays.forestay,
      stays.portShroud,
      stays.starboardShroud,
      stays.backstay,
    ];

    for (const attach of attachments) {
      const mesh = tessellateScreenWidthLine(
        mastPos.x,
        mastPos.y,
        mastTopZ,
        attach.x,
        attach.y,
        deckHeight,
        0.1,
        tilt,
        0x999999,
      );
      this.submitMesh(renderer, mesh);
    }
  }

  private renderStanchions(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const lifelineConfig = this.config.lifelines;
    if (!lifelineConfig) return;

    const deckZ = this.config.hull.deckHeight;
    const topZ = deckZ + lifelineConfig.stanchionHeight;

    const allStanchions = [
      ...lifelineConfig.portStanchions,
      ...lifelineConfig.starboardStanchions,
    ];

    const capRadius = lifelineConfig.tubeWidth / 2;
    for (const [sx, sy] of allStanchions) {
      this.submitMesh(
        renderer,
        tessellateScreenWidthLine(
          sx,
          sy,
          deckZ,
          sx,
          sy,
          topZ,
          lifelineConfig.tubeWidth,
          tilt,
          lifelineConfig.tubeColor,
        ),
      );
      this.submitMesh(
        renderer,
        tessellateScreenCircle(
          sx,
          sy,
          deckZ,
          capRadius,
          16,
          tilt,
          lifelineConfig.tubeColor,
        ),
      );
      this.submitMesh(
        renderer,
        tessellateScreenCircle(
          sx,
          sy,
          topZ,
          capRadius,
          16,
          tilt,
          lifelineConfig.tubeColor,
        ),
      );
    }
  }

  private renderLifelineWires(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const lifelineConfig = this.config.lifelines;
    if (!lifelineConfig) return;

    const deckZ = this.config.hull.deckHeight;
    const topZ = deckZ + lifelineConfig.stanchionHeight;
    const { tubeColor, wireColor, tubeWidth, wireWidth } = lifelineConfig;

    const capRadius = tubeWidth / 2;

    // Bow pulpit
    if (lifelineConfig.bowPulpit.length >= 2) {
      const points = lifelineConfig.bowPulpit.map(
        (p) => [p[0], p[1]] as [number, number],
      );
      const rounded = roundCorners(
        points,
        points.map(() => topZ),
        1.5,
      );
      const mesh = tessellateScreenWidthPolyline(
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tilt,
        tubeColor,
      );
      this.submitMesh(renderer, mesh);

      // Vertical posts at each pulpit point
      for (const [px, py] of points) {
        this.submitMesh(
          renderer,
          tessellateScreenWidthLine(
            px,
            py,
            deckZ,
            px,
            py,
            topZ,
            tubeWidth,
            tilt,
            tubeColor,
          ),
        );
        this.submitMesh(
          renderer,
          tessellateScreenCircle(px, py, deckZ, capRadius, 16, tilt, tubeColor),
        );
        this.submitMesh(
          renderer,
          tessellateScreenCircle(px, py, topZ, capRadius, 16, tilt, tubeColor),
        );
      }
    }

    // Stern pulpit
    if (lifelineConfig.sternPulpit.length >= 2) {
      const points = lifelineConfig.sternPulpit.map(
        (p) => [p[0], p[1]] as [number, number],
      );
      const rounded = roundCorners(
        points,
        points.map(() => topZ),
        1.5,
      );
      const mesh = tessellateScreenWidthPolyline(
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tilt,
        tubeColor,
      );
      this.submitMesh(renderer, mesh);

      for (const [px, py] of points) {
        this.submitMesh(
          renderer,
          tessellateScreenWidthLine(
            px,
            py,
            deckZ,
            px,
            py,
            topZ,
            tubeWidth,
            tilt,
            tubeColor,
          ),
        );
        this.submitMesh(
          renderer,
          tessellateScreenCircle(px, py, deckZ, capRadius, 16, tilt, tubeColor),
        );
        this.submitMesh(
          renderer,
          tessellateScreenCircle(px, py, topZ, capRadius, 16, tilt, tubeColor),
        );
      }
    }

    // Lifeline wires (port and starboard)
    for (const isPort of [true, false]) {
      const stanchions = isPort
        ? lifelineConfig.portStanchions
        : lifelineConfig.starboardStanchions;
      if (stanchions.length === 0) continue;

      const points: [number, number][] = [];
      if (lifelineConfig.bowPulpit.length > 0) {
        const bp = isPort
          ? lifelineConfig.bowPulpit[lifelineConfig.bowPulpit.length - 1]
          : lifelineConfig.bowPulpit[0];
        points.push([bp[0], bp[1]]);
      }
      for (const s of stanchions) {
        points.push([s[0], s[1]]);
      }
      if (lifelineConfig.sternPulpit.length > 0) {
        const sp = isPort
          ? lifelineConfig.sternPulpit[lifelineConfig.sternPulpit.length - 1]
          : lifelineConfig.sternPulpit[0];
        points.push([sp[0], sp[1]]);
      }

      if (points.length >= 2) {
        const mesh = tessellateScreenWidthPolyline(
          points,
          points.map(() => topZ),
          wireWidth,
          tilt,
          wireColor,
        );
        this.submitMesh(renderer, mesh);
      }
    }
  }

  private renderSheet(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    sheet: import("./Sheet").Sheet,
  ) {
    const opacity = sheet.getOpacity();
    if (opacity <= 0) return;

    const hullBody = this.boat.hull.body;
    const points = sheet.getRopePoints();
    const n = points.length;
    if (n < 2) return;

    const zA = sheet.getZA();
    const zB = sheet.getZB();

    // Transform world-space rope points to hull-local coords
    const localPoints: [number, number][] = [];
    const zPerPoint: number[] = [];

    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const z = lerp(zA, zB, t);
      const local = hullBody.toLocalFrame(points[i]);
      localPoints.push([local.x, local.y]);
      zPerPoint.push(z);
    }

    // Smooth subdivision for rope curves (matches old bezier rendering)
    const smooth = subdivideSmooth(localPoints, zPerPoint, 6);

    const mesh = tessellatePolylineToStrip(
      smooth.points,
      smooth.zValues,
      sheet.getRopeThickness(),
      sheet.getRopeColor(),
      opacity,
    );
    this.submitMesh(renderer, mesh);
  }

  private renderMast(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();

    // Mast shaft (cylindrical — screen-width)
    const mastMesh = tessellateScreenWidthLine(
      mastPos.x,
      mastPos.y,
      0,
      mastPos.x,
      mastPos.y,
      mastTopZ,
      0.4,
      tilt,
      rig.getMastColor(),
    );
    this.submitMesh(renderer, mastMesh);

    // Mast caps: base, boom connection, and top
    const mastCapR = 0.4 / 2;
    const mastColor = rig.getMastColor();
    const boomZ = rig.getBoomZ();
    this.submitMesh(
      renderer,
      tessellateScreenCircle(
        mastPos.x,
        mastPos.y,
        0,
        mastCapR,
        16,
        tilt,
        mastColor,
      ),
    );
    this.submitMesh(
      renderer,
      tessellateScreenCircle(
        mastPos.x,
        mastPos.y,
        boomZ,
        mastCapR,
        16,
        tilt,
        mastColor,
      ),
    );
    this.submitMesh(
      renderer,
      tessellateScreenCircle(
        mastPos.x,
        mastPos.y,
        mastTopZ,
        mastCapR,
        16,
        tilt,
        mastColor,
      ),
    );
  }
}
