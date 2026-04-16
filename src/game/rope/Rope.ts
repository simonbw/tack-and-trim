/**
 * A rope modeled as one continuous chain of lightweight physics particles
 * connected by upper-limit-only distance constraints.
 *
 * Pulleys, winches, and other constraints are external entities that act
 * on the rope's particles — the rope itself is just a chain of particles
 * and segments.
 *
 * Rope is a BaseEntity that owns its particles and segments as children;
 * adding a Rope to a parent entity automatically registers everything
 * with the physics world.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import type { Body } from "../../core/physics/body/Body";
import type { DynamicBody } from "../../core/physics/body/DynamicBody";
import type {
  DeckContactConstraint,
  HullBoundaryData,
} from "../../core/physics/constraints/DeckContactConstraint";
import { PointToRigidDistanceConstraint3D } from "../../core/physics/constraints/PointToRigidDistanceConstraint3D";
import { V, V2d } from "../../core/Vector";
import { CompatibleVector3, V3, V3d } from "../../core/Vector3";

// Module-level scratch vectors reused by getPointsWithZ() to avoid
// allocating a fresh V3d for each endpoint every render frame.
const SCRATCH_ENDPOINT_A = new V3d(0, 0, 0);
const SCRATCH_ENDPOINT_B = new V3d(0, 0, 0);
import { RopeParticle } from "./RopeParticle";
import { RopeSegment } from "./RopeSegment";

export interface RopeConfig {
  /** Total number of interior particles. Default 24. */
  particleCount?: number;
  /** Mass of each particle in lbs. Default 0.5. */
  particleMass?: number;
  /** Linear damping on particles (0 = none, 1 = full). Default 0.85. */
  damping?: number;
  /** Constraint stiffness for the GS solver. Default 1e5. */
  constraintStiffness?: number;
  /** Constraint relaxation for the GS solver. Higher = more damping. Default 12. */
  constraintRelaxation?: number;
  /**
   * Internal friction coefficient. Damps relative velocity between adjacent
   * particles, simulating fiber-on-fiber friction within the rope. Kills
   * high-frequency oscillation (guitar-string vibration) without affecting
   * bulk rope motion. Units: force per velocity per mass (1/s). Default 40.
   */
  internalFriction?: number;
  /** Gravity acceleration applied to rope particles (ft/s²).
   *  Buoyancy-reduced: full gravity is ~32.2, but rope in water sinks slower.
   *  Default 15. Set to 0 to disable. */
  gravity?: number;
  /** If true, the B endpoint is free (bitter end hangs loose). Default false. */
  freeEndB?: boolean;
  /**
   * Lower distance limit as a fraction of the chain link length.
   * Particles push apart when compressed below this fraction, giving them
   * effective volume for coiling. 0 = disabled, 1 = rigid rod.
   * Default 0.7 (particles compress to 70% of natural spacing).
   */
  minLinkFraction?: number;

  /** Rope diameter in feet. Default 0.026 (5/16"). */
  ropeDiameter?: number;

  /** Enable deck contact constraints: keep particles above the hull deck
   *  and outside the hull walls, with Coulomb friction. One constraint per
   *  particle, applied against endpoint B's body (the hull). */
  deckContact?: {
    /** Return deck z-height in hull-local coords, or null if no deck. */
    getDeckHeight: (localX: number, localY: number) => number | null;
    /** Pre-computed hull boundary for inside/outside tracking. */
    hullBoundary: HullBoundaryData;
    /** Coulomb friction coefficient. Default 1.5. */
    frictionCoefficient?: number;
  };

  /** Fluid drag applied to each segment (with normal/tangent split). */
  drag?: {
    /** Apply aerodynamic drag above the water surface. Default false. */
    airDrag?: boolean;
    /** Apply hydrodynamic drag below the water surface. Default false. */
    waterDrag?: boolean;
    /** Rope diameter in feet (drag area). Defaults to ropeDiameter. */
    ropeDiameter?: number;
    /** Cylinder cross-flow drag coefficient. Default 1.2. */
    cdNormal?: number;
    /** Skin-friction coefficient for axial flow. Default 0.02. */
    cdTangent?: number;
  };

  /** Terrain floor constraint per particle. If omitted, no floor. */
  terrainFloor?: {
    /** Friction applied to XY velocity when resting on the floor. Default 0.8. */
    floorFriction?: number;
  };
}

/** A world-space hint used to shape the initial path of the rope. */
export interface RopePathHint {
  body: Body;
  localAnchor: V3d;
}

export class Rope extends BaseEntity {
  // The continuous particle chain
  private particleEntities: RopeParticle[];
  private particles: DynamicBody[];
  private chainLinkLength: number;

  // Endpoints
  private endpointA: { body: Body; anchor: V3d };
  private endpointB: { body: Body; anchor: V3d };

  private totalLength: number;
  private readonly freeEndB: boolean;

  // Pre-allocated output arrays
  private cachedPositions: [number, number][] = [];
  private cachedZValues: number[] = [];

  constructor(
    bodyA: Body,
    localAnchorA: CompatibleVector3,
    bodyB: Body,
    localAnchorB: CompatibleVector3,
    totalLength: number,
    config: RopeConfig = {},
    pathHints: RopePathHint[] = [],
  ) {
    super();

    const stiffness = config.constraintStiffness ?? 1e5;
    const relaxation = config.constraintRelaxation ?? 12;
    const particleMass = config.particleMass ?? 0.5;
    const particleDamping = config.damping ?? 0.85;
    const internalFriction = config.internalFriction ?? 40;
    const gravity = config.gravity ?? 15;
    const minLinkFraction = config.minLinkFraction ?? 0.7;
    this.freeEndB = config.freeEndB ?? false;

    const numParticles = config.particleCount ?? 24;

    this.endpointA = { body: bodyA, anchor: V3(localAnchorA) };
    this.endpointB = { body: bodyB, anchor: V3(localAnchorB) };

    // Build the full path: endpoint A → path hints → endpoint B
    const pathNodes: { body: Body; anchor: V3d }[] = [
      { body: bodyA, anchor: this.endpointA.anchor },
      ...pathHints.map((h) => ({ body: h.body, anchor: h.localAnchor })),
      { body: bodyB, anchor: this.endpointB.anchor },
    ];

    // Compute world positions and cumulative distances along the path
    const worldPos = pathNodes.map((n) => n.body.toWorldFrame3D(n.anchor));
    const worldPos2D = pathNodes.map((n) =>
      n.body.toWorldFrame(V(n.anchor[0], n.anchor[1])),
    );
    let totalPathDist = 0;
    const cumulDist = [0];
    for (let i = 1; i < worldPos.length; i++) {
      const [ax, ay, az] = worldPos[i - 1];
      const [bx, by, bz] = worldPos[i];
      totalPathDist += Math.sqrt(
        (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2,
      );
      cumulDist.push(totalPathDist);
    }

    // Ensure total rope length is at least the path distance
    this.totalLength = Math.max(totalLength, totalPathDist);

    // Chain link length: total rope / (numParticles + 1) links
    this.chainLinkLength = this.totalLength / (numParticles + 1);

    // Build deck contact config (if enabled) — applied per particle against bodyB
    const deckContactConfig = config.deckContact
      ? {
          hullBody: bodyB,
          getDeckHeight: config.deckContact.getDeckHeight,
          hullBoundary: config.deckContact.hullBoundary,
          frictionCoefficient: config.deckContact.frictionCoefficient ?? 1.5,
          ropeRadius: (config.ropeDiameter ?? 0.026) / 2,
        }
      : undefined;

    // Create particles uniformly spaced along the path
    this.particleEntities = [];
    const velA = bodyA.velocity;
    const velB = bodyB.velocity;
    for (let i = 0; i < numParticles; i++) {
      const t = (i + 1) / (numParticles + 1);
      const distAlongPath = t * totalPathDist;

      // Find which path segment this distance falls in
      let segIdx = 0;
      for (let s = 1; s < cumulDist.length; s++) {
        if (cumulDist[s] >= distAlongPath) {
          segIdx = s - 1;
          break;
        }
      }

      // Interpolate within the segment
      const segStart = cumulDist[segIdx];
      const segEnd = cumulDist[segIdx + 1];
      const segT =
        segEnd > segStart
          ? (distAlongPath - segStart) / (segEnd - segStart)
          : 0;

      const posA2D = worldPos2D[segIdx];
      const posB2D = worldPos2D[segIdx + 1];
      const px = posA2D[0] + segT * (posB2D[0] - posA2D[0]);
      const py = posA2D[1] + segT * (posB2D[1] - posA2D[1]);
      const pz =
        worldPos[segIdx][2] +
        segT * (worldPos[segIdx + 1][2] - worldPos[segIdx][2]);

      const rp = new RopeParticle({
        mass: particleMass,
        damping: particleDamping,
        position: [px, py],
        zPosition: pz,
        initialVelocity: [
          velA[0] + t * (velB[0] - velA[0]),
          velA[1] + t * (velB[1] - velA[1]),
        ],
        gravity,
        deckContact: deckContactConfig,
        terrainFloor: config.terrainFloor
          ? { floorFriction: config.terrainFloor.floorFriction ?? 0.8 }
          : undefined,
      });
      this.particleEntities.push(rp);
      this.addChild(rp);
    }
    this.particles = this.particleEntities.map((rp) => rp.body);

    // Create segments between adjacent particles. Each segment owns its
    // chain constraint, internal friction, and segment-based drag.
    const dragCfg = config.drag;
    const segmentDragConfig = dragCfg
      ? {
          airDrag: dragCfg.airDrag ?? false,
          waterDrag: dragCfg.waterDrag ?? false,
          diameter: dragCfg.ropeDiameter ?? config.ropeDiameter ?? 0.026,
          cdNormal: dragCfg.cdNormal ?? 1.2,
          cdTangent: dragCfg.cdTangent ?? 0.02,
        }
      : undefined;

    for (let i = 0; i < numParticles - 1; i++) {
      // Wrap constraint config: pair up the deck-contact constraints of the
      // two neighboring particles so the segment can cheaply tell whether
      // this pair currently straddles the hull edge.
      let wrapConfig:
        | {
            hullBody: Body;
            hullBoundary: HullBoundaryData;
            deckContactA: DeckContactConstraint;
            deckContactB: DeckContactConstraint;
          }
        | undefined;
      if (config.deckContact) {
        const dcA = this.particleEntities[i].getDeckContact();
        const dcB = this.particleEntities[i + 1].getDeckContact();
        if (dcA && dcB) {
          wrapConfig = {
            hullBody: bodyB,
            hullBoundary: config.deckContact.hullBoundary,
            deckContactA: dcA,
            deckContactB: dcB,
          };
        }
      }

      const segment = new RopeSegment(
        this.particles[i],
        this.particles[i + 1],
        {
          length: this.chainLinkLength,
          stiffness,
          relaxation,
          minLinkFraction,
          // Solver order: chain constraint between p_i and p_{i+1} gets
          // (2 * (i+1) + 1) so that endpoint A → p0 is order 1,
          // p0 → p1 is order 3, etc. Pulleys interleave on even values.
          solverOrder: 2 * (i + 1) + 1,
          internalFriction,
          drag: segmentDragConfig,
          wrap: wrapConfig,
        },
      );
      this.addChild(segment);
    }

    // Endpoint chain constraints (A → P0 and Pn-1 → B). These don't have
    // a neighbor on one side so they're not RopeSegments. Both use
    // PointToRigidDistanceConstraint3D — the particle is always bodyA
    // (per the shape's convention), and the rigid endpoint carries the
    // local anchor. For the "A → P0" case we swap the natural body order
    // so the particle ends up on side A.
    const endpointConstraints: PointToRigidDistanceConstraint3D[] = [];
    endpointConstraints.push(
      this.makeEndpointChainConstraint(
        this.particles[0],
        bodyA,
        localAnchorA,
        1, // solver order: first chain link
        stiffness,
        relaxation,
        minLinkFraction,
      ),
    );
    if (!this.freeEndB) {
      endpointConstraints.push(
        this.makeEndpointChainConstraint(
          this.particles[numParticles - 1],
          bodyB,
          localAnchorB,
          // Last solver order: chain order after the final particle pair
          2 * numParticles + 1,
          stiffness,
          relaxation,
          minLinkFraction,
        ),
      );
    }
    this.constraints = endpointConstraints;

    // Pre-allocate output arrays
    this.rebuildCachedArrays();
  }

  private makeEndpointChainConstraint(
    particle: DynamicBody,
    rigid: Body,
    localAnchorOnRigid: CompatibleVector3,
    solverOrder: number,
    stiffness: number,
    relaxation: number,
    minLinkFraction: number,
  ): PointToRigidDistanceConstraint3D {
    const length = this.chainLinkLength;
    const c = new PointToRigidDistanceConstraint3D(particle, rigid, {
      localAnchorB: localAnchorOnRigid,
      distance: length,
      collideConnected: true,
    });
    c.upperLimitEnabled = true;
    c.upperLimit = length;
    c.lowerLimitEnabled = minLinkFraction > 0;
    c.lowerLimit = length * minLinkFraction;
    for (const eq of c.equations) {
      eq.stiffness = stiffness;
      eq.relaxation = relaxation;
      eq.solverOrder = solverOrder;
    }
    return c;
  }

  private rebuildCachedArrays(): void {
    const totalPoints = this.getPointCount();
    this.cachedPositions = Array.from(
      { length: totalPoints },
      () => [0, 0] as [number, number],
    );
    this.cachedZValues = new Array(totalPoints).fill(0);
  }

  /** Total number of rendered points (endpoints + particles). */
  private getPointCount(): number {
    const endpoints = this.freeEndB ? 1 : 2;
    return endpoints + this.particles.length;
  }

  // ---- Rendering ----

  /**
   * Get world-space rope points with z-values.
   * Returns endpoints and particle positions.
   */
  getPointsWithZ(): {
    points: [number, number][];
    z: number[];
  } {
    let idx = 0;

    // Endpoint A (zero-alloc via scratch)
    const eA = this.endpointA.body.toWorldFrame3D(
      this.endpointA.anchor,
      SCRATCH_ENDPOINT_A,
    );
    this.cachedPositions[idx][0] = eA[0];
    this.cachedPositions[idx][1] = eA[1];
    this.cachedZValues[idx] = eA[2];
    idx++;

    // Particles
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      this.cachedPositions[idx][0] = p.position[0];
      this.cachedPositions[idx][1] = p.position[1];
      this.cachedZValues[idx] = p.z;
      idx++;
    }

    // Endpoint B (only if attached, zero-alloc via scratch)
    if (!this.freeEndB) {
      const eB = this.endpointB.body.toWorldFrame3D(
        this.endpointB.anchor,
        SCRATCH_ENDPOINT_B,
      );
      this.cachedPositions[idx][0] = eB[0];
      this.cachedPositions[idx][1] = eB[1];
      this.cachedZValues[idx] = eB[2];
    }

    return { points: this.cachedPositions, z: this.cachedZValues };
  }

  // ---- Public accessors ----

  /** Particle bodies, used by Pulley to set up its constraint. */
  getParticles(): readonly DynamicBody[] {
    return this.particles;
  }

  /** Particle entities (one per body), used by obstacle collision code. */
  getParticleEntities(): readonly RopeParticle[] {
    return this.particleEntities;
  }

  /** Get the current total rope length. */
  getLength(): number {
    return this.totalLength;
  }

  /** Get the chain link length. */
  getChainLinkLength(): number {
    return this.chainLinkLength;
  }
}
