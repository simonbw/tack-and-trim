import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { Circle } from "../../core/physics/shapes/Circle";
import { V, V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { Rope, RopeWaypoint } from "../rope/Rope";
import { AnchorConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { LBF_TO_ENGINE } from "../physics-constants";
import { type MeshContribution, tessellateLineToQuad } from "./tessellation";

// Z-axis physics constants
const ANCHOR_NET_GRAVITY = 28; // ft/s² (gravity × 0.87 after buoyancy for iron)
const ANCHOR_Z_DRAG = 3.0; // Water drag coefficient for anchor body (1/s)

// Rode particle physics
const RODE_PARTICLES_PER_FOOT = 1.0;
const RODE_MASS_PER_FOOT = 0.15; // lbs/ft (chain in water)
const RODE_GRAVITY = 15; // ft/s² (chain in water, buoyancy-reduced)
const RODE_DRAG = 5; // Water drag on rode particles (1/s)
const RODE_FLOOR_FRICTION = 0.8; // Friction damping when particle rests on bottom

// Rode rendering
const RODE_THICKNESS = 0.15; // ft (~2 inches)
const RODE_COLOR = 0x333322; // Dark rope color

// Winch force for hoisting the anchor
const HOIST_FORCE = 15; // lbf

// Anchor shape constants
const ANCHOR_COLOR = 0x333333;
const ANCHOR_SHAPE_LINE_WIDTH_RATIO = 0.12;

// Anchor geometry
const ANCHOR_CG_RATIO = 0.55;
const ANCHOR_ANGULAR_DRAG = 8;
const ANCHOR_GROUND_KICK = 0.5;

export class Anchor extends BaseEntity {
  layer = "boat" as const;

  private anchorBody!: DynamicBody;
  private rode: Rope | null = null;
  private winchIndex: number = -1;

  private onBottom: boolean = false;
  private anchorPitch: number = -Math.PI / 2;
  private anchorPitchVelocity: number = 0;

  // World queries at rode particle positions + anchor
  private terrainQuery: TerrainQuery | null = null;
  private waterQuery: WaterQuery | null = null;
  private queryPoints: V2d[] = [];

  // Config values
  private bowAttachPoint: V2d;
  private maxRodeLength: number;
  private anchorSize: number;
  private anchorMass: number;
  private anchorDragCoefficient: number;

  // Anchor geometry (derived from anchorSize)
  private anchorLen: number;
  private d_cg: number;
  private ringLocalX: number;

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

    this.anchorLen = config.anchorSize * 1.55;
    this.d_cg = this.anchorLen * ANCHOR_CG_RATIO;
    this.ringLocalX = this.d_cg;
  }

  @on("add")
  onAdd(): void {
    const bowWorld = this.getBowWorldPosition();

    // Create anchor body — always exists, starts at the bow
    this.anchorBody = new DynamicBody({
      mass: this.anchorMass,
      position: [bowWorld.x, bowWorld.y],
      angle: this.hull.body.angle,
      damping: 0.5,
      angularDamping: 0.95,
      allowSleep: false,
      sixDOF: {
        rollInertia: 1e6,
        pitchInertia: 1e6,
        zMass: this.anchorMass,
        zDamping: 0,
        rollPitchDamping: 0,
        zPosition: 0,
      },
    });
    this.anchorBody.addShape(new Circle({ radius: this.anchorSize * 0.5 }));

    // Derive particle count and mass from rode length
    const particleCount = Math.max(
      4,
      Math.round(this.maxRodeLength * RODE_PARTICLES_PER_FOOT),
    );
    const particleMass =
      (this.maxRodeLength * RODE_MASS_PER_FOOT) / particleCount;

    // Bow roller: block at the bow that redirects the rode from vertical
    // (going down to the anchor) to horizontal (running aft to the winch).
    // Winch sits a few feet aft on the foredeck.
    // Tail extends further aft (where the rode coils on deck).
    const winchPoint = V(this.bowAttachPoint.x - 3, 0);
    const tailPoint = V(this.bowAttachPoint.x - 8, 0);

    const bowRoller: RopeWaypoint = {
      body: this.hull.body,
      localAnchor: this.bowAttachPoint,
      z: 0,
      type: "block",
    };

    const winchWaypoint: RopeWaypoint = {
      body: this.hull.body,
      localAnchor: winchPoint,
      z: 0,
      type: "winch",
    };

    // Rode: anchor → bow roller (block) → winch on deck → tail (free end aft)
    this.rode = new Rope(
      this.anchorBody,
      [this.ringLocalX, 0, 0],
      this.hull.body,
      [tailPoint.x, tailPoint.y, 0],
      this.maxRodeLength,
      {
        particleCount,
        particleMass,
        damping: 0, // We apply drag as explicit underwater forces
      },
      [bowRoller, winchWaypoint],
    );

    this.winchIndex = this.rode.findWinch();

    // Register bodies and constraints with entity system
    this.bodies = [this.anchorBody, ...this.rode.getParticles()];
    this.constraints = [...this.rode.getAllConstraints()];

    // Query points: rode particles + anchor body
    const particles = this.rode.getParticles();
    this.queryPoints = [];
    for (let i = 0; i < particles.length + 1; i++) {
      this.queryPoints.push(V(0, 0));
    }

    this.terrainQuery = this.addChild(new TerrainQuery(() => this.queryPoints));
    this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
  }

  // ---- Winch controls (called by PlayerBoatController) ----

  /** Release the winch — rode pays out freely under anchor weight. */
  lower(): void {
    if (this.winchIndex < 0) return;
    this.rode!.setWinchMode(this.winchIndex, "free");
  }

  /** Engage ratchet + apply tailing force to hoist the anchor. */
  raise(): void {
    if (this.winchIndex < 0) return;
    this.rode!.setWinchMode(this.winchIndex, "ratchet");

    // Tail direction: aft along the hull (toward the helm)
    const angle = this.hull.body.angle;
    const aftX = -Math.cos(angle);
    const aftY = -Math.sin(angle);
    this.rode!.applyWinchForce(
      this.winchIndex,
      HOIST_FORCE * LBF_TO_ENGINE,
      aftX,
      aftY,
    );
  }

  /** Lock the rode in place (ratchet, no force). */
  idle(): void {
    if (this.winchIndex < 0) return;
    this.rode!.setWinchMode(this.winchIndex, "ratchet");
  }

  // ---- Public accessors ----

  isDeployed(): boolean {
    // "Deployed" = anchor is below the waterline
    return this.anchorBody != null && this.anchorBody.z < -1;
  }

  /** Get rode points for rendering by BoatRenderer. */
  getRodePointsWithZ(): {
    points: [number, number][];
    z: number[];
  } | null {
    return this.rode?.getPointsWithZ() ?? null;
  }

  getRodeThickness(): number {
    return RODE_THICKNESS;
  }

  getRodeColor(): number {
    return RODE_COLOR;
  }

  // ---- Per-tick physics ----

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (!this.rode) return;

    this.rode.tick(dt);

    // Update query points from particle positions
    this.updateQueryPoints();

    // Apply underwater forces on rode particles and anchor
    this.applyRodeForces();

    // Anchor pitch dynamics
    this.updatePitch(dt);

    // XY drag on the anchor body (scope-dependent holding power)
    this.applyAnchorDrag();
  }

  private updateQueryPoints(): void {
    const particles = this.rode!.getParticles();
    for (let i = 0; i < particles.length; i++) {
      const [px, py] = particles[i].position;
      this.queryPoints[i].set(px, py);
    }
    // Last query point is the anchor
    this.queryPoints[particles.length].set(
      this.anchorBody.position[0],
      this.anchorBody.position[1],
    );
  }

  private applyRodeForces(): void {
    const particles = this.rode!.getParticles();
    const particleMass =
      (this.maxRodeLength * RODE_MASS_PER_FOOT) / particles.length;

    for (let i = 0; i < particles.length; i++) {
      this.applyUnderwaterForces(
        particles[i],
        particleMass,
        RODE_GRAVITY,
        RODE_DRAG,
        i,
      );
    }

    // Anchor body
    this.applyUnderwaterForces(
      this.anchorBody,
      this.anchorMass,
      ANCHOR_NET_GRAVITY,
      ANCHOR_Z_DRAG,
      particles.length,
    );
  }

  private applyUnderwaterForces(
    body: DynamicBody,
    mass: number,
    gravity: number,
    drag: number,
    queryIdx: number,
  ): void {
    // Gravity (buoyancy-reduced)
    body.applyForce3D(0, 0, -gravity * mass, 0, 0, 0);

    // Water drag
    const [vx, vy] = body.velocity;
    const vz = body.zVelocity;
    body.applyForce3D(
      -drag * vx * mass,
      -drag * vy * mass,
      -drag * vz * mass,
      0,
      0,
      0,
    );

    // Floor collision
    if (
      this.terrainQuery &&
      queryIdx < this.terrainQuery.length &&
      this.waterQuery &&
      queryIdx < this.waterQuery.length
    ) {
      const terrainHeight = this.terrainQuery.get(queryIdx).height;
      const surfaceHeight = this.waterQuery.get(queryIdx).surfaceHeight;
      const floorZ = terrainHeight - surfaceHeight;

      if (body.z < floorZ) {
        body.z = floorZ;
        if (body.zVelocity < 0) body.zVelocity = 0;
        body.velocity.imul(1 - RODE_FLOOR_FRICTION);
      }
    }
  }

  private applyAnchorDrag(): void {
    const velocity = this.anchorBody.velocity;
    const speed = velocity.magnitude;
    if (speed < 0.01) return;

    // Scope-based drag: more rode out = better holding
    const workingLength =
      this.winchIndex >= 0 ? this.rode!.getWorkingLength(this.winchIndex) : 0;
    const scope = workingLength / this.maxRodeLength;
    let dragMagnitude = this.anchorDragCoefficient * scope * speed;

    // Bottom rode bonus: extra holding when rode lies on the bottom
    const anchorQueryIdx = this.rode!.getParticles().length;
    if (
      this.onBottom &&
      this.waterQuery &&
      this.waterQuery.length > anchorQueryIdx
    ) {
      const waterDepth = this.waterQuery.get(anchorQueryIdx).depth;
      const bottomRodeLength = Math.max(0, workingLength - waterDepth * 1.5);
      const scopeBonus = bottomRodeLength / this.maxRodeLength;
      dragMagnitude *= 1 + scopeBonus * 2;
    }

    const dragForce = velocity.normalize().imul(-dragMagnitude);
    this.anchorBody.applyForce(dragForce);
  }

  private updatePitch(dt: number): void {
    const I = (this.anchorLen * this.anchorLen) / 3;
    const d_cgToFlukes = this.anchorLen - this.d_cg;
    const anchorZ = this.anchorBody.z;

    // Detect bottom contact
    const anchorQueryIdx = this.rode!.getParticles().length;
    if (
      this.terrainQuery &&
      this.terrainQuery.length > anchorQueryIdx &&
      this.waterQuery &&
      this.waterQuery.length > anchorQueryIdx
    ) {
      const terrainHeight = this.terrainQuery.get(anchorQueryIdx).height;
      const surfaceHeight = this.waterQuery.get(anchorQueryIdx).surfaceHeight;
      const floorZ = terrainHeight - surfaceHeight;
      const wasOnBottom = this.onBottom;
      this.onBottom = anchorZ <= floorZ + 0.1;
      if (this.onBottom && !wasOnBottom) {
        this.anchorPitchVelocity += ANCHOR_GROUND_KICK;
      }
    }

    let angAccel = 0;

    // Rode pendulum — use the nearest rode particle to determine rope direction
    const particles = this.rode!.getParticles();
    if (particles.length > 0) {
      const lastParticle = particles[particles.length - 1];
      const dx = lastParticle.position[0] - this.anchorBody.position[0];
      const dy = lastParticle.position[1] - this.anchorBody.position[1];
      const dz = (lastParticle.z ?? 0) - anchorZ;
      const horizDist = Math.sqrt(dx * dx + dy * dy);
      const rodeAngle = Math.atan2(dz, horizDist);
      const dist3D = Math.sqrt(horizDist * horizDist + dz * dz);

      const linkLen = this.rode!.getChainLinkLength();
      const rodeTension = Math.max(
        0,
        Math.min(1, (dist3D - linkLen * 0.5) / (linkLen * 0.5)),
      );

      angAccel +=
        ((-ANCHOR_NET_GRAVITY * this.d_cg) / I) *
        Math.sin(rodeAngle + this.anchorPitch) *
        rodeTension;
    }

    // Ground tipping
    if (this.onBottom) {
      angAccel +=
        ((ANCHOR_NET_GRAVITY * d_cgToFlukes) / I) * Math.cos(this.anchorPitch);
    }

    // Angular drag
    angAccel -= ANCHOR_ANGULAR_DRAG * this.anchorPitchVelocity;

    this.anchorPitchVelocity += angAccel * dt;
    this.anchorPitch += this.anchorPitchVelocity * dt;
    this.anchorPitch = Math.max(-Math.PI / 2, Math.min(0, this.anchorPitch));
    if (this.anchorPitch <= -Math.PI / 2)
      this.anchorPitchVelocity = Math.max(0, this.anchorPitchVelocity);
    if (this.anchorPitch >= 0)
      this.anchorPitchVelocity = Math.min(0, this.anchorPitchVelocity);
  }

  // ---- Rendering ----

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }): void {
    this.renderDeployedAnchor(draw);
  }

  private toWorld3D(lx: number, ly: number): [number, number, number] {
    const angle = this.anchorBody.angle;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const cp = Math.cos(this.anchorPitch);
    const sp = Math.sin(this.anchorPitch);
    const [px, py] = this.anchorBody.position;
    const z = this.anchorBody.z;
    return [
      ca * cp * lx - sa * ly + px,
      sa * cp * lx + ca * ly + py,
      sp * lx + z,
    ];
  }

  private renderDeployedAnchor(
    draw: import("../../core/graphics/Draw").Draw,
  ): void {
    const size = this.anchorSize;
    const lineWidth = size * ANCHOR_SHAPE_LINE_WIDTH_RATIO;
    const foreshorten = Math.abs(Math.cos(this.anchorPitch));
    const thicknessBoost = 1 + (1 - foreshorten) * 2;
    const w = lineWidth * thicknessBoost;

    const ringEnd = this.d_cg;
    const flukeEnd = -(this.anchorLen - this.d_cg);

    const tw = (lx: number, ly: number): [number, number, number] =>
      this.toWorld3D(lx, ly);

    const [sx1, sy1, sz1] = tw(flukeEnd, 0);
    const [sx2, sy2, sz2] = tw(ringEnd, 0);
    this.submitMesh(
      draw,
      tessellateLineToQuad(sx1, sy1, sz1, sx2, sy2, sz2, w, ANCHOR_COLOR),
    );

    const stockX = ringEnd - size * 0.25;
    const stockHalf = size * 0.45;
    const [st1x, st1y, st1z] = tw(stockX, -stockHalf);
    const [st2x, st2y, st2z] = tw(stockX, stockHalf);
    this.submitMesh(
      draw,
      tessellateLineToQuad(st1x, st1y, st1z, st2x, st2y, st2z, w, ANCHOR_COLOR),
    );

    const crownHalf = size * 0.25;
    const [c1x, c1y, c1z] = tw(flukeEnd, -crownHalf);
    const [c2x, c2y, c2z] = tw(flukeEnd, crownHalf);
    this.submitMesh(
      draw,
      tessellateLineToQuad(c1x, c1y, c1z, c2x, c2y, c2z, w, ANCHOR_COLOR),
    );

    const flukeLen = size * 0.45;
    const flukeSpread = size * 0.15;
    const flukeEndX = flukeEnd + flukeSpread;
    const [lf1x, lf1y, lf1z] = tw(flukeEnd, -crownHalf);
    const [lf2x, lf2y, lf2z] = tw(flukeEndX, -crownHalf - flukeLen);
    this.submitMesh(
      draw,
      tessellateLineToQuad(lf1x, lf1y, lf1z, lf2x, lf2y, lf2z, w, ANCHOR_COLOR),
    );

    const [rf1x, rf1y, rf1z] = tw(flukeEnd, crownHalf);
    const [rf2x, rf2y, rf2z] = tw(flukeEndX, crownHalf + flukeLen);
    this.submitMesh(
      draw,
      tessellateLineToQuad(rf1x, rf1y, rf1z, rf2x, rf2y, rf2z, w, ANCHOR_COLOR),
    );

    const ringRadius = size * 0.15;
    const [rx, ry, rz] = tw(ringEnd + ringRadius, 0);
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
    if (this.terrainQuery) {
      this.terrainQuery.destroy();
      this.terrainQuery = null;
    }
    if (this.waterQuery) {
      this.waterQuery.destroy();
      this.waterQuery = null;
    }
  }
}
