import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type { Draw } from "../../core/graphics/Draw";
import { lighten } from "../../core/util/ColorUtils";
import { profiler } from "../../core/util/Profiler";
import { V } from "../../core/Vector";
import type { Boat } from "./Boat";
import type { BoatConfig } from "./BoatConfig";
import { buildDeckPlanMeshes } from "./deck-plan";
import { TimeOfDay } from "../time/TimeOfDay";
import { RopeShaderInstance } from "./RopeShader";
import {
  type MeshContribution,
  computeTiltProjection,
  roundCorners,
  catmullRomOutputCount,
  extractCameraTransform,
  subdivideCatmullRom,
  tessellateRopeStrip,
} from "./tessellation";
import { TiltDraw } from "./TiltDraw";
import type { RopePattern } from "./RopeShader";

/**
 * A rope-like visual (Sheet, Halyard, …) that exposes a uniform render API.
 * Sheet adds its own winch/tension queries; those aren't used here.
 */
interface RopeVisual {
  getOpacity(): number;
  getRopePointsWithZ(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  };
  getRopeThickness(): number;
  getRopePattern(): RopePattern;
}

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
        const td = new TiltDraw(renderer, tilt);

        // === 1. Keel (deepest, drawn first) ===
        td.mesh(this.keelMesh);

        // === 2. Rudder blade (underwater, flat — hull-local width is correct) ===
        this.renderRudder(td);

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
            td.mesh(mesh);
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
        // Gunwales sit a couple of inches above the deck surface
        const gunwaleZ = deckZ + 0.2;
        td.polyline(
          gunwalePoints,
          gunwalePoints.map(() => gunwaleZ),
          0.25,
          hull.getStrokeColor(),
          1,
          true,
        );

        // === 5. Helm (tiller or wheel) ===
        this.renderHelm(td);

        // === 6. Bowsprit (cylindrical — screen-width, with round caps) ===
        if (this.boat.bowsprit) {
          const bs = this.boat.bowsprit;
          const bsZ = this.config.tilt.zHeights.bowsprit;
          td.line(
            bs.localPosition.x,
            bs.localPosition.y,
            bsZ,
            bs.localPosition.x + bs.size.x,
            bs.localPosition.y,
            bsZ,
            bs.size.y,
            bs.getColor(),
            1,
            true,
          );
        }

        // === 7. Boom (cylindrical — screen-width) ===
        this.renderBoom(td);

        // === 8. Sheet blocks/winches — bottom cheek (below ropes) ===
        this.renderBlocksPass(td, false);

        // === 9. Standing rigging (wires — screen-width) ===
        this.renderStandingRigging(td);

        // === 10. Lifeline stanchions (tubes — screen-width) ===
        this.renderStanchions(td);

        // === 11. Lifeline pulpits and wires (screen-width) ===
        this.renderLifelineWires(td);

        // === 12. Mast (cylindrical — screen-width, tallest, drawn last) ===
        this.renderMast(td);
      },
    );

    // === 13. Sheets/ropes — rendered in world space (outside draw.at) ===
    // Sheet rope endpoints come from the cloth sim which includes tilt parallax,
    // matching the sail rendering. Rendering through the hull model matrix would
    // double-count the tilt.
    const renderer = draw.renderer;
    renderer.flush();
    profiler.start("rope.render.draw");
    this.renderSheet(renderer, this.boat.mainsheet, hullBody);
    if (this.boat.portJibSheet) {
      this.renderSheet(renderer, this.boat.portJibSheet, hullBody);
    }
    if (this.boat.starboardJibSheet) {
      this.renderSheet(renderer, this.boat.starboardJibSheet, hullBody);
    }
    this.renderSheet(renderer, this.boat.mainHalyard, hullBody);

    // === 14. Anchor rode ===
    this.renderRode(renderer);
    profiler.end("rope.render.draw");

    // === 15. Sheet blocks/winches — top cheek + handles (above ropes) ===
    renderer.flush();
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
        const td = new TiltDraw(draw.renderer, tilt);
        this.renderBlocksPass(td, true);
      },
    );

    // Bilge water and hull silhouette masking are handled by
    // BoatWaterStampShader in the surface-rendering pass, which stamps
    // water heights directly into waterHeightTexture. The water filter
    // then renders both uniformly with the same physically-based model
    // it uses for the ocean.
  }

  private renderRudder(td: TiltDraw) {
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
    td.mesh({
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
    });

    // Blade top edge — screen-width line so blade has visible thickness from above
    td.line(
      pivot.x,
      pivot.y,
      bladeTopZ,
      trailingX,
      trailingY,
      bladeTopZ,
      0.2,
      rudderColor,
      1,
      true,
    );

    // Rudder stock — vertical shaft from deck down through hull to blade
    td.line(
      pivot.x,
      pivot.y,
      deckZ,
      pivot.x,
      pivot.y,
      rudderZ,
      stockWidth,
      rudderColor,
      1,
      true,
    );
  }

  private renderHelm(td: TiltDraw) {
    if (this.config.helm?.type === "wheel") {
      this.renderWheel(td);
    } else {
      this.renderTiller(td);
    }
  }

  private renderTiller(td: TiltDraw) {
    const rudder = this.boat.rudder;
    const tillerAngle = rudder.getTillerAngleOffset();
    const basePos = this.config.helm?.position ?? rudder.getPosition();
    const deckZ = this.config.hull.deckHeight;

    const cos = Math.cos(tillerAngle);
    const sin = Math.sin(tillerAngle);
    const tipX = basePos.x + 3 * cos;
    const tipY = basePos.y + 3 * sin;

    td.line(
      basePos.x,
      basePos.y,
      deckZ,
      tipX,
      tipY,
      deckZ,
      0.25,
      0x886633,
      1,
      true,
    );
  }

  private renderWheel(td: TiltDraw) {
    const helm = this.config.helm;
    if (!helm || helm.type !== "wheel" || !helm.position) return;
    const rudder = this.boat.rudder;
    const deckZ = this.config.hull.deckHeight;
    const radius = helm.radius ?? 1.5;
    const turns = helm.turns ?? 1;
    // The wheel rotates faster than the rudder: visually it turns through
    // `turns` revolutions while the rudder swings from center to full lock.
    const maxSteer = this.config.rudder.maxSteerAngle;
    const wheelAngle =
      rudder.getTillerAngleOffset() * turns * (Math.PI / maxSteer);
    const cx = helm.position.x;
    const cy = helm.position.y;
    // The wheel stands vertical on a pedestal, axis pointing fore-aft.
    // Its plane is Y-Z (port-starboard × up-down), so from above the rim
    // is a horizontal line port-starboard. Handles rotate in Y-Z and
    // appear as bumps extending past that line (when horizontal) or as
    // dots rising above the rim (when vertical).
    const axisZ = deckZ + radius + 0.3;
    const woodColor = this.boat.rig.getBoomColor();
    const handleColor = lighten(woodColor, 0.25);
    const hubColor = rudder.getColor();
    const numSpokes = 8;
    const rimSegments = 32;
    const innerR = radius * 0.85;
    const handleLength = radius * 0.3;
    const rimWidth = Math.max(0.15, radius * 0.18);
    const spokeWidth = Math.max(0.08, radius * 0.08);
    const handleWidth = Math.max(0.12, radius * 0.13);

    // Pedestal post — vertical from deck to wheel axis
    td.line(cx, cy, deckZ, cx, cy, axisZ, 0.35, 0x2a2a2a, 1, true);

    // Wheel rim — circle in Y-Z plane (all points at x = cx)
    const rimPts: [number, number][] = [];
    const rimZs: number[] = [];
    for (let i = 0; i <= rimSegments; i++) {
      const a = (i / rimSegments) * Math.PI * 2;
      rimPts.push([cx, cy + Math.cos(a) * radius]);
      rimZs.push(axisZ + Math.sin(a) * radius);
    }
    td.polyline(rimPts, rimZs, rimWidth, woodColor, 1, true, true);

    // Spokes (hub → inner rim) and handles (rim → tip) in Y-Z plane
    for (let i = 0; i < numSpokes; i++) {
      const a = wheelAngle + (i / numSpokes) * Math.PI * 2;
      const co = Math.cos(a);
      const si = Math.sin(a);
      const rimY = cy + co * innerR;
      const rimZ = axisZ + si * innerR;
      td.line(cx, cy, axisZ, cx, rimY, rimZ, spokeWidth, woodColor, 1, true);

      const handleBaseY = cy + co * radius;
      const handleBaseZ = axisZ + si * radius;
      const handleTipY = cy + co * (radius + handleLength);
      const handleTipZ = axisZ + si * (radius + handleLength);
      td.line(
        cx,
        handleBaseY,
        handleBaseZ,
        cx,
        handleTipY,
        handleTipZ,
        handleWidth,
        handleColor,
        1,
        true,
      );
    }

    // Hub — short horizontal axle pointing fore-aft (visible from above as a
    // short line along X, centered on the wheel axis)
    const hubHalfLen = radius * 0.15;
    td.line(
      cx - hubHalfLen,
      cy,
      axisZ,
      cx + hubHalfLen,
      cy,
      axisZ,
      Math.max(0.2, radius * 0.22),
      hubColor,
      1,
      true,
    );
  }

  private renderBoom(td: TiltDraw) {
    const rig = this.boat.rig;
    const boomRelAngle = rig.getBoomRelativeYaw();
    const mastPos = rig.getMastPosition();
    const boomLength = rig.getBoomLength();
    const boomZ = rig.getBoomZ();

    const cos = Math.cos(boomRelAngle);
    const sin = Math.sin(boomRelAngle);
    const endX = mastPos.x - boomLength * cos;
    const endY = mastPos.y - boomLength * sin;

    td.line(
      mastPos.x,
      mastPos.y,
      boomZ,
      endX,
      endY,
      boomZ,
      rig.getBoomWidth(),
      rig.getBoomColor(),
      1,
      true,
    );
  }

  // Blocks and winches are rendered as two circles: a bottom cheek drawn
  // before the ropes and a top cheek drawn after, so the rope visually
  // passes through the hardware. Winches also get a handle on top.
  // The rope has a small depth bias; the top cheek clears it by sitting
  // ~0.3 ft above the rope anchor plane, and the bottom cheek sits at the
  // anchor plane so the rope wins against it.
  private renderBlocksPass(td: TiltDraw, above: boolean) {
    const hullBody = this.boat.hull.body;
    const winchRadius = 0.3;
    const topCheekZ = 0.3;
    const handleZ = 0.42;
    const sheets = [
      this.boat.mainsheet,
      this.boat.portJibSheet,
      this.boat.starboardJibSheet,
    ];
    for (const sheet of sheets) {
      if (!sheet) continue;
      for (const wp of sheet.getWaypointInfo()) {
        const [wx, wy, wz] = wp.position;
        const local = hullBody.toLocalFrame3D(wx, wy, wz);
        const anchorZ = local[2];
        if (!above) {
          td.flatCircle(local[0], local[1], anchorZ, winchRadius, 32, 0x333333);
        } else {
          td.flatCircle(
            local[0],
            local[1],
            anchorZ + topCheekZ,
            winchRadius,
            32,
            0x555555,
          );
          if (wp.type === "winch") {
            const handleLen = winchRadius * 1.6;
            const cos = Math.cos(wp.winchAngle);
            const sin = Math.sin(wp.winchAngle);
            td.line(
              local[0],
              local[1],
              anchorZ + handleZ,
              local[0] + cos * handleLen,
              local[1] + sin * handleLen,
              anchorZ + handleZ,
              0.12,
              0x777777,
              1,
              true,
            );
          }
        }
      }
    }
  }

  private renderStandingRigging(td: TiltDraw) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();
    const stays = rig.getStays();

    // The forestay attaches to the top of the roller furler on the bowsprit,
    // not the deck — use the jib's zFoot so the furled jib lies on the stay.
    const forestayZ = this.config.jib?.zFoot ?? stays.deckHeight;

    for (const [attach, bottomZ] of [
      [stays.forestay, forestayZ],
      [stays.portShroud, stays.deckHeight],
      [stays.starboardShroud, stays.deckHeight],
    ] as const) {
      td.line(
        mastPos.x,
        mastPos.y,
        mastTopZ,
        attach.x,
        attach.y,
        bottomZ,
        0.1,
        0x999999,
      );
    }

    const bridle = stays.backstay;
    td.line(
      mastPos.x,
      mastPos.y,
      mastTopZ,
      bridle.split.x,
      bridle.split.y,
      bridle.splitZ,
      0.1,
      0x999999,
    );
    for (const corner of [bridle.port, bridle.starboard] as const) {
      td.line(
        bridle.split.x,
        bridle.split.y,
        bridle.splitZ,
        corner.x,
        corner.y,
        stays.deckHeight,
        0.1,
        0x999999,
      );
    }
  }

  private renderStanchions(td: TiltDraw) {
    const lifelineConfig = this.config.lifelines;
    if (!lifelineConfig) return;

    const deckZ = this.config.hull.deckHeight;
    const topZ = deckZ + lifelineConfig.stanchionHeight;

    for (const [sx, sy] of [
      ...lifelineConfig.portStanchions,
      ...lifelineConfig.starboardStanchions,
    ]) {
      td.line(
        sx,
        sy,
        deckZ,
        sx,
        sy,
        topZ,
        lifelineConfig.tubeWidth,
        lifelineConfig.tubeColor,
        1,
        true,
      );
    }
  }

  private renderLifelineWires(td: TiltDraw) {
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
      td.polyline(
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tubeColor,
        1,
        false,
        true,
      );
      this.renderPulpitPosts(
        td,
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
      td.polyline(
        rounded.points,
        rounded.zValues,
        tubeWidth,
        tubeColor,
        1,
        false,
        true,
      );
      this.renderPulpitPosts(
        td,
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
        // Wires thread through eyes ~½ inch below the stanchion caps
        const wireZ = topZ - 0.5 / 12;
        td.polyline(
          points,
          points.map(() => wireZ),
          wireWidth,
          wireColor,
        );
      }
    }
  }

  private renderPulpitPosts(
    td: TiltDraw,
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

      td.line(px, py, deckZ, px, py, topZ, tubeWidth, tubeColor, 1, true);
    }
  }

  /** Subdivisions per segment for Catmull-Rom rope smoothing. */
  private static readonly ROPE_SUBDIVISIONS = 5;

  /** Per-sheet smoothing scratch buffers and shader instance. */
  private ropeRenderState = new Map<
    RopeVisual,
    {
      shader: RopeShaderInstance;
      smoothPoints: [number, number][];
      smoothZ: number[];
      rawV: number[];
      smoothV: number[];
      rawCount: number;
    }
  >();

  private getRopeRenderState(rawPointCount: number, sheet: RopeVisual) {
    let state = this.ropeRenderState.get(sheet);
    if (!state || state.rawCount !== rawPointCount) {
      const smoothCount = catmullRomOutputCount(
        rawPointCount,
        BoatRenderer.ROPE_SUBDIVISIONS,
      );
      state = {
        shader: new RopeShaderInstance(smoothCount),
        smoothPoints: Array.from(
          { length: smoothCount },
          () => [0, 0] as [number, number],
        ),
        smoothZ: new Array(smoothCount).fill(0),
        rawV: new Array(rawPointCount).fill(0),
        smoothV: new Array(smoothCount).fill(0),
        rawCount: rawPointCount,
      };
      this.ropeRenderState.set(sheet, state);
    }
    return state;
  }

  private renderSheet(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
    sheet: RopeVisual,
    hullBody: import("../../core/physics/body/Body").Body,
  ) {
    const opacity = sheet.getOpacity();
    if (opacity <= 0) return;

    const {
      points: rawPoints,
      z: rawZ,
      vPerPoint,
    } = sheet.getRopePointsWithZ();
    if (rawPoints.length < 2) return;

    const state = this.getRopeRenderState(rawPoints.length, sheet);

    // Use the material-v coordinates supplied by the rope's render layer;
    // spacing is non-uniform (sections can differ in length).
    for (let i = 0; i < rawPoints.length; i++) {
      state.rawV[i] = vPerPoint[i];
    }

    // Smooth the physics points with Catmull-Rom interpolation
    const smoothCount = subdivideCatmullRom(
      rawPoints,
      rawZ,
      BoatRenderer.ROPE_SUBDIVISIONS,
      state.smoothPoints,
      state.smoothZ,
      state.rawV,
      state.smoothV,
    );

    const width = sheet.getRopeThickness();
    const cam = extractCameraTransform(renderer.getTransform());

    // Compute world-space z-slope from the hull's deck normal so the rope
    // strip tilts with the deck when heeled. Without this, one edge of the
    // strip clips through the tilted deck surface.
    const R = hullBody.orientation;
    const nz = R[8]; // deck normal z-component (cos of combined tilt)
    const zSlope =
      Math.abs(nz) > 0.01
        ? { dx: -R[2] / nz, dy: -R[5] / nz }
        : { dx: 0, dy: 0 };

    const { vertexCount, indexCount } = tessellateRopeStrip(
      state.smoothPoints,
      state.smoothZ,
      width,
      cam,
      state.shader.scratchVertexData,
      state.shader.scratchIndexData,
      smoothCount,
      zSlope,
      state.smoothV,
    );

    if (vertexCount === 0) return;

    state.shader.draw(
      renderer,
      state.shader.scratchVertexData,
      vertexCount,
      state.shader.scratchIndexData,
      indexCount,
      sheet.getRopePattern(),
      opacity,
      width,
      this.game.entities.tryGetSingleton(TimeOfDay) ?? null,
    );
  }

  /** Rode render state (lazy-created). */
  private rodeState: {
    shader: RopeShaderInstance;
    smoothPoints: [number, number][];
    smoothZ: number[];
    rawV: number[];
    smoothV: number[];
    rawCount: number;
  } | null = null;

  private renderRode(
    renderer: import("../../core/graphics/webgpu/WebGPURenderer").WebGPURenderer,
  ) {
    const rodeData = this.boat.anchor.getRodePointsWithZ();
    if (!rodeData) return;
    const { points: rawPoints, z: rawZ, vPerPoint } = rodeData;
    if (rawPoints.length < 2) return;

    // Lazy-create or recreate if point count changed
    if (!this.rodeState || this.rodeState.rawCount !== rawPoints.length) {
      const smoothCount = catmullRomOutputCount(
        rawPoints.length,
        BoatRenderer.ROPE_SUBDIVISIONS,
      );
      this.rodeState = {
        shader: new RopeShaderInstance(smoothCount),
        smoothPoints: Array.from(
          { length: smoothCount },
          () => [0, 0] as [number, number],
        ),
        smoothZ: new Array(smoothCount).fill(0),
        rawV: new Array(rawPoints.length).fill(0),
        smoothV: new Array(smoothCount).fill(0),
        rawCount: rawPoints.length,
      };
    }

    // Copy supplied variable-spaced material-v coordinates into the scratch
    // buffer consumed by subdivideCatmullRom.
    for (let i = 0; i < rawPoints.length; i++) {
      this.rodeState.rawV[i] = vPerPoint[i];
    }

    const smoothCount = subdivideCatmullRom(
      rawPoints,
      rawZ,
      BoatRenderer.ROPE_SUBDIVISIONS,
      this.rodeState.smoothPoints,
      this.rodeState.smoothZ,
      this.rodeState.rawV,
      this.rodeState.smoothV,
    );

    const width = this.boat.anchor.getRodeThickness();
    const cam = extractCameraTransform(renderer.getTransform());

    const { vertexCount, indexCount } = tessellateRopeStrip(
      this.rodeState.smoothPoints,
      this.rodeState.smoothZ,
      width,
      cam,
      this.rodeState.shader.scratchVertexData,
      this.rodeState.shader.scratchIndexData,
      smoothCount,
      undefined,
      this.rodeState.smoothV,
    );

    if (vertexCount === 0) return;

    this.rodeState.shader.draw(
      renderer,
      this.rodeState.shader.scratchVertexData,
      vertexCount,
      this.rodeState.shader.scratchIndexData,
      indexCount,
      this.boat.anchor.getRodePattern(),
      1,
      width,
      this.game.entities.tryGetSingleton(TimeOfDay) ?? null,
    );
  }

  private renderMast(td: TiltDraw) {
    const rig = this.boat.rig;
    const mastPos = rig.getMastPosition();
    const mastTopZ = rig.getMastTopZ();
    const mastColor = rig.getMastColor();

    // The physical masthead extends a bit above the sail's fully-hoisted
    // position so the halyard sheave can sit at the very top. Derive that
    // height from the halyard config rather than duplicating the offset.
    const sheaveOffset = this.config.halyard.sheaveOffset;
    const sheaveDX = sheaveOffset?.x ?? 0;
    const sheaveDY = sheaveOffset?.y ?? 0;
    const sheaveElevation = this.config.halyard.sheaveElevation ?? 0;
    const sheaveRadius = this.config.halyard.sheaveRadius ?? 0.12;
    const mastShaftTopZ = mastTopZ + sheaveElevation;

    // Mast shaft (cylindrical — screen-width, with round caps)
    td.line(
      mastPos.x,
      mastPos.y,
      0,
      mastPos.x,
      mastPos.y,
      mastShaftTopZ,
      0.4,
      mastColor,
      1,
      true,
    );

    // Boom connection cap
    td.circle(mastPos.x, mastPos.y, rig.getBoomZ() + 0.01, 0.2, 16, mastColor);

    // Masthead sheave — small disc at the halyard block so the pulley
    // reads as hardware rather than a bare rope bend.
    td.circle(
      mastPos.x + sheaveDX,
      mastPos.y + sheaveDY,
      mastShaftTopZ + 0.01,
      sheaveRadius,
      12,
      lighten(mastColor, 0.25),
    );
  }
}
