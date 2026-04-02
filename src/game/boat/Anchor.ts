import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { DynamicBody } from "../../core/physics/body/DynamicBody";
import { DistanceConstraint3D } from "../../core/physics/constraints/DistanceConstraint3D";
import { Circle } from "../../core/physics/shapes/Circle";
import { Particle } from "../../core/physics/shapes/Particle";
import { stepToward } from "../../core/util/MathUtil";
import { rDirection, rUniform } from "../../core/util/Random";
import { V, V2d } from "../../core/Vector";
import { SprayParticle } from "../SprayParticle";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import { AnchorSplashRipple } from "./AnchorSplashRipple";
import { AnchorConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import {
  type MeshContribution,
  subdivideSmooth,
  tessellateLineToQuad,
  tessellatePolylineToStrip,
} from "./tessellation";

type AnchorState = "stowed" | "deploying" | "deployed" | "retrieving";

// Splash effect configuration
const SPLASH_SPRAY_COUNT = 128;
const SPLASH_SPRAY_MIN_SIZE = 0.06; // ft
const SPLASH_SPRAY_MAX_SIZE = 0.2; // ft
const SPLASH_SPRAY_MIN_H_SPEED = 3; // ft/s
const SPLASH_SPRAY_MAX_H_SPEED = 30; // ft/s
const SPLASH_SPRAY_MIN_Z_VELOCITY = 2; // ft/s
const SPLASH_SPRAY_MAX_Z_VELOCITY = 60; // ft/s

const RODE_RETRIEVAL_THRESHOLD = 0.1; // ft

// Z-axis physics constants
const ANCHOR_NET_GRAVITY = 28; // ft/s² (gravity × 0.87 after buoyancy for iron)
const ANCHOR_Z_DRAG = 3.0; // Water drag coefficient for anchor body (1/s)

// Rode particle physics
const RODE_PARTICLE_COUNT = 20;
const RODE_MASS = 5; // Total rode mass (lbs) — chain/rope
const RODE_GRAVITY = 15; // ft/s² (chain in water, buoyancy-reduced)
const RODE_DRAG = 5; // Water drag on rode particles (1/s)
const RODE_FLOOR_FRICTION = 0.8; // Friction damping when particle rests on bottom

// Rode rendering
const RODE_THICKNESS = 0.15; // ft (~2 inches)
const RODE_COLOR = 0x333322; // Dark rope color
const RODE_SUBDIVISIONS = 3; // Bezier subdivisions for smooth rendering

// Anchor shape constants
const ANCHOR_COLOR = 0x333333;
const ANCHOR_SHAPE_LINE_WIDTH_RATIO = 0.12; // Line width relative to anchor size

// Anchor geometry
const ANCHOR_CG_RATIO = 0.55; // CG position along shank (0=ring, 1=flukes)
const ANCHOR_ANGULAR_DRAG = 8; // Rotational water drag (1/s)
const ANCHOR_GROUND_KICK = 0.5; // rad/s angular velocity kick when hitting bottom

export class Anchor extends BaseEntity {
  layer = "boat" as const;

  private anchorBody: DynamicBody | null = null;
  private state: AnchorState = "stowed";
  private anchorPosition: V2d = V(0, 0);

  // Rope length animation
  private currentRodeLength: number = 0;
  private targetRodeLength: number = 0;

  // Rode particle chain — physics bodies connected by 3D distance constraints
  private rodeParticles: DynamicBody[] = [];
  private rodeConstraints: DistanceConstraint3D[] = [];
  private rodeMassPerParticle: number;

  private onBottom: boolean = false;

  // Pitch tracked separately — the body handles z via 6DOF, but pitching to
  // ±π/2 causes gimbal lock in yaw extraction, so we track pitch manually.
  private anchorPitch: number = 0;
  private anchorPitchVelocity: number = 0;

  // World queries at all rode particle positions
  private terrainQuery: TerrainQuery | null = null;
  private waterQuery: WaterQuery | null = null;
  private ropeQueryPoints: V2d[];

  // Config values
  private bowAttachPoint: V2d;
  private maxRodeLength: number;
  private anchorSize: number;
  private rodeDeploySpeed: number;
  private rodeRetrieveSpeed: number;
  private anchorMass: number;
  private anchorDragCoefficient: number;

  // Anchor geometry
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
    this.rodeDeploySpeed = config.rodeDeploySpeed;
    this.rodeRetrieveSpeed = config.rodeRetrieveSpeed;
    this.anchorMass = config.anchorMass;
    this.anchorDragCoefficient = config.anchorDragCoefficient;

    this.anchorLen = config.anchorSize * 1.55;
    this.d_cg = this.anchorLen * ANCHOR_CG_RATIO;
    this.ringLocalX = this.d_cg;
    this.rodeMassPerParticle = RODE_MASS / RODE_PARTICLE_COUNT;

    // Preallocate query points for all rode particles + anchor
    this.ropeQueryPoints = [];
    for (let i = 0; i < RODE_PARTICLE_COUNT + 1; i++) {
      this.ropeQueryPoints.push(V(0, 0));
    }
  }

  isDeployed(): boolean {
    return this.state === "deployed" || this.state === "deploying";
  }

  getState(): AnchorState {
    return this.state;
  }

  deploy(): void {
    if (this.state !== "stowed") return;

    this.anchorPosition = this.getBowWorldPosition();
    const bowZ = this.getBowZ();

    // 6DOF anchor body — z is driven by forces (gravity, drag, floor collision)
    // just like the rode particles. Large roll/pitch inertia prevents solver-driven
    // pitch; we track pitch manually for the visual tilt.
    this.anchorBody = new DynamicBody({
      mass: this.anchorMass,
      position: [this.anchorPosition.x, this.anchorPosition.y],
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
    this.game.world.bodies.add(this.anchorBody);

    this.anchorPitch = -Math.PI / 2;
    this.anchorPitchVelocity = 0;
    this.onBottom = false;

    // Create rode particle chain
    this.createRodeChain(bowZ);

    this.currentRodeLength = 1;
    this.targetRodeLength = this.maxRodeLength;
    this.updateRodeConstraintLimits();

    // World queries at all particle positions + anchor
    this.terrainQuery = this.addChild(
      new TerrainQuery(() => this.ropeQueryPoints),
    );
    this.waterQuery = this.addChild(new WaterQuery(() => this.ropeQueryPoints));

    this.state = "deploying";
    this.spawnSplashEffects();
  }

  private createRodeChain(bowZ: number): void {
    const bowWorld = this.getBowWorldPosition();
    const [ringX, ringY, ringZ] = this.toWorld3D(this.ringLocalX, 0);

    // Create particles interpolated from bow to anchor ring
    for (let i = 0; i < RODE_PARTICLE_COUNT; i++) {
      const t = i / (RODE_PARTICLE_COUNT - 1);
      const px = bowWorld.x + (ringX - bowWorld.x) * t;
      const py = bowWorld.y + (ringY - bowWorld.y) * t;
      const pz = bowZ + (ringZ - bowZ) * t;

      const particle = new DynamicBody({
        mass: this.rodeMassPerParticle,
        position: [px, py],
        fixedRotation: true,
        damping: 0,
        allowSleep: false,
        sixDOF: {
          rollInertia: 1,
          pitchInertia: 1,
          zMass: this.rodeMassPerParticle,
          zDamping: 0, // We apply drag as explicit forces
          rollPitchDamping: 0,
          zPosition: pz,
        },
      });
      particle.addShape(new Particle());
      this.game.world.bodies.add(particle);
      this.rodeParticles.push(particle);
    }

    // Connect hull bow → first particle (pinned: distance 0)
    const bowToFirst = new DistanceConstraint3D(
      this.hull.body,
      this.rodeParticles[0],
      {
        localAnchorA: [this.bowAttachPoint.x, this.bowAttachPoint.y, 0],
        localAnchorB: [0, 0, 0],
        distance: 0,
      },
    );
    this.game.world.constraints.add(bowToFirst);
    this.rodeConstraints.push(bowToFirst);

    // Connect adjacent particles
    const segLen = this.currentRodeLength / (RODE_PARTICLE_COUNT - 1);
    for (let i = 0; i < RODE_PARTICLE_COUNT - 1; i++) {
      const c = new DistanceConstraint3D(
        this.rodeParticles[i],
        this.rodeParticles[i + 1],
        {
          localAnchorA: [0, 0, 0],
          localAnchorB: [0, 0, 0],
          distance: segLen,
        },
      );
      c.upperLimitEnabled = true;
      c.lowerLimitEnabled = false;
      c.upperLimit = segLen;
      this.game.world.constraints.add(c);
      this.rodeConstraints.push(c);
    }

    // Connect last particle → anchor ring
    const lastToAnchor = new DistanceConstraint3D(
      this.rodeParticles[RODE_PARTICLE_COUNT - 1],
      this.anchorBody!,
      {
        localAnchorA: [0, 0, 0],
        localAnchorB: [this.ringLocalX, 0, 0],
        distance: segLen,
      },
    );
    lastToAnchor.upperLimitEnabled = true;
    lastToAnchor.lowerLimitEnabled = false;
    lastToAnchor.upperLimit = segLen;
    this.game.world.constraints.add(lastToAnchor);
    this.rodeConstraints.push(lastToAnchor);
  }

  private updateRodeConstraintLimits(): void {
    const segLen = Math.max(
      0.1,
      this.currentRodeLength / (RODE_PARTICLE_COUNT - 1),
    );
    // Skip index 0 (bow→first particle, pinned at distance 0)
    for (let i = 1; i < this.rodeConstraints.length; i++) {
      this.rodeConstraints[i].upperLimit = segLen;
      this.rodeConstraints[i].distance = segLen;
    }
  }

  retrieve(): void {
    if (this.state !== "deployed" && this.state !== "deploying") return;
    this.targetRodeLength = 0;
    this.state = "retrieving";
  }

  private completeRetrieval(): void {
    this.cleanupRode();
    if (this.anchorBody) {
      this.game.world.bodies.remove(this.anchorBody);
      this.anchorBody = null;
    }
    this.destroyQueries();
    this.state = "stowed";
    this.currentRodeLength = 0;
  }

  private cleanupRode(): void {
    for (const c of this.rodeConstraints) {
      this.game.world.constraints.remove(c);
    }
    this.rodeConstraints.length = 0;
    for (const p of this.rodeParticles) {
      this.game.world.bodies.remove(p);
    }
    this.rodeParticles.length = 0;
  }

  toggle(): void {
    if (this.state === "stowed") {
      this.deploy();
    } else if (this.state === "deployed" || this.state === "deploying") {
      this.retrieve();
    }
  }

  private destroyQueries(): void {
    if (this.terrainQuery) {
      this.terrainQuery.destroy();
      this.terrainQuery = null;
    }
    if (this.waterQuery) {
      this.waterQuery.destroy();
      this.waterQuery = null;
    }
  }

  private getBowWorldPosition(): V2d {
    const [hx, hy] = this.hull.body.position;
    return this.bowAttachPoint.rotate(this.hull.body.angle).iadd([hx, hy]);
  }

  private getBowZ(): number {
    const hullZ = this.hull.body.z ?? 0;
    const pitch = this.hull.body.pitch ?? 0;
    return hullZ + this.bowAttachPoint.x * Math.sin(pitch);
  }

  private toWorld3D(lx: number, ly: number): [number, number, number] {
    const angle = this.anchorBody?.angle ?? 0;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const cp = Math.cos(this.anchorPitch);
    const sp = Math.sin(this.anchorPitch);
    const [px, py] = this.anchorBody?.position ?? [0, 0];
    const z = this.anchorBody?.z ?? 0;
    return [
      ca * cp * lx - sa * ly + px,
      sa * cp * lx + ca * ly + py,
      sp * lx + z,
    ];
  }

  private spawnSplashEffects(): void {
    this.game.addEntity(new AnchorSplashRipple(this.anchorPosition.clone()));
    for (let i = 0; i < SPLASH_SPRAY_COUNT; i++) {
      const angle = rDirection();
      const hSpeed = rUniform(
        SPLASH_SPRAY_MIN_H_SPEED,
        SPLASH_SPRAY_MAX_H_SPEED,
      );
      const velocity = V2d.fromPolar(hSpeed, angle);
      const zVelocity = rUniform(
        SPLASH_SPRAY_MIN_Z_VELOCITY,
        SPLASH_SPRAY_MAX_Z_VELOCITY,
      );
      const size = rUniform(SPLASH_SPRAY_MIN_SIZE, SPLASH_SPRAY_MAX_SIZE);
      const offset = V2d.fromPolar(rUniform(0, 0.5), angle);
      const spawnPos = this.anchorPosition.add(offset);
      this.game.addEntity(
        new SprayParticle(spawnPos, velocity, zVelocity, size),
      );
    }
  }

  /** Apply gravity, drag, and floor collision to a 6DOF body. */
  private applyUnderwaterForces(
    body: DynamicBody,
    mass: number,
    gravity: number,
    drag: number,
    queryIdx: number,
  ): void {
    // Gravity (buoyancy-reduced)
    body.applyForce3D(0, 0, -gravity * mass, 0, 0, 0);

    // Water drag (opposing velocity in all axes)
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

  /** Apply per-particle forces on rode and anchor. */
  private applyRodeForces(): void {
    for (let i = 0; i < this.rodeParticles.length; i++) {
      this.applyUnderwaterForces(
        this.rodeParticles[i],
        this.rodeMassPerParticle,
        RODE_GRAVITY,
        RODE_DRAG,
        i,
      );
    }

    // Same forces on the anchor body
    if (this.anchorBody) {
      this.applyUnderwaterForces(
        this.anchorBody,
        this.anchorMass,
        ANCHOR_NET_GRAVITY,
        ANCHOR_Z_DRAG,
        RODE_PARTICLE_COUNT, // anchor query index
      );
    }
  }

  /** Update query points from current particle positions. */
  private updateQueryPoints(): void {
    for (let i = 0; i < this.rodeParticles.length; i++) {
      const [px, py] = this.rodeParticles[i].position;
      this.ropeQueryPoints[i].set(px, py);
    }
    // Last query point is the anchor position
    if (this.anchorBody) {
      this.ropeQueryPoints[RODE_PARTICLE_COUNT].set(this.anchorPosition);
    }
  }

  /** Update anchor pitch dynamics. Z is handled by the physics engine. */
  private updatePitch(dt: number): void {
    if (!this.anchorBody) return;

    const I = (this.anchorLen * this.anchorLen) / 3;
    const d_cgToFlukes = this.anchorLen - this.d_cg;
    const anchorZ = this.anchorBody.z;

    // Detect bottom contact from the floor collision in applyUnderwaterForces
    // (the body z gets clamped to the floor there)
    const anchorQueryIdx = RODE_PARTICLE_COUNT;
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

    // 1. Rode pendulum — use last rode particle to determine rode direction
    if (this.rodeParticles.length > 0) {
      const lastParticle = this.rodeParticles[this.rodeParticles.length - 1];
      const dx = lastParticle.position[0] - this.anchorBody.position[0];
      const dy = lastParticle.position[1] - this.anchorBody.position[1];
      const dz = (lastParticle.z ?? 0) - anchorZ;
      const horizDist = Math.sqrt(dx * dx + dy * dy);
      const rodeAngle = Math.atan2(dz, horizDist);
      const dist3D = Math.sqrt(horizDist * horizDist + dz * dz);

      const segLen = this.currentRodeLength / (RODE_PARTICLE_COUNT - 1);
      const rodeTension = Math.max(
        0,
        Math.min(1, (dist3D - segLen * 0.5) / (segLen * 0.5)),
      );

      angAccel +=
        ((-ANCHOR_NET_GRAVITY * this.d_cg) / I) *
        Math.sin(rodeAngle + this.anchorPitch) *
        rodeTension;
    }

    // 2. Ground tipping (inverted pendulum)
    if (this.onBottom) {
      angAccel +=
        ((ANCHOR_NET_GRAVITY * d_cgToFlukes) / I) * Math.cos(this.anchorPitch);
    }

    // 3. Angular drag
    angAccel -= ANCHOR_ANGULAR_DRAG * this.anchorPitchVelocity;

    this.anchorPitchVelocity += angAccel * dt;
    this.anchorPitch += this.anchorPitchVelocity * dt;
    this.anchorPitch = Math.max(-Math.PI / 2, Math.min(0, this.anchorPitch));
    if (this.anchorPitch <= -Math.PI / 2)
      this.anchorPitchVelocity = Math.max(0, this.anchorPitchVelocity);
    if (this.anchorPitch >= 0)
      this.anchorPitchVelocity = Math.min(0, this.anchorPitchVelocity);
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]): void {
    if (this.state === "stowed") return;

    // Animate rode length
    const speed =
      this.state === "retrieving"
        ? this.rodeRetrieveSpeed
        : this.rodeDeploySpeed;
    const previousLength = this.currentRodeLength;
    this.currentRodeLength = stepToward(
      this.currentRodeLength,
      this.targetRodeLength,
      speed * dt,
    );

    if (this.currentRodeLength !== previousLength) {
      this.updateRodeConstraintLimits();
    }

    // State transitions
    if (
      this.state === "deploying" &&
      this.currentRodeLength >= this.maxRodeLength
    ) {
      this.state = "deployed";
    } else if (
      this.state === "retrieving" &&
      this.currentRodeLength <= RODE_RETRIEVAL_THRESHOLD
    ) {
      this.completeRetrieval();
      return;
    }

    // Update query points from particle positions
    this.updateQueryPoints();

    // Apply per-particle forces (gravity, drag, floor collision)
    this.applyRodeForces();

    // Anchor pitch dynamics (z is handled by physics engine via applyRodeForces)
    this.updatePitch(dt);

    // XY scope-based drag on anchor body
    if (this.anchorBody) {
      const scope = this.currentRodeLength / this.maxRodeLength;
      const velocity = this.anchorBody.velocity;
      const speed = velocity.magnitude;

      if (speed > 0.01) {
        let dragMagnitude = this.anchorDragCoefficient * scope * speed;

        if (
          this.onBottom &&
          this.waterQuery &&
          this.waterQuery.length > RODE_PARTICLE_COUNT
        ) {
          const waterDepth = this.waterQuery.get(RODE_PARTICLE_COUNT).depth;
          const bottomRodeLength = Math.max(
            0,
            this.currentRodeLength - waterDepth * 1.5,
          );
          const scopeBonus = bottomRodeLength / this.maxRodeLength;
          dragMagnitude *= 1 + scopeBonus * 2;
        }

        const dragForce = velocity.normalize().imul(-dragMagnitude);
        this.anchorBody.applyForce(dragForce);
      }

      this.anchorPosition = V(this.anchorBody.position);
    }
  }

  @on("render")
  onRender({ draw }: { draw: import("../../core/graphics/Draw").Draw }): void {
    if (this.state === "stowed") {
      this.renderStowedAnchor(draw);
      return;
    }

    this.renderRode(draw);
    this.renderDeployedAnchor(draw);
  }

  private renderStowedAnchor(
    draw: import("../../core/graphics/Draw").Draw,
  ): void {
    const bowPos = this.getBowWorldPosition();
    const stowedSize = this.anchorSize * 0.7;
    draw.at(
      {
        pos: bowPos,
        angle: this.hull.body.angle,
        tilt: {
          roll: this.hull.body.roll ?? 0,
          pitch: this.hull.body.pitch ?? 0,
          zOffset: this.hull.body.z ?? 0,
        },
      },
      () => {
        this.renderAnchorShapeLocal(draw, stowedSize);
      },
    );
  }

  private renderDeployedAnchor(
    draw: import("../../core/graphics/Draw").Draw,
  ): void {
    if (!this.anchorBody) return;

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

  private renderAnchorShapeLocal(
    draw: import("../../core/graphics/Draw").Draw,
    size: number,
  ): void {
    const w = size * ANCHOR_SHAPE_LINE_WIDTH_RATIO;
    const renderer = draw.renderer;
    const anchorLen = size * 1.55;
    const d_cg = anchorLen * ANCHOR_CG_RATIO;
    const ringEnd = d_cg;
    const flukeEnd = -(anchorLen - d_cg);

    const submit = (m: MeshContribution) => {
      if (m.positions.length > 0)
        renderer.submitTrianglesWithZ(
          m.positions,
          m.indices,
          m.color,
          m.alpha,
          m.zValues,
        );
    };

    submit(
      tessellateLineToQuad(flukeEnd, 0, 0, ringEnd, 0, 0, w, ANCHOR_COLOR),
    );
    const stockX = ringEnd - size * 0.25;
    const stockHalf = size * 0.45;
    submit(
      tessellateLineToQuad(
        stockX,
        -stockHalf,
        0,
        stockX,
        stockHalf,
        0,
        w,
        ANCHOR_COLOR,
      ),
    );
    const crownHalf = size * 0.25;
    submit(
      tessellateLineToQuad(
        flukeEnd,
        -crownHalf,
        0,
        flukeEnd,
        crownHalf,
        0,
        w,
        ANCHOR_COLOR,
      ),
    );
    const flukeLen = size * 0.45;
    const flukeSpread = size * 0.15;
    const flukeEndX = flukeEnd + flukeSpread;
    submit(
      tessellateLineToQuad(
        flukeEnd,
        -crownHalf,
        0,
        flukeEndX,
        -crownHalf - flukeLen,
        0,
        w,
        ANCHOR_COLOR,
      ),
    );
    submit(
      tessellateLineToQuad(
        flukeEnd,
        crownHalf,
        0,
        flukeEndX,
        crownHalf + flukeLen,
        0,
        w,
        ANCHOR_COLOR,
      ),
    );
    draw.fillCircle(ringEnd + size * 0.15, 0, size * 0.15, {
      color: ANCHOR_COLOR,
      z: 0,
    });
  }

  /** Render the rode: collect particle positions, smooth, tessellate. */
  private renderRode(draw: import("../../core/graphics/Draw").Draw): void {
    if (this.rodeParticles.length < 2) return;

    // Collect 3D positions from physics particles
    const points: [number, number][] = [];
    const zValues: number[] = [];
    for (const p of this.rodeParticles) {
      points.push([p.position[0], p.position[1]]);
      zValues.push(p.z ?? 0);
    }

    // Subdivide for smooth rendering
    const smooth = subdivideSmooth(points, zValues, RODE_SUBDIVISIONS);

    const mesh = tessellatePolylineToStrip(
      smooth.points,
      smooth.zValues,
      RODE_THICKNESS,
      RODE_COLOR,
    );
    if (mesh.positions.length > 0) {
      draw.renderer.submitTrianglesWithZ(
        mesh.positions,
        mesh.indices,
        mesh.color,
        mesh.alpha,
        mesh.zValues,
      );
    }
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

  @on("destroy")
  onDestroy(): void {
    if (this.isAdded) {
      this.cleanupRode();
      if (this.anchorBody) {
        this.game.world.bodies.remove(this.anchorBody);
      }
    }
  }
}
