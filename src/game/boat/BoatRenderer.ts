import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { V } from "../../core/Vector";
import type { Boat } from "./Boat";
import type { BoatConfig } from "./BoatConfig";
import { buildDeckPlanMeshes } from "./deck-plan";
import { RopeShaderInstance } from "./RopeShader";
import {
  MeshContribution,
  TiltProjection,
  computeTiltProjection,
  roundCorners,
  extractCameraTransform,
  tessellateRopeStrip,
  tessellateScreenCircle,
  tessellateLineToQuad,
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
  private deckPlanMeshes: MeshContribution[] = [];

  // Per-sheet rope shader instances (lazy-created)
  private ropeShaders = new Map<import("./Sheet").Sheet, RopeShaderInstance>();

  constructor(private boat: Boat) {
    super();
    this.config = boat.config;
    this.buildStaticMeshes();
  }

  private buildStaticMeshes() {
    // Keel: vertical blade from hull bottom to keel tip
    const keel = this.boat.keel;
    const keelVertices = keel.getVertices();
    const keelColor = keel.getColor();
    const topZ = -this.config.hull.draft; // hull bottom
    const bottomZ = -this.config.keel.draft; // keel tip

    // Build a vertical quad strip: for each vertex, top and bottom copies
    const n = keelVertices.length;
    const positions: [number, number][] = [];
    const zValues: number[] = [];
    for (const v of keelVertices) {
      positions.push([v.x, v.y]); // top edge (at hull bottom)
      positions.push([v.x, v.y]); // bottom edge (at keel tip)
      zValues.push(topZ, bottomZ);
    }
    // Triangle strip indices: pairs of quads between consecutive vertices
    const indices: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const tl = i * 2; // top-left
      const bl = tl + 1; // bottom-left
      const tr = tl + 2; // top-right
      const br = tl + 3; // bottom-right
      indices.push(tl, tr, br, tl, br, bl);
    }
    this.keelMesh = { positions, zValues, indices, color: keelColor, alpha: 1 };

    // Build deck plan meshes if configured
    const deckPlan = this.config.hull.deckPlan;
    if (deckPlan) {
      const hullMeshData = this.boat.hull.getHeightMeshData();
      const hullOutline: [number, number][] =
        hullMeshData.deckOutline ??
        // Fallback: extract from first ringSize vertices (legacy ring mesh)
        Array.from({ length: hullMeshData.ringSize }, (_, i) => [
          hullMeshData.xyPositions[i][0],
          hullMeshData.xyPositions[i][1],
        ]);
      this.deckPlanMeshes = buildDeckPlanMeshes(
        deckPlan,
        hullOutline,
        this.config.hull.deckHeight,
        hullMeshData,
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
        this.renderRudder(renderer, tilt);

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
          hull.getSideColor(),
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
        // Deck surface: use deck plan zones if configured, otherwise flat deck cap
        if (this.deckPlanMeshes.length > 0) {
          for (const mesh of this.deckPlanMeshes) {
            this.submitMesh(renderer, mesh);
          }
        } else {
          renderer.submitTrianglesWithZ(
            xyPositions,
            deckIndices,
            hull.getFillColor(),
            1.0,
            zValues,
          );
        }

        // === 4. Gunwale stroke ===
        const meshData = hull.getHeightMeshData();
        const deckZ = meshData.zValues[0]; // deck ring z
        const gunwalePoints: [number, number][] = meshData.deckOutline
          ? meshData.deckOutline.map(([x, y]) => [x, y] as [number, number])
          : Array.from({ length: ringSize }, (_, i) => xyPositions[i]);
        const gunwaleZValues = gunwalePoints.map(() => deckZ);
        const gunwaleMesh = tessellateScreenWidthPolyline(
          gunwalePoints,
          gunwaleZValues,
          0.25,
          tilt,
          hull.getStrokeColor(),
          1,
          true,
        );
        this.submitMesh(renderer, gunwaleMesh);

        // === 5. Tiller ===
        this.renderTiller(renderer, tilt);

        // === 6. Bowsprit (cylindrical — screen-width, with round caps) ===
        if (this.boat.bowsprit) {
          const bs = this.boat.bowsprit;
          const bsZ = this.config.tilt.zHeights.bowsprit;
          this.submitMesh(
            renderer,
            tessellateScreenWidthLine(
              bs.localPosition.x,
              bs.localPosition.y,
              bsZ,
              bs.localPosition.x + bs.size.x,
              bs.localPosition.y,
              bsZ,
              bs.size.y,
              tilt,
              bs.getColor(),
              1,
              true,
            ),
          );
        }

        // === 7. Boom (cylindrical — screen-width) ===
        this.renderBoom(renderer, tilt);

        // === 8. Sheet blocks (small circles on deck) ===
        this.renderBlocks(renderer, tilt);

        // === 9. Standing rigging (wires — screen-width) ===
        this.renderStandingRigging(renderer, tilt);

        // === 10. Lifeline stanchions (tubes — screen-width) ===
        this.renderStanchions(renderer, tilt);

        // === 10. Lifeline pulpits and wires (screen-width) ===
        this.renderLifelineWires(renderer, tilt);

        // === 11. Mast (cylindrical — screen-width, tallest, drawn last) ===
        this.renderMast(renderer, tilt);
      },
    );

    // === 12. Sheets/ropes — rendered in world space (outside draw.at) ===
    // Sheet rope endpoints come from the cloth sim which includes tilt parallax,
    // matching the sail rendering. Rendering through the hull model matrix would
    // double-count the tilt.
    const renderer = draw.renderer;
    renderer.flush();
    this.renderSheet(renderer, this.boat.mainsheet, hullBody);
    if (this.boat.portJibSheet) {
      this.renderSheet(renderer, this.boat.portJibSheet, hullBody);
    }
    if (this.boat.starboardJibSheet) {
      this.renderSheet(renderer, this.boat.starboardJibSheet, hullBody);
    }
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
    tilt: TiltProjection,
  ) {
    const rudder = this.boat.rudder;
    const relAngle = rudder.getTillerAngleOffset();
    const pivot = rudder.getPosition();
    const rudderZ = rudder.getRudderZ();
    const rudderLength = rudder.getLength();
    const rudderColor = rudder.getColor();
    const deckZ = this.config.hull.deckHeight;
    const bladeTopZ = 0.5; // blade starts just above waterline
    const stockWidth = 0.3;

    // Blade trailing edge in hull-local coords (extends aft from the stock)
    const cos = Math.cos(relAngle);
    const sin = Math.sin(relAngle);
    const trailingX = pivot.x - rudderLength * cos;
    const trailingY = pivot.y - rudderLength * sin;

    // Rudder blade — vertical rectangle: leading edge at stock, trailing edge aft.
    // 4 corners: top-leading, top-trailing, bottom-trailing, bottom-leading.
    const bladeMesh: MeshContribution = {
      positions: [
        [pivot.x, pivot.y], // top-leading (at stock)
        [trailingX, trailingY], // top-trailing
        [trailingX, trailingY], // bottom-trailing
        [pivot.x, pivot.y], // bottom-leading (at stock)
      ],
      zValues: [bladeTopZ, bladeTopZ, rudderZ, rudderZ],
      indices: [0, 1, 2, 0, 2, 3],
      color: rudderColor,
      alpha: 1,
    };
    this.submitMesh(renderer, bladeMesh);

    // Blade top edge — screen-width line so blade has visible thickness from above
    const bladeWidth = 0.2;
    this.submitMesh(
      renderer,
      tessellateScreenWidthLine(
        pivot.x,
        pivot.y,
        bladeTopZ,
        trailingX,
        trailingY,
        bladeTopZ,
        bladeWidth,
        tilt,
        rudderColor,
        1,
        true,
      ),
    );

    // Rudder stock — vertical shaft from deck down through hull to blade
    // (cylindrical — screen-width)
    this.submitMesh(
      renderer,
      tessellateScreenWidthLine(
        pivot.x,
        pivot.y,
        deckZ,
        pivot.x,
        pivot.y,
        rudderZ,
        stockWidth,
        tilt,
        rudderColor,
        1,
        true,
      ),
    );
  }

  private renderTiller(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const rudder = this.boat.rudder;
    const tillerAngle = rudder.getTillerAngleOffset();
    const tillerPos = rudder.getPosition();
    const deckZ = this.config.hull.deckHeight;
    const tillerLength = 3;
    const tillerWidth = 0.25;
    const tillerColor = 0x886633;

    // Tiller arm (cylindrical — screen-width, with round caps)
    const cos = Math.cos(tillerAngle);
    const sin = Math.sin(tillerAngle);
    const tipX = tillerPos.x + tillerLength * cos;
    const tipY = tillerPos.y + tillerLength * sin;

    this.submitMesh(
      renderer,
      tessellateScreenWidthLine(
        tillerPos.x,
        tillerPos.y,
        deckZ,
        tipX,
        tipY,
        deckZ,
        tillerWidth,
        tilt,
        tillerColor,
        1,
        true,
      ),
    );
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

    // Boom body (cylindrical — screen-width, with round caps)
    this.submitMesh(
      renderer,
      tessellateScreenWidthLine(
        mastPos.x,
        mastPos.y,
        boomZ,
        endX,
        endY,
        boomZ,
        rig.getBoomWidth(),
        tilt,
        rig.getBoomColor(),
        1,
        true,
      ),
    );
  }

  private renderBlocks(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const deckZ = this.config.hull.deckHeight;
    const sheets = [
      this.boat.mainsheet,
      this.boat.portJibSheet,
      this.boat.starboardJibSheet,
    ];
    for (const sheet of sheets) {
      if (!sheet) continue;
      for (const pos of sheet.getBlockPositions()) {
        // Small circle at the block, rendered in hull-local frame (the
        // draw.at tilt context transforms hull-local → world).
        // Convert world position back to hull-local for the tilt context.
        const hullBody = this.boat.hull.body;
        const local = hullBody.toLocalFrame(pos);
        this.submitMesh(
          renderer,
          tessellateScreenCircle(
            local[0],
            local[1],
            deckZ,
            0.3,
            8,
            tilt,
            0x444444,
            1,
          ),
        );
      }
    }
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
          1,
          true,
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

    // Bow pulpit
    if (lifelineConfig.bowPulpit.length >= 2) {
      const points = lifelineConfig.bowPulpit.map(
        (p) => [p[0], p[1]] as [number, number],
      );
      const rounded = roundCorners(
        points,
        points.map(() => topZ),
        1.5,
        16,
      );
      this.renderRoundedPolyline(
        renderer,
        tilt,
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tubeColor,
      );
      this.renderPulpitPosts(
        renderer,
        tilt,
        points,
        rounded,
        deckZ,
        topZ,
        tubeWidth,
        tubeColor,
      );
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
        16,
      );
      this.renderRoundedPolyline(
        renderer,
        tilt,
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tubeColor,
      );
      this.renderPulpitPosts(
        renderer,
        tilt,
        points,
        rounded,
        deckZ,
        topZ,
        tubeWidth,
        tubeColor,
      );
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

  /** Render vertical posts at pulpit points. Endpoints use original positions;
   *  interior vertices use arc midpoints so posts sit under the rounded path. */
  /** Render a screen-width polyline with round joins and round end caps. */
  private renderRoundedPolyline(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
    points: [number, number][],
    zValues: number[],
    width: number,
    color: number,
  ) {
    this.submitMesh(
      renderer,
      tessellateScreenWidthPolyline(
        points,
        zValues,
        width,
        tilt,
        color,
        1,
        false,
        true,
      ),
    );
  }

  private renderPulpitPosts(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
    originalPoints: [number, number][],
    rounded: ReturnType<typeof roundCorners>,
    deckZ: number,
    topZ: number,
    tubeWidth: number,
    tubeColor: number,
  ) {
    for (let i = 0; i < originalPoints.length; i++) {
      // First and last points aren't rounded, use original positions.
      // Interior points use arc midpoints so posts align with the rounded path.
      let px: number, py: number;
      if (i === 0 || i === originalPoints.length - 1) {
        [px, py] = originalPoints[i];
      } else {
        const mid = rounded.arcMidpoints[i - 1];
        px = mid.x;
        py = mid.y;
      }

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
          1,
          true,
        ),
      );
    }
  }

  private getRopeShader(sheet: import("./Sheet").Sheet): RopeShaderInstance {
    let instance = this.ropeShaders.get(sheet);
    if (!instance) {
      instance = new RopeShaderInstance(32);
      this.ropeShaders.set(sheet, instance);
    }
    return instance;
  }

  private renderSheet(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    sheet: import("./Sheet").Sheet,
    hullBody: import("../../core/physics/body/DynamicBody").DynamicBody,
  ) {
    const opacity = sheet.getOpacity();
    if (opacity <= 0) return;

    // Rope points come from 3D physics particles. The positions already
    // include tilt parallax via toWorldFrame3D on 6DOF bodies.
    const { points: worldPoints, z: zPerPoint } = sheet.getRopePointsWithZ();
    if (worldPoints.length < 2) return;

    const ropeShader = this.getRopeShader(sheet);
    const width = sheet.getRopeThickness();
    const cam = extractCameraTransform(renderer.getTransform());

    const { vertexCount, indexCount } = tessellateRopeStrip(
      worldPoints as [number, number][],
      zPerPoint,
      width,
      cam,
      ropeShader.scratchVertexData,
      ropeShader.scratchIndexData,
    );

    if (vertexCount === 0) return;

    ropeShader.draw(
      renderer,
      ropeShader.scratchVertexData,
      vertexCount,
      ropeShader.scratchIndexData,
      indexCount,
      sheet.getRopeColor(),
      sheet.getRopeStrandColor(),
      opacity,
      width,
      0, // time — not used (twist pattern is static)
    );
  }

  private renderMast(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    tilt: TiltProjection,
  ) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();

    // Mast shaft (cylindrical — screen-width, with round caps)
    this.submitMesh(
      renderer,
      tessellateScreenWidthLine(
        mastPos.x,
        mastPos.y,
        0,
        mastPos.x,
        mastPos.y,
        mastTopZ,
        0.4,
        tilt,
        rig.getMastColor(),
        1,
        true,
      ),
    );

    // Boom connection cap (intermediate, not an endpoint)
    const mastCapR = 0.4 / 2;
    const mastColor = rig.getMastColor();
    const boomZ = rig.getBoomZ();
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
  }
}
