import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { Circle } from "../../core/physics/shapes/Circle";
import { V, V2d } from "../../core/Vector";
import { V3d } from "../../core/Vector3";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { TerrainFloorConstraint } from "../constraints/TerrainFloorConstraint";
import { Pulley } from "../rope/Pulley";
import { Rope, type RopePathHint } from "../rope/Rope";
import { AnchorConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import type { RopePattern } from "./RopeShader";
import { LBF_TO_ENGINE } from "../physics-constants";
import { type MeshContribution, tessellateLineToQuad } from "./tessellation";

// Z-axis physics constants
const ANCHOR_NET_GRAVITY = 28; // ft/s² (gravity × 0.87 after buoyancy for iron)
const ANCHOR_Z_DRAG = 3.0; // Water drag coefficient for anchor body (1/s)
const ANCHOR_ANGULAR_DRAG = 8; // Angular drag coefficient (1/s)

// Rode particle physics
const RODE_PARTICLES_PER_FOOT = 1.0;
const RODE_MASS_PER_FOOT = 0.15; // lbs/ft (chain in water)
const RODE_DIAMETER = 0.03125; // ft (3/8" chain)
const RODE_DRAG_CD = 1.2; // Cylinder cross-flow drag coefficient
const RODE_FLOOR_FRICTION = 0.8; // Friction damping when particle rests on bottom

// Rode rendering
const RODE_THICKNESS = 0.15; // ft (~2 inches)
const RODE_COLOR = 0x333322; // Dark rope color

// Default winch force for hoisting the anchor
const DEFAULT_HOIST_FORCE = 150; // lbf
const WINCH_MAX_SPEED = 2; // ft/s

// Anchor shape constants
const ANCHOR_COLOR = 0x333333;
const ANCHOR_SHAPE_LINE_WIDTH_RATIO = 0.12;

// Anchor geometry ratios
const ANCHOR_LENGTH_RATIO = 1.55; // anchorLen = anchorSize * this
const ANCHOR_CG_RATIO = 0.55; // CG distance from flukes / anchorLen

export class Anchor extends BaseEntity {
  layer = "boat" as const;

  private anchorBody!: DynamicBody;
  private rode: Rope | null = null;
  private winch: Pulley | null = null;
  private pulleys: Pulley[] = [];

  private onBottom: boolean = false;

  // World queries for anchor body only (rode queries are managed by Rope)
  private anchorTerrainQuery: TerrainQuery | null = null;
  private anchorWaterQuery: WaterQuery | null = null;
  private anchorQueryPoint: V2d[] = [];

  // Config values
  private bowAttachPoint: V2d;
  private maxRodeLength: number;
  private anchorSize: number;
  private anchorMass: number;
  private anchorDragCoefficient: number;
  private hoistForce: number;
  private ropePattern?: RopePattern;
  private rodeAttachOffset: readonly [number, number, number];
  private deckHeight: number;
  private rollInertia: number;
  private pitchInertia: number;
  private yawInertia: number;

  // Anchor geometry (derived from anchorSize)
  private anchorLen: number;
  private d_cg: number;

  constructor(
    private hull: Hull,
    config: AnchorConfig,
  ) {
    super();

    this.bowAttachPoint = config.bowAttachPoint;
    this.maxRodeLength = config.maxRodeLength;
    this.anchorSize = config.anchorSize;
    this.anchorMass = config.anchorMass;
    this.anchorDragCoefficient = config.anchorDragCoefficient;
    this.hoistForce = config.hoistForce ?? DEFAULT_HOIST_FORCE;
    this.ropePattern = config.ropePattern;
    this.rodeAttachOffset = config.rodeAttachOffset;
    this.deckHeight = config.deckHeight;
    this.rollInertia = config.rollInertia;
    this.pitchInertia = config.pitchInertia;
    this.yawInertia = config.yawInertia;

    this.anchorLen = config.anchorSize * ANCHOR_LENGTH_RATIO;
    this.d_cg = this.anchorLen * ANCHOR_CG_RATIO;
  }

  @on("add")
  onAdd(): void {
    const bowWorld = this.getBowWorldPosition();

    // Create anchor body — 6DOF with proper inertia on all axes
    // Yaw inertia comes from the Circle shape: I = 0.5 * m * r²
    // So r = sqrt(2 * I_yaw / m)
    const yawRadius = Math.sqrt((2 * this.yawInertia) / this.anchorMass);

    this.anchorBody = new DynamicBody({
      mass: this.anchorMass,
      position: [bowWorld.x, bowWorld.y],
      angle: this.hull.body.angle,
      damping: 0.5,
      angularDamping: 0.95,
      allowSleep: false,
      sixDOF: {
        rollInertia: this.rollInertia,
        pitchInertia: this.pitchInertia,
        zMass: this.anchorMass,
        zDamping: 0, // We apply drag as explicit underwater forces
        rollPitchDamping: 0,
        zPosition: this.deckHeight,
      },
    });
    this.anchorBody.addShape(
      new Circle({ radius: yawRadius, collisionGroup: 0, collisionMask: 0 }),
    );

    // Derive particle count and mass from rode length
    const particleCount = Math.max(
      4,
      Math.round(this.maxRodeLength * RODE_PARTICLES_PER_FOOT),
    );
    const particleMass =
      (this.maxRodeLength * RODE_MASS_PER_FOOT) / particleCount;

    // Waypoints: bow roller (block) redirects rode from vertical to horizontal,
    // winch sits a few feet aft on foredeck, tail extends further aft
    const winchPoint = V(this.bowAttachPoint.x - 3, 0);
    const tailPoint = V(this.bowAttachPoint.x - 8, 0);

    // Path hints for particle distribution (same positions as the pulleys)
    const pathHints: RopePathHint[] = [
      {
        body: this.hull.body,
        localAnchor: new V3d(
          this.bowAttachPoint.x,
          this.bowAttachPoint.y,
          this.deckHeight,
        ),
      },
      {
        body: this.hull.body,
        localAnchor: new V3d(winchPoint.x, winchPoint.y, this.deckHeight),
      },
    ];

    // Rode: anchor → bow roller (block) → winch on deck → tail (free end aft)
    this.rode = this.addChild(
      new Rope(
        this.anchorBody,
        new V3d(
          this.rodeAttachOffset[0],
          this.rodeAttachOffset[1],
          this.rodeAttachOffset[2],
        ),
        this.hull.body,
        new V3d(tailPoint.x, tailPoint.y, this.deckHeight),
        this.maxRodeLength,
        {
          particleCount,
          particleMass,
          damping: 0,
          drag: {
            waterDrag: true,
            ropeDiameter: RODE_DIAMETER,
            cdNormal: RODE_DRAG_CD,
          },
          terrainFloor: {
            floorFriction: RODE_FLOOR_FRICTION,
          },
        },
        pathHints,
      ),
    );

    this.bodies = [this.anchorBody];

    // Create pulleys: bow roller (block) and deck winch
    const bowRoller = this.addChild(
      new Pulley(
        this.rode,
        this.hull.body,
        new V3d(this.bowAttachPoint.x, this.bowAttachPoint.y, this.deckHeight),
        {
          mode: "block",
        },
      ),
    );
    this.pulleys.push(bowRoller);

    const winch = this.addChild(
      new Pulley(
        this.rode,
        this.hull.body,
        new V3d(winchPoint.x, winchPoint.y, this.deckHeight),
        { mode: "winch" },
      ),
    );
    this.pulleys.push(winch);
    this.winch = winch;

    // Anchor body terrain floor
    this.addChild(
      new TerrainFloorConstraint([this.anchorBody], {
        floorFriction: RODE_FLOOR_FRICTION,
      }),
    );

    // Anchor body queries — for bottom detection and scope drag
    this.anchorQueryPoint = [V(0, 0)];
    this.anchorTerrainQuery = this.addChild(
      new TerrainQuery(() => this.anchorQueryPoint),
    );
    this.anchorWaterQuery = this.addChild(
      new WaterQuery(() => this.anchorQueryPoint),
    );
  }

  // ---- Winch controls (called by PlayerBoatController) ----

  /** Release the winch — rode pays out freely under anchor weight. */
  lower(): void {
    if (!this.winch) return;
    this.winch.setMode("free");
  }

  /** Engage ratchet + apply tailing force to hoist the anchor. */
  raise(): void {
    if (!this.winch) return;
    this.winch.setMode("ratchet");

    // Tail direction: aft along the hull (toward the helm)
    const angle = this.hull.body.angle;
    const aftX = -Math.cos(angle);
    const aftY = -Math.sin(angle);
    this.winch.applyForce(
      this.hoistForce * LBF_TO_ENGINE,
      aftX,
      aftY,
      WINCH_MAX_SPEED,
    );
  }

  /** Lock the rode in place (ratchet, no force). */
  idle(): void {
    if (!this.winch) return;
    this.winch.setMode("ratchet");
  }

  // ---- Public accessors ----

  isDeployed(): boolean {
    return this.anchorBody != null && this.anchorBody.z < -1;
  }

  getRodePointsWithZ(): {
    points: [number, number][];
    z: number[];
  } | null {
    return this.rode?.getPointsWithZ() ?? null;
  }

  getRodeSegmentLength(): number {
    return this.rode?.getChainLinkLength() ?? 0;
  }

  getRodeThickness(): number {
    return RODE_THICKNESS;
  }

  getRodeColor(): number {
    return RODE_COLOR;
  }

  getRodePattern(): RopePattern {
    return this.ropePattern ?? { type: "laid", carriers: [RODE_COLOR] };
  }

  getWaypointInfo(): {
    position: [number, number, number];
    type: "block" | "winch";
  }[] {
    return this.pulleys.map((p) => ({
      position: p.getWorldPosition(),
      type: p.type,
    }));
  }

  // ---- Per-tick physics ----

  @on("tick")
  onTick(): void {
    if (!this.rode) return;

    // Update anchor body query point
    this.updateQueryPoints();

    // Anchor body underwater forces: gravity + drag + floor collision
    this.applyAnchorUnderwaterForces();

    // Anchor-specific forces: gravity at CG offset, angular drag
    this.applyAnchorBodyForces();

    // XY drag on the anchor body (scope-dependent holding power)
    this.applyAnchorDrag();
  }

  private updateQueryPoints(): void {
    this.anchorQueryPoint[0].set(
      this.anchorBody.position[0],
      this.anchorBody.position[1],
    );
  }

  /** Apply underwater forces to the anchor body: gravity and drag. */
  private applyAnchorUnderwaterForces(): void {
    // Gravity (buoyancy-reduced)
    this.anchorBody.applyForce3D(
      0,
      0,
      -ANCHOR_NET_GRAVITY * this.anchorMass,
      0,
      0,
      0,
    );

    // Water drag (linear)
    const [vx, vy] = this.anchorBody.velocity;
    const vz = this.anchorBody.zVelocity;
    this.anchorBody.applyForce3D(
      -ANCHOR_Z_DRAG * vx * this.anchorMass,
      -ANCHOR_Z_DRAG * vy * this.anchorMass,
      -ANCHOR_Z_DRAG * vz * this.anchorMass,
      0,
      0,
      0,
    );
  }

  private applyAnchorBodyForces(): void {
    // Shift the gravity application point from the origin (where
    // applyAnchorUnderwaterForces applies it) to the CG offset, creating
    // a righting torque that keeps the anchor oriented properly.
    const cgOffsetZ = -this.anchorSize * 0.15;
    // Cancel origin gravity, re-apply at CG offset
    this.anchorBody.applyForce3D(
      0,
      0,
      ANCHOR_NET_GRAVITY * this.anchorMass,
      0,
      0,
      0,
    );
    this.anchorBody.applyForce3D(
      0,
      0,
      -ANCHOR_NET_GRAVITY * this.anchorMass,
      0,
      0,
      cgOffsetZ,
    );

    // Angular drag on all rotation axes
    const av3 = this.anchorBody.angularVelocity3;
    if (av3) {
      this.anchorBody.angularForce3[0] -=
        ANCHOR_ANGULAR_DRAG * av3[0] * this.rollInertia;
      this.anchorBody.angularForce3[1] -=
        ANCHOR_ANGULAR_DRAG * av3[1] * this.pitchInertia;
      this.anchorBody.angularForce3[2] -=
        ANCHOR_ANGULAR_DRAG * av3[2] * this.yawInertia;
    }

    // Detect bottom contact
    if (
      this.anchorTerrainQuery &&
      this.anchorTerrainQuery.length > 0 &&
      this.anchorWaterQuery &&
      this.anchorWaterQuery.length > 0
    ) {
      const terrainHeight = this.anchorTerrainQuery.get(0).height;
      const surfaceHeight = this.anchorWaterQuery.get(0).surfaceHeight;
      const floorZ = terrainHeight - surfaceHeight;
      this.onBottom = this.anchorBody.z <= floorZ + 0.1;
    }
  }

  private applyAnchorDrag(): void {
    const velocity = this.anchorBody.velocity;
    const speed = velocity.magnitude;
    if (speed < 0.01) return;

    // Scope-based drag: more rode out = better holding
    const workingLength = this.winch ? this.winch.getWorkingLength() : 0;
    const scope = workingLength / this.maxRodeLength;
    let dragMagnitude = this.anchorDragCoefficient * scope * speed;

    // Bottom rode bonus: extra holding when rode lies on the bottom
    if (
      this.onBottom &&
      this.anchorWaterQuery &&
      this.anchorWaterQuery.length > 0
    ) {
      const waterDepth = this.anchorWaterQuery.get(0).depth;
      const bottomRodeLength = Math.max(0, workingLength - waterDepth * 1.5);
      const scopeBonus = bottomRodeLength / this.maxRodeLength;
      dragMagnitude *= 1 + scopeBonus * 2;
    }

    const dragForce = velocity.normalize().imul(-dragMagnitude);
    this.anchorBody.applyForce(dragForce);
  }

  // ---- Rendering ----

  @on("render")
  onRender({ draw }: GameEventMap["render"]): void {
    this.renderDeployedAnchor(draw);
  }

  private renderDeployedAnchor(
    draw: import("../../core/graphics/Draw").Draw,
  ): void {
    const size = this.anchorSize;
    const lineWidth = size * ANCHOR_SHAPE_LINE_WIDTH_RATIO;

    // Use the 6DOF body's pitch to determine foreshortening
    const pitch = this.anchorBody.pitch;
    const foreshorten = Math.abs(Math.cos(pitch));
    const thicknessBoost = 1 + (1 - foreshorten) * 2;
    const w = lineWidth * thicknessBoost;

    const ringEnd = this.d_cg;
    const flukeEnd = -(this.anchorLen - this.d_cg);

    // Use 6DOF body's toWorldFrame3D for all transforms
    const tw = (lx: number, ly: number, lz: number): [number, number, number] =>
      this.anchorBody.toWorldFrame3D(lx, ly, lz);

    // Shank (main vertical bar)
    const [sx1, sy1, sz1] = tw(flukeEnd, 0, 0);
    const [sx2, sy2, sz2] = tw(ringEnd, 0, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(sx1, sy1, sz1, sx2, sy2, sz2, w, ANCHOR_COLOR),
    );

    // Stock (crossbar near top)
    const stockX = ringEnd - size * 0.25;
    const stockHalf = size * 0.45;
    const [st1x, st1y, st1z] = tw(stockX, -stockHalf, 0);
    const [st2x, st2y, st2z] = tw(stockX, stockHalf, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(st1x, st1y, st1z, st2x, st2y, st2z, w, ANCHOR_COLOR),
    );

    // Crown (crossbar at bottom)
    const crownHalf = size * 0.25;
    const [c1x, c1y, c1z] = tw(flukeEnd, -crownHalf, 0);
    const [c2x, c2y, c2z] = tw(flukeEnd, crownHalf, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(c1x, c1y, c1z, c2x, c2y, c2z, w, ANCHOR_COLOR),
    );

    // Left fluke
    const flukeLen = size * 0.45;
    const flukeSpread = size * 0.15;
    const flukeEndX = flukeEnd + flukeSpread;
    const [lf1x, lf1y, lf1z] = tw(flukeEnd, -crownHalf, 0);
    const [lf2x, lf2y, lf2z] = tw(flukeEndX, -crownHalf - flukeLen, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(lf1x, lf1y, lf1z, lf2x, lf2y, lf2z, w, ANCHOR_COLOR),
    );

    // Right fluke
    const [rf1x, rf1y, rf1z] = tw(flukeEnd, crownHalf, 0);
    const [rf2x, rf2y, rf2z] = tw(flukeEndX, crownHalf + flukeLen, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(rf1x, rf1y, rf1z, rf2x, rf2y, rf2z, w, ANCHOR_COLOR),
    );

    // Ring at top
    const ringRadius = size * 0.15;
    const [rx, ry, rz] = tw(ringEnd + ringRadius, 0, 0);
    draw.fillCircle(rx, ry, ringRadius * thicknessBoost, {
      color: ANCHOR_COLOR,
      z: rz,
    });
  }

  private submitMesh(
    draw: import("../../core/graphics/Draw").Draw,
    mesh: MeshContribution,
  ): void {
    if (mesh.positions.length === 0) return;
    draw.renderer.submitTrianglesWithZ(
      mesh.positions,
      mesh.indices,
      mesh.color,
      mesh.alpha,
      mesh.zValues,
    );
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.hull.body.position;
    return this.bowAttachPoint.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  @on("destroy")
  onDestroy(): void {
    if (this.anchorTerrainQuery) {
      this.anchorTerrainQuery.destroy();
      this.anchorTerrainQuery = null;
    }
    if (this.anchorWaterQuery) {
      this.anchorWaterQuery.destroy();
      this.anchorWaterQuery = null;
    }
  }
}
