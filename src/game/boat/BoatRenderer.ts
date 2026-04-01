import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { lerp } from "../../core/util/MathUtil";
import { V } from "../../core/Vector";
import type { Boat } from "./Boat";
import type { BoatConfig } from "./BoatConfig";
import {
  MeshContribution,
  tessellateCircleToTris,
  tessellateLineToQuad,
  tessellatePolylineToStrip,
  tessellateRectToTris,
  tessellateRotatedRectToTris,
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
  private mastBaseMesh: MeshContribution | null = null;
  private mastTopMesh: MeshContribution | null = null;

  // Lifeline static meshes
  private bowPulpitMesh: MeshContribution | null = null;
  private sternPulpitMesh: MeshContribution | null = null;
  private portLifelineMesh: MeshContribution | null = null;
  private starboardLifelineMesh: MeshContribution | null = null;

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

    // Mast base and top circles (static in hull-local space)
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();
    this.mastBaseMesh = tessellateCircleToTris(
      mastPos.x,
      mastPos.y,
      0,
      0.3,
      8,
      rig.getMastColor(),
    );
    this.mastTopMesh = tessellateCircleToTris(
      mastPos.x,
      mastPos.y,
      mastTopZ,
      0.2,
      8,
      rig.getMastColor(),
    );

    // Lifeline static meshes
    this.buildLifelineMeshes();
  }

  private buildLifelineMeshes() {
    const lifelineConfig = this.config.lifelines;
    if (!lifelineConfig) return;

    const deckZ = this.config.hull.deckHeight;
    const topZ = deckZ + lifelineConfig.stanchionHeight;
    const { tubeColor, wireColor, tubeWidth, wireWidth } = lifelineConfig;

    // Bow pulpit
    if (lifelineConfig.bowPulpit.length >= 2) {
      const points = lifelineConfig.bowPulpit.map(
        (p) => [p[0], p[1]] as [number, number],
      );
      this.bowPulpitMesh = tessellatePolylineToStrip(
        points,
        points.map(() => topZ),
        tubeWidth,
        tubeColor,
      );
    }

    // Stern pulpit
    if (lifelineConfig.sternPulpit.length >= 2) {
      const points = lifelineConfig.sternPulpit.map(
        (p) => [p[0], p[1]] as [number, number],
      );
      this.sternPulpitMesh = tessellatePolylineToStrip(
        points,
        points.map(() => topZ),
        tubeWidth,
        tubeColor,
      );
    }

    // Port lifeline wire
    this.portLifelineMesh = this.buildLifelineWireMesh(
      lifelineConfig.bowPulpit,
      lifelineConfig.portStanchions,
      lifelineConfig.sternPulpit,
      true,
      topZ,
      wireColor,
      wireWidth,
    );

    // Starboard lifeline wire
    this.starboardLifelineMesh = this.buildLifelineWireMesh(
      lifelineConfig.bowPulpit,
      lifelineConfig.starboardStanchions,
      lifelineConfig.sternPulpit,
      false,
      topZ,
      wireColor,
      wireWidth,
    );
  }

  private buildLifelineWireMesh(
    bowPulpit: ReadonlyArray<readonly [number, number]>,
    stanchions: ReadonlyArray<readonly [number, number]>,
    sternPulpit: ReadonlyArray<readonly [number, number]>,
    isPort: boolean,
    z: number,
    color: number,
    width: number,
  ): MeshContribution | null {
    if (stanchions.length === 0) return null;

    const points: [number, number][] = [];

    if (bowPulpit.length > 0) {
      const bp = isPort ? bowPulpit[bowPulpit.length - 1] : bowPulpit[0];
      points.push([bp[0], bp[1]]);
    }

    for (const s of stanchions) {
      points.push([s[0], s[1]]);
    }

    if (sternPulpit.length > 0) {
      const sp = isPort ? sternPulpit[sternPulpit.length - 1] : sternPulpit[0];
      points.push([sp[0], sp[1]]);
    }

    if (points.length < 2) return null;

    return tessellatePolylineToStrip(
      points,
      points.map(() => z),
      width,
      color,
    );
  }

  @on("render")
  onRender({ draw }: { draw: Draw }) {
    const hull = this.boat.hull;
    const hullBody = hull.body;
    const [x, y] = hullBody.position;

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

        // === 2. Rudder blade (underwater) ===
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

        // === 7. Boom ===
        this.renderBoom(renderer);

        // === 8. Standing rigging ===
        this.renderStandingRigging(renderer);

        // === 9. Lifeline stanchions ===
        this.renderStanchions(renderer);

        // === 10. Lifeline pulpits and wires ===
        this.submitMesh(renderer, this.bowPulpitMesh);
        this.submitMesh(renderer, this.sternPulpitMesh);
        this.submitMesh(renderer, this.portLifelineMesh);
        this.submitMesh(renderer, this.starboardLifelineMesh);

        // === 11. Sheets/ropes ===
        this.renderSheet(renderer, this.boat.mainsheet);
        if (this.boat.portJibSheet) {
          this.renderSheet(renderer, this.boat.portJibSheet);
        }
        if (this.boat.starboardJibSheet) {
          this.renderSheet(renderer, this.boat.starboardJibSheet);
        }

        // === 12. Mast (tallest, drawn last) ===
        this.renderMast(renderer);
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
  ) {
    const rig = this.boat.rig;
    const hullAngle = this.boat.hull.body.angle;
    const boomRelAngle = rig.body.angle - hullAngle;
    const mastPos = rig.getMastPosition();
    const boomLength = rig.getBoomLength();
    const boomWidth = rig.getBoomWidth();
    const boomZ = rig.getBoomZ();

    // Boom endpoints in hull-local coords
    const cos = Math.cos(boomRelAngle);
    const sin = Math.sin(boomRelAngle);
    const endX = mastPos.x - boomLength * cos;
    const endY = mastPos.y - boomLength * sin;

    // Boom body
    const boomMesh = tessellateRotatedRectToTris(
      mastPos.x,
      mastPos.y,
      0,
      -boomWidth / 2,
      boomLength,
      boomWidth,
      boomRelAngle + Math.PI, // boom extends aft (negative direction)
      boomZ,
      rig.getBoomColor(),
    );
    this.submitMesh(renderer, boomMesh);

    // Boom end cap
    const capMesh = tessellateCircleToTris(endX, endY, boomZ, 0.3, 8, 0x664422);
    this.submitMesh(renderer, capMesh);
  }

  private renderStandingRigging(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
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
      const mesh = tessellateLineToQuad(
        mastPos.x,
        mastPos.y,
        mastTopZ,
        attach.x,
        attach.y,
        deckHeight,
        0.1,
        0x999999,
      );
      this.submitMesh(renderer, mesh);
    }
  }

  private renderStanchions(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
  ) {
    const lifelineConfig = this.config.lifelines;
    if (!lifelineConfig) return;

    const deckZ = this.config.hull.deckHeight;
    const topZ = deckZ + lifelineConfig.stanchionHeight;

    const allStanchions = [
      ...lifelineConfig.portStanchions,
      ...lifelineConfig.starboardStanchions,
    ];

    for (const [sx, sy] of allStanchions) {
      const mesh = tessellateLineToQuad(
        sx,
        sy,
        deckZ,
        sx,
        sy,
        topZ,
        lifelineConfig.tubeWidth,
        lifelineConfig.tubeColor,
      );
      this.submitMesh(renderer, mesh);
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

    const mesh = tessellatePolylineToStrip(
      localPoints,
      zPerPoint,
      sheet.getRopeThickness(),
      sheet.getRopeColor(),
      opacity,
    );
    this.submitMesh(renderer, mesh);
  }

  private renderMast(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
  ) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();

    // Mast shaft: line from base (z=0) to top (z=mastTopZ)
    const mastMesh = tessellateLineToQuad(
      mastPos.x,
      mastPos.y,
      0,
      mastPos.x,
      mastPos.y,
      mastTopZ,
      0.4,
      rig.getMastColor(),
    );
    this.submitMesh(renderer, mastMesh);

    // Mast base and top circles
    this.submitMesh(renderer, this.mastBaseMesh);
    this.submitMesh(renderer, this.mastTopMesh);
  }
}
