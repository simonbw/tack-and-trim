import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { DynamicRigid3D } from "../../core/physics/body/bodyInterfaces";
import type { Body } from "../../core/physics/body/Body";
import { createRigid3D } from "../../core/physics/body/bodyFactories";
import { Circle } from "../../core/physics/shapes/Circle";
import { TerrainContactConstraint } from "../../core/physics/constraints/TerrainContactConstraint";
import { V, V2d } from "../../core/Vector";
import { V3d } from "../../core/Vector3";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { RopeBlock } from "../rope/RopeBlock";
import { RopeNetwork, type RopeNetworkNodeSpec } from "../rope/RopeNetwork";
import { RopeRender } from "../rope/RopeRender";
import { AnchorConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import type { RopePattern } from "./RopeShader";
import { type MeshContribution, tessellateLineToQuad } from "./tessellation";

// Z-axis physics constants
const ANCHOR_NET_GRAVITY = 28; // ft/s² (gravity × 0.87 after buoyancy for iron)
const ANCHOR_Z_DRAG = 3.0; // Water drag coefficient for anchor body (1/s)
const ANCHOR_ANGULAR_DRAG = 8; // Angular drag coefficient (1/s)

// Rode geometry
const RODE_DIAMETER = 0.03125; // ft (3/8" chain)
const RODE_FLOOR_FRICTION = 0.8; // Friction damping when anchor rests on bottom

// Rode rendering
const RODE_THICKNESS = 0.15; // ft (~2 inches)
const RODE_COLOR = 0x333322; // Dark rope color

// Winch trim speed for hoisting the anchor
const WINCH_MAX_SPEED = 2; // ft/s

// Anchor shape constants
const ANCHOR_COLOR = 0x333333;
const ANCHOR_SHAPE_LINE_WIDTH_RATIO = 0.12;

// Anchor geometry ratios
const ANCHOR_LENGTH_RATIO = 1.55; // anchorLen = anchorSize * this
const ANCHOR_CG_RATIO = 0.55; // CG distance from flukes / anchorLen

export class Anchor extends BaseEntity {
  layer = "boat" as const;

  private anchorBody!: Body & DynamicRigid3D;
  private rode: RopeNetwork | null = null;
  private rodeRender: RopeRender | null = null;
  private winch: RopeBlock | null = null;
  private blocks: RopeBlock[] = [];

  private onBottom: boolean = false;

  // Contact points on the anchor body for floor collision. Index 0 is the body
  // centre — used by scope-drag water-depth lookup. The rest cover the flukes,
  // crown, stock tips, and ring so the anchor settles on its shape instead of
  // burying parts of itself when the CG alone is above the seabed.
  private contactLocals: { x: number; y: number; z: number }[] = [];
  private contactQueryPoints: V2d[] = [];
  private contactConstraints: TerrainContactConstraint[] = [];
  private floorZCache: (number | null)[] = [];
  private anchorTerrainQuery: TerrainQuery | null = null;
  private anchorWaterQuery: WaterQuery | null = null;
  private contactWorld: V3d = new V3d(0, 0, 0);

  // Config values
  private bowAttachPoint: V2d;
  private maxRodeLength: number;
  private anchorSize: number;
  private anchorMass: number;
  private anchorDragCoefficient: number;
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

    this.anchorBody = createRigid3D({
      motion: "dynamic",
      mass: this.anchorMass,
      position: [bowWorld.x, bowWorld.y],
      angle: this.hull.body.angle,
      damping: 0.5,
      angularDamping: 0.95,
      allowSleep: false,
      rollInertia: this.rollInertia,
      pitchInertia: this.pitchInertia,
      zMass: this.anchorMass,
      zDamping: 0, // We apply drag as explicit underwater forces
      rollPitchDamping: 0,
      z: this.deckHeight,
    });
    this.anchorBody.addShape(
      new Circle({ radius: yawRadius, collisionGroup: 0, collisionMask: 0 }),
    );

    // Waypoints: bow roller (block) redirects rode from vertical to horizontal,
    // winch sits a few feet aft on foredeck, tail extends further aft
    const winchPoint = V(this.bowAttachPoint.x - 3, 0);
    const tailPoint = V(this.bowAttachPoint.x - 8, 0);

    const rodeAttach = new V3d(
      this.rodeAttachOffset[0],
      this.rodeAttachOffset[1],
      this.rodeAttachOffset[2],
    );
    const bowAnchor = new V3d(
      this.bowAttachPoint.x,
      this.bowAttachPoint.y,
      this.deckHeight,
    );
    const winchAnchor = new V3d(winchPoint.x, winchPoint.y, this.deckHeight);
    const tailAnchor = new V3d(tailPoint.x, tailPoint.y, this.deckHeight);

    // Nodes: [anchorBody, bowRoller (block), winch, tailAnchor (endpoint)]
    const nodeSpecs: RopeNetworkNodeSpec[] = [
      { body: this.anchorBody, localAnchor: rodeAttach, kind: "endpoint" },
      {
        body: this.hull.body,
        localAnchor: bowAnchor,
        kind: "block",
        mu: 0.1,
      },
      {
        body: this.hull.body,
        localAnchor: winchAnchor,
        kind: "winch",
        mu: 0.3,
      },
      { body: this.hull.body, localAnchor: tailAnchor, kind: "endpoint" },
    ];

    this.rode = this.addChild(
      new RopeNetwork(nodeSpecs, { totalLength: this.maxRodeLength }),
    );
    this.rodeRender = new RopeRender(this.rode, {
      hullBody: this.hull.body,
      // Anchor rode has no deck query hook plumbed in yet — the rode mostly
      // goes over the bow and into the water. Phase 3/4 can layer on a
      // water/terrain floor for the underwater sag if needed.
      ropeRadius: RODE_DIAMETER / 2,
    });

    this.bodies = [this.anchorBody];

    // Create block adapters so getWaypointInfo / winch controls work.
    const bowRoller = this.addChild(
      new RopeBlock(this.rode, this.hull.body, bowAnchor, {
        mode: "block",
        frictionCoefficient: 0.1,
      }),
    );
    this.blocks.push(bowRoller);

    const winch = this.addChild(
      new RopeBlock(this.rode, this.hull.body, winchAnchor, {
        mode: "winch",
        frictionCoefficient: 0.3,
      }),
    );
    this.blocks.push(winch);
    this.winch = winch;

    // Start fully retracted: minimal working length so the anchor sits at
    // the bow roller with nearly all the rode wound on the winch side.
    const bowToWinch = this.bowAttachPoint.distanceTo(winchPoint);
    winch.setWorkingLength(bowToWinch);

    // Contact points in anchor-local coords, matching the rendered geometry
    // so the anchor rests on its flukes/stock/crown instead of the body origin
    // punching through the seabed.
    const size = this.anchorSize;
    const flukeEnd = -(this.anchorLen - this.d_cg);
    const ringEnd = this.d_cg;
    const stockX = ringEnd - size * 0.25;
    const crownHalf = size * 0.25;
    const stockHalf = size * 0.45;
    const flukeLen = size * 0.45;
    const flukeSpread = size * 0.15;
    const flukeEndX = flukeEnd + flukeSpread;
    this.contactLocals = [
      { x: 0, y: 0, z: 0 }, // centre (water-depth sample for scope drag)
      { x: flukeEndX, y: -(crownHalf + flukeLen), z: 0 }, // port fluke tip
      { x: flukeEndX, y: crownHalf + flukeLen, z: 0 }, // starboard fluke tip
      { x: flukeEnd, y: -crownHalf, z: 0 }, // port crown
      { x: flukeEnd, y: crownHalf, z: 0 }, // starboard crown
      { x: stockX, y: -stockHalf, z: 0 }, // port stock tip
      { x: stockX, y: stockHalf, z: 0 }, // starboard stock tip
      { x: ringEnd, y: 0, z: 0 }, // ring end of shank
    ];
    this.contactQueryPoints = this.contactLocals.map(() => V(0, 0));
    this.floorZCache = new Array(this.contactLocals.length).fill(null);

    this.anchorTerrainQuery = this.addChild(
      new TerrainQuery(() => this.contactQueryPoints),
    );
    this.anchorWaterQuery = this.addChild(
      new WaterQuery(() => this.contactQueryPoints),
    );

    const ground = this.game!.ground;
    const contactConstraints: TerrainContactConstraint[] = [];
    for (let i = 0; i < this.contactLocals.length; i++) {
      const local = this.contactLocals[i];
      const idx = i;
      contactConstraints.push(
        new TerrainContactConstraint(
          ground,
          this.anchorBody,
          local.x,
          local.y,
          local.z,
          () => this.floorZCache[idx],
          RODE_FLOOR_FRICTION,
          { collideConnected: true },
        ),
      );
    }
    this.contactConstraints = contactConstraints;
    this.constraints = contactConstraints;
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
    this.winch.applyTrimRate(WINCH_MAX_SPEED);
  }

  /** Lock the rode in place (ratchet, no force). */
  idle(): void {
    if (!this.winch) return;
    this.winch.setMode("ratchet");
    this.winch.applyTrimRate(0);
  }

  // ---- Public accessors ----

  isDeployed(): boolean {
    return this.anchorBody != null && this.anchorBody.z < -1;
  }

  getRodePointsWithZ(): {
    points: [number, number][];
    z: number[];
    vPerPoint: number[];
  } | null {
    if (!this.rodeRender) return null;
    return this.rodeRender.computeSamples();
  }

  getRodeSegmentLength(): number {
    if (!this.rode) return 0;
    const n = this.rode.getNodeCount();
    if (n < 2) return 1;
    return this.rode.getTotalLength() / (n - 1);
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
    return this.blocks.map((b) => ({
      position: b.getWorldPosition(),
      type: b.type,
    }));
  }

  // ---- Per-tick physics ----

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (!this.rode) return;

    // Update anchor body query point
    this.updateQueryPoints();

    // Anchor body underwater forces: gravity + drag + floor collision
    this.applyAnchorUnderwaterForces();

    // Anchor-specific forces: gravity at CG offset, angular drag
    this.applyAnchorBodyForces();

    // XY drag on the anchor body (scope-dependent holding power)
    this.applyAnchorDrag();

    // Rode render liveness (catenary sag + decorative oscillator).
    this.rodeRender?.update(dt);
  }

  private updateQueryPoints(): void {
    const body = this.anchorBody;
    for (let i = 0; i < this.contactLocals.length; i++) {
      const local = this.contactLocals[i];
      const world = body.toWorldFrame3D(
        local.x,
        local.y,
        local.z,
        this.contactWorld,
      );
      this.contactQueryPoints[i].set(world[0], world[1]);
    }

    const terrainQuery = this.anchorTerrainQuery;
    const waterQuery = this.anchorWaterQuery;
    const tCount = terrainQuery?.length ?? 0;
    const wCount = waterQuery?.length ?? 0;
    const count = Math.min(tCount, wCount, this.contactLocals.length);
    for (let i = 0; i < count; i++) {
      const terrainHeight = terrainQuery!.get(i).height;
      const surfaceHeight = waterQuery!.get(i).surfaceHeight;
      this.floorZCache[i] = terrainHeight - surfaceHeight;
    }
    for (let i = count; i < this.floorZCache.length; i++) {
      this.floorZCache[i] = null;
    }
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

    // Any active contact constraint means a part of the anchor is touching
    // (or penetrating) the seabed — that's what the scope-drag holding-power
    // bonus cares about.
    let anyContact = false;
    for (let i = 0; i < this.contactConstraints.length; i++) {
      if (this.contactConstraints[i].isActive()) {
        anyContact = true;
        break;
      }
    }
    this.onBottom = anyContact;
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
