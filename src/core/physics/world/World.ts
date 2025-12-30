import { CompatibleVector, V2d } from "../../Vector";
import Body from "../body/Body";
import AABB from "../collision/AABB";
import Broadphase from "../collision/Broadphase";
import Narrowphase from "../collision/Narrowphase";
import Ray from "../collision/Ray";
import type RaycastResult from "../collision/RaycastResult";
import Constraint from "../constraints/Constraint";
import type ContactEquation from "../equations/ContactEquation";
import type FrictionEquation from "../equations/FrictionEquation";
import EventEmitter from "../events/EventEmitter";
import ContactMaterial from "../material/ContactMaterial";
import Material from "../material/Material";
import Capsule from "../shapes/Capsule";
import Circle from "../shapes/Circle";
import Convex from "../shapes/Convex";
import Particle from "../shapes/Particle";
import Shape from "../shapes/Shape";
import GSSolver from "../solver/GSSolver";
import Solver from "../solver/Solver";
import SpatialHashingBroadphase from "../SpatialHashingBroadphase";
import type Spring from "../springs/Spring";
import OverlapKeeper from "../utils/OverlapKeeper";
import type OverlapKeeperRecord from "../utils/OverlapKeeperRecord";
import Utils from "../utils/Utils";
import IslandManager from "./IslandManager";

export interface WorldOptions {
  solver?: Solver;
  gravity?: CompatibleVector;
  broadphase?: Broadphase;
  islandSplit?: boolean;
}

// Module-level temp vectors
const step_mg = new V2d(0, 0);
const xiw = new V2d(0, 0);
const xjw = new V2d(0, 0);
const endOverlaps: OverlapKeeperRecord[] = [];

const hitTest_tmp1 = new V2d(0, 0);
const hitTest_tmp2 = new V2d(0, 0);
const tmpAABB = new AABB();
const tmpArray: Body[] = [];

/**
 * The dynamics world, where all bodies and constraints live.
 */
export default class World extends EventEmitter {
  static readonly NO_SLEEPING = 1;
  static readonly BODY_SLEEPING = 2;
  static readonly ISLAND_SLEEPING = 4;

  springs: Spring[] = [];
  bodies: Body[] = [];
  dynamicBodies: Set<Body> = new Set();
  kinematicBodies: Set<Body> = new Set();
  disabledBodyCollisionPairs: Body[] = [];
  solver: Solver;
  narrowphase: Narrowphase;
  islandManager: IslandManager;
  gravity: V2d;
  frictionGravity: number;
  useWorldGravityAsFrictionGravity: boolean = true;
  useFrictionGravityOnZeroGravity: boolean = true;
  broadphase: Broadphase;
  constraints: Constraint[] = [];
  defaultMaterial: Material;
  defaultContactMaterial: ContactMaterial;
  lastTimeStep: number = 1 / 60;
  applySpringForces: boolean = true;
  applyDamping: boolean = true;
  applyGravity: boolean = true;
  solveConstraints: boolean = true;
  contactMaterials: ContactMaterial[] = [];
  time: number = 0.0;
  accumulator: number = 0;
  stepping: boolean = false;
  bodiesToBeRemoved: Body[] = [];
  islandSplit: boolean;
  emitImpactEvent: boolean = true;
  _constraintIdCounter: number = 0;
  _bodyIdCounter: number = 0;
  sleepMode: number;
  overlapKeeper: OverlapKeeper;

  // Event objects for reuse
  postStepEvent = { type: "postStep" };
  addBodyEvent: { type: string; body: Body | null } = {
    type: "addBody",
    body: null,
  };
  removeBodyEvent: { type: string; body: Body | null } = {
    type: "removeBody",
    body: null,
  };
  addSpringEvent: { type: string; spring: Spring | null } = {
    type: "addSpring",
    spring: null,
  };
  impactEvent: {
    type: string;
    bodyA: Body | null;
    bodyB: Body | null;
    shapeA: Shape | null;
    shapeB: Shape | null;
    contactEquation: ContactEquation | null;
  } = {
    type: "impact",
    bodyA: null,
    bodyB: null,
    shapeA: null,
    shapeB: null,
    contactEquation: null,
  };
  postBroadphaseEvent: { type: string; pairs: Body[] | null } = {
    type: "postBroadphase",
    pairs: null,
  };
  beginContactEvent: {
    type: string;
    shapeA: Shape | null;
    shapeB: Shape | null;
    bodyA: Body | null;
    bodyB: Body | null;
    contactEquations: ContactEquation[];
  } = {
    type: "beginContact",
    shapeA: null,
    shapeB: null,
    bodyA: null,
    bodyB: null,
    contactEquations: [],
  };
  endContactEvent: {
    type: string;
    shapeA: Shape | null;
    shapeB: Shape | null;
    bodyA: Body | null;
    bodyB: Body | null;
  } = {
    type: "endContact",
    shapeA: null,
    shapeB: null,
    bodyA: null,
    bodyB: null,
  };
  preSolveEvent: {
    type: string;
    contactEquations: ContactEquation[] | null;
    frictionEquations: FrictionEquation[] | null;
  } = {
    type: "preSolve",
    contactEquations: null,
    frictionEquations: null,
  };

  constructor(options: WorldOptions = {}) {
    super();

    this.solver = options.solver || new GSSolver();
    this.solver.setWorld(this);
    this.narrowphase = new Narrowphase(this);
    this.islandManager = new IslandManager();

    this.gravity = new V2d(0, -9.78);
    if (options.gravity) {
      this.gravity.set(options.gravity);
    }

    this.frictionGravity = this.gravity.magnitude || 10;

    this.broadphase = options.broadphase || new SpatialHashingBroadphase();
    this.broadphase.setWorld(this);

    this.defaultMaterial = new Material();
    this.defaultContactMaterial = new ContactMaterial(
      this.defaultMaterial,
      this.defaultMaterial
    );

    this.islandSplit =
      typeof options.islandSplit !== "undefined"
        ? !!options.islandSplit
        : false;

    // Disable automatic gravity and damping - let game code apply these
    this.applyGravity = false;
    this.applyDamping = false;

    this.sleepMode = World.NO_SLEEPING;
    this.overlapKeeper = new OverlapKeeper();
  }

  /**
   * Add a constraint to the simulation.
   */
  addConstraint(constraint: Constraint): void {
    this.constraints.push(constraint);
  }

  /**
   * Add a ContactMaterial to the simulation.
   */
  addContactMaterial(contactMaterial: ContactMaterial): void {
    this.contactMaterials.push(contactMaterial);
  }

  /**
   * Removes a contact material
   */
  removeContactMaterial(cm: ContactMaterial): void {
    const idx = this.contactMaterials.indexOf(cm);
    if (idx !== -1) {
      Utils.splice(this.contactMaterials, idx, 1);
    }
  }

  /**
   * Get a contact material given two materials
   */
  getContactMaterial(
    materialA: Material,
    materialB: Material
  ): ContactMaterial | false {
    const cmats = this.contactMaterials;
    for (let i = 0, N = cmats.length; i !== N; i++) {
      const cm = cmats[i];
      if (
        (cm.materialA.id === materialA.id &&
          cm.materialB.id === materialB.id) ||
        (cm.materialA.id === materialB.id && cm.materialB.id === materialA.id)
      ) {
        return cm;
      }
    }
    return false;
  }

  /**
   * Removes a constraint
   */
  removeConstraint(constraint: Constraint): void {
    const idx = this.constraints.indexOf(constraint);
    if (idx !== -1) {
      Utils.splice(this.constraints, idx, 1);
    }
  }

  /**
   * Step the physics world forward in time.
   */
  step(
    dt: number,
    timeSinceLastCalled: number = 0,
    maxSubSteps: number = 10
  ): void {
    if (timeSinceLastCalled === 0) {
      // Fixed, simple stepping
      this.internalStep(dt);
      this.time += dt;
    } else {
      this.accumulator += timeSinceLastCalled;
      let substeps = 0;
      while (this.accumulator >= dt && substeps < maxSubSteps) {
        this.internalStep(dt);
        this.time += dt;
        this.accumulator -= dt;
        substeps++;
      }

      const t = (this.accumulator % dt) / dt;
      for (let j = 0; j !== this.bodies.length; j++) {
        const b = this.bodies[j];
        b.interpolatedPosition.set(b.previousPosition).ilerp(b.position, t);
        b.interpolatedAngle = b.previousAngle + t * (b.angle - b.previousAngle);
      }
    }
  }

  /**
   * Make a fixed step.
   */
  internalStep(dt: number): void {
    this.stepping = true;

    const springs = this.springs;
    const bodies = this.bodies;
    const g = this.gravity;
    const solver = this.solver;
    const Nbodies = this.bodies.length;
    const broadphase = this.broadphase;
    const np = this.narrowphase;
    const constraints = this.constraints;
    const mg = step_mg;
    const islandManager = this.islandManager;

    this.overlapKeeper.tick();
    this.lastTimeStep = dt;

    // Update approximate friction gravity.
    if (this.useWorldGravityAsFrictionGravity) {
      const gravityLen = this.gravity.magnitude;
      if (!(gravityLen === 0 && this.useFrictionGravityOnZeroGravity)) {
        this.frictionGravity = gravityLen;
      }
    }

    // Add gravity to bodies
    if (this.applyGravity) {
      for (let i = 0; i !== Nbodies; i++) {
        const b = bodies[i];
        if (b.type !== Body.DYNAMIC || b.sleepState === Body.SLEEPING) {
          continue;
        }
        mg.set(g).imul(b.mass * b.gravityScale);
        b.force.iadd(mg);
      }
    }

    // Add spring forces
    if (this.applySpringForces) {
      for (let i = 0; i !== springs.length; i++) {
        const s = springs[i];
        s.applyForce();
      }
    }

    if (this.applyDamping) {
      for (let i = 0; i !== Nbodies; i++) {
        const b = bodies[i];
        if (b.type === Body.DYNAMIC) {
          b.applyDamping(dt);
        }
      }
    }

    // Broadphase
    const result = broadphase.getCollisionPairs(this);

    // Remove ignored collision pairs
    const ignoredPairs = this.disabledBodyCollisionPairs;
    for (let i = ignoredPairs.length - 2; i >= 0; i -= 2) {
      for (let j = result.length - 2; j >= 0; j -= 2) {
        if (
          (ignoredPairs[i] === result[j] &&
            ignoredPairs[i + 1] === result[j + 1]) ||
          (ignoredPairs[i + 1] === result[j] &&
            ignoredPairs[i] === result[j + 1])
        ) {
          result.splice(j, 2);
        }
      }
    }

    // Remove constrained pairs with collideConnected == false
    const Nconstraints = constraints.length;
    for (let i = 0; i !== Nconstraints; i++) {
      const c = constraints[i];
      if (!c.collideConnected) {
        for (let j = result.length - 2; j >= 0; j -= 2) {
          if (
            (c.bodyA === result[j] && c.bodyB === result[j + 1]) ||
            (c.bodyB === result[j] && c.bodyA === result[j + 1])
          ) {
            result.splice(j, 2);
          }
        }
      }
    }

    // postBroadphase event
    this.postBroadphaseEvent.pairs = result;
    this.emit(this.postBroadphaseEvent);
    this.postBroadphaseEvent.pairs = null;

    // Narrowphase
    np.reset();
    for (let i = 0, Nresults = result.length; i !== Nresults; i += 2) {
      const bi = result[i];
      const bj = result[i + 1];

      // Loop over all shapes of body i
      for (let k = 0, Nshapesi = bi.shapes.length; k !== Nshapesi; k++) {
        const si = bi.shapes[k];
        const xi = si.position;
        const ai = si.angle;

        // All shapes of body j
        for (let l = 0, Nshapesj = bj.shapes.length; l !== Nshapesj; l++) {
          const sj = bj.shapes[l];
          const xj = sj.position;
          const aj = sj.angle;

          let cm: ContactMaterial = this.defaultContactMaterial;
          if (si.material && sj.material) {
            const tmp = this.getContactMaterial(si.material, sj.material);
            if (tmp) {
              cm = tmp;
            }
          }

          this.runNarrowphase(
            np,
            bi,
            si,
            xi,
            ai,
            bj,
            sj,
            xj,
            aj,
            cm,
            this.frictionGravity
          );
        }
      }
    }

    // Wake up bodies
    for (let i = 0; i !== Nbodies; i++) {
      const body = bodies[i];
      if (body._wakeUpAfterNarrowphase) {
        body.wakeUp();
        body._wakeUpAfterNarrowphase = false;
      }
    }

    // Emit end overlap events
    if (this.has("endContact")) {
      this.overlapKeeper.getEndOverlaps(endOverlaps);
      const e = this.endContactEvent;
      let l = endOverlaps.length;
      while (l--) {
        const data = endOverlaps[l];
        e.shapeA = data.shapeA;
        e.shapeB = data.shapeB;
        e.bodyA = data.bodyA;
        e.bodyB = data.bodyB;
        this.emit(e);
      }
      endOverlaps.length = 0;
    }

    const preSolveEvent = this.preSolveEvent;
    preSolveEvent.contactEquations = np.contactEquations;
    preSolveEvent.frictionEquations = np.frictionEquations;
    this.emit(preSolveEvent);
    preSolveEvent.contactEquations = preSolveEvent.frictionEquations = null;

    // update constraint equations
    for (let i = 0; i !== Nconstraints; i++) {
      constraints[i].update();
    }

    if (
      np.contactEquations.length ||
      np.frictionEquations.length ||
      Nconstraints
    ) {
      if (this.islandSplit) {
        // Split into islands
        islandManager.equations.length = 0;
        Utils.appendArray(islandManager.equations, np.contactEquations);
        Utils.appendArray(islandManager.equations, np.frictionEquations);
        for (let i = 0; i !== Nconstraints; i++) {
          Utils.appendArray(islandManager.equations, constraints[i].equations);
        }
        islandManager.split(this);

        for (let i = 0; i !== islandManager.islands.length; i++) {
          const island = islandManager.islands[i];
          if (island.equations.length) {
            solver.solveIsland(dt, island);
          }
        }
      } else {
        // Add contact equations to solver
        solver.addEquations(np.contactEquations);
        solver.addEquations(np.frictionEquations);

        // Add user-defined constraint equations
        for (let i = 0; i !== Nconstraints; i++) {
          solver.addEquations(constraints[i].equations);
        }

        if (this.solveConstraints) {
          solver.solve(dt, this);
        }

        solver.removeAllEquations();
      }
    }

    // Step forward
    for (let i = 0; i !== Nbodies; i++) {
      const body = bodies[i];
      body.integrate(dt);
    }

    // Reset force
    for (let i = 0; i !== Nbodies; i++) {
      bodies[i].setZeroForce();
    }

    // Emit impact event
    if (this.emitImpactEvent && this.has("impact")) {
      const ev = this.impactEvent;
      for (let i = 0; i !== np.contactEquations.length; i++) {
        const eq = np.contactEquations[i];
        if (eq.firstImpact) {
          ev.bodyA = eq.bodyA;
          ev.bodyB = eq.bodyB;
          ev.shapeA = eq.shapeA;
          ev.shapeB = eq.shapeB;
          ev.contactEquation = eq;
          this.emit(ev);
        }
      }
    }

    // Sleeping update
    if (this.sleepMode === World.BODY_SLEEPING) {
      for (let i = 0; i !== Nbodies; i++) {
        bodies[i].sleepTick(this.time, false, dt);
      }
    } else if (this.sleepMode === World.ISLAND_SLEEPING && this.islandSplit) {
      // Tell all bodies to sleep tick but dont sleep yet
      for (let i = 0; i !== Nbodies; i++) {
        bodies[i].sleepTick(this.time, true, dt);
      }

      // Sleep islands
      for (let i = 0; i < this.islandManager.islands.length; i++) {
        const island = this.islandManager.islands[i];
        if (island.wantsToSleep()) {
          island.sleep();
        }
      }
    }

    this.stepping = false;

    // Remove bodies that are scheduled for removal
    const bodiesToBeRemoved = this.bodiesToBeRemoved;
    for (let i = 0; i !== bodiesToBeRemoved.length; i++) {
      this.removeBody(bodiesToBeRemoved[i]);
    }
    bodiesToBeRemoved.length = 0;

    this.emit(this.postStepEvent);
  }

  /**
   * Runs narrowphase for the shape pair i and j.
   */
  runNarrowphase(
    np: Narrowphase,
    bi: Body,
    si: Shape,
    xi: V2d,
    ai: number,
    bj: Body,
    sj: Shape,
    xj: V2d,
    aj: number,
    cm: ContactMaterial,
    glen: number
  ): void {
    // Check collision groups and masks
    if (
      !(
        (si.collisionGroup & sj.collisionMask) !== 0 &&
        (sj.collisionGroup & si.collisionMask) !== 0
      )
    ) {
      return;
    }

    // Get world position and angle of each shape
    xiw.set(xi).irotate(bi.angle).iadd(bi.position);
    xjw.set(xj).irotate(bj.angle).iadd(bj.position);
    const aiw = ai + bi.angle;
    const ajw = aj + bj.angle;

    np.enableFriction = cm.friction > 0;
    np.frictionCoefficient = cm.friction;
    let reducedMass: number;
    if (bi.type === Body.STATIC || bi.type === Body.KINEMATIC) {
      reducedMass = bj.mass;
    } else if (bj.type === Body.STATIC || bj.type === Body.KINEMATIC) {
      reducedMass = bi.mass;
    } else {
      reducedMass = (bi.mass * bj.mass) / (bi.mass + bj.mass);
    }
    np.slipForce = cm.friction * glen * reducedMass;
    np.restitution = cm.restitution;
    np.surfaceVelocity = cm.surfaceVelocity;
    np.frictionStiffness = cm.frictionStiffness;
    np.frictionRelaxation = cm.frictionRelaxation;
    np.stiffness = cm.stiffness;
    np.relaxation = cm.relaxation;
    np.contactSkinSize = cm.contactSkinSize;
    np.enabledEquations =
      bi.collisionResponse &&
      bj.collisionResponse &&
      si.collisionResponse &&
      sj.collisionResponse;

    const resolver = np[si.type | sj.type];
    let numContacts = 0;
    if (resolver) {
      const sensor = si.sensor || sj.sensor;
      const numFrictionBefore = np.frictionEquations.length;
      if (si.type < sj.type) {
        numContacts = resolver.call(
          np,
          bi,
          si,
          xiw,
          aiw,
          bj,
          sj,
          xjw,
          ajw,
          sensor
        );
      } else {
        numContacts = resolver.call(
          np,
          bj,
          sj,
          xjw,
          ajw,
          bi,
          si,
          xiw,
          aiw,
          sensor
        );
      }
      const numFrictionEquations =
        np.frictionEquations.length - numFrictionBefore;

      if (numContacts) {
        if (
          bi.allowSleep &&
          bi.type === Body.DYNAMIC &&
          bi.sleepState === Body.SLEEPING &&
          bj.sleepState === Body.AWAKE &&
          bj.type !== Body.STATIC
        ) {
          const speedSquaredB =
            bj.velocity.squaredMagnitude + Math.pow(bj.angularVelocity, 2);
          const speedLimitSquaredB = Math.pow(bj.sleepSpeedLimit, 2);
          if (speedSquaredB >= speedLimitSquaredB * 2) {
            bi._wakeUpAfterNarrowphase = true;
          }
        }

        if (
          bj.allowSleep &&
          bj.type === Body.DYNAMIC &&
          bj.sleepState === Body.SLEEPING &&
          bi.sleepState === Body.AWAKE &&
          bi.type !== Body.STATIC
        ) {
          const speedSquaredA =
            bi.velocity.squaredMagnitude + Math.pow(bi.angularVelocity, 2);
          const speedLimitSquaredA = Math.pow(bi.sleepSpeedLimit, 2);
          if (speedSquaredA >= speedLimitSquaredA * 2) {
            bj._wakeUpAfterNarrowphase = true;
          }
        }

        this.overlapKeeper.setOverlapping(bi, si, bj, sj);
        if (
          this.has("beginContact") &&
          this.overlapKeeper.isNewOverlap(si, sj)
        ) {
          // Report new shape overlap
          const e = this.beginContactEvent;
          e.shapeA = si;
          e.shapeB = sj;
          e.bodyA = bi;
          e.bodyB = bj;

          // Reset contact equations
          e.contactEquations.length = 0;

          if (typeof numContacts === "number") {
            for (
              let i = np.contactEquations.length - numContacts;
              i < np.contactEquations.length;
              i++
            ) {
              e.contactEquations.push(np.contactEquations[i]);
            }
          }

          this.emit(e);
        }

        // divide the max friction force by the number of contacts
        if (typeof numContacts === "number" && numFrictionEquations > 1) {
          for (
            let i = np.frictionEquations.length - numFrictionEquations;
            i < np.frictionEquations.length;
            i++
          ) {
            const f = np.frictionEquations[i];
            f.setSlipForce(f.getSlipForce() / numFrictionEquations);
          }
        }
      }
    }
  }

  /**
   * Add a spring to the simulation
   */
  addSpring(spring: Spring): void {
    this.springs.push(spring);
    const evt = this.addSpringEvent;
    evt.spring = spring;
    this.emit(evt);
    evt.spring = null;
  }

  /**
   * Remove a spring
   */
  removeSpring(spring: Spring): void {
    const idx = this.springs.indexOf(spring);
    if (idx !== -1) {
      Utils.splice(this.springs, idx, 1);
    }
  }

  /**
   * Add a body to the simulation
   */
  addBody(body: Body): void {
    if (this.bodies.indexOf(body) === -1) {
      this.bodies.push(body);
      body.world = this;

      if (body.type === Body.DYNAMIC) {
        this.dynamicBodies.add(body);
      } else if (body.type === Body.KINEMATIC) {
        this.kinematicBodies.add(body);
      }

      const evt = this.addBodyEvent;
      evt.body = body;
      this.emit(evt);
      evt.body = null;
    }
  }

  /**
   * Remove a body from the simulation. If this method is called during step(), the body removal is scheduled to after the step.
   */
  removeBody(body: Body): void {
    if (this.stepping) {
      this.bodiesToBeRemoved.push(body);
    } else {
      body.world = null;
      const idx = this.bodies.indexOf(body);
      if (idx !== -1) {
        Utils.splice(this.bodies, idx, 1);

        this.dynamicBodies.delete(body);
        this.kinematicBodies.delete(body);

        this.removeBodyEvent.body = body;
        body.resetConstraintVelocity();
        this.emit(this.removeBodyEvent);
        this.removeBodyEvent.body = null;
      }
    }
  }

  /**
   * Get a body by its id.
   */
  getBodyById(id: number): Body | false {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (b.id === id) {
        return b;
      }
    }
    return false;
  }

  /**
   * Disable collision between two bodies
   */
  disableBodyCollision(bodyA: Body, bodyB: Body): void {
    this.disabledBodyCollisionPairs.push(bodyA, bodyB);
  }

  /**
   * Enable collisions between the given two bodies
   */
  enableBodyCollision(bodyA: Body, bodyB: Body): void {
    const pairs = this.disabledBodyCollisionPairs;
    for (let i = 0; i < pairs.length; i += 2) {
      if (
        (pairs[i] === bodyA && pairs[i + 1] === bodyB) ||
        (pairs[i + 1] === bodyA && pairs[i] === bodyB)
      ) {
        pairs.splice(i, 2);
        return;
      }
    }
  }

  /**
   * Resets the World, removes all bodies, constraints and springs.
   */
  clear(): void {
    this.time = 0;

    // Remove all solver equations
    if (this.solver && this.solver.equations.length) {
      this.solver.removeAllEquations();
    }

    // Remove all constraints
    const cs = this.constraints;
    for (let i = cs.length - 1; i >= 0; i--) {
      this.removeConstraint(cs[i]);
    }

    // Remove all bodies
    const bodies = this.bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
      this.removeBody(bodies[i]);
    }

    // Remove all springs
    const springs = this.springs;
    for (let i = springs.length - 1; i >= 0; i--) {
      this.removeSpring(springs[i]);
    }

    // Remove all contact materials
    const cms = this.contactMaterials;
    for (let i = cms.length - 1; i >= 0; i--) {
      this.removeContactMaterial(cms[i]);
    }
  }

  /**
   * Test if a world point overlaps bodies
   */
  hitTest(worldPoint: V2d, bodies: Body[], precision: number = 0): Body[] {
    // Create a dummy particle body with a particle shape to test against the bodies
    const pb = new Body({ position: worldPoint });
    const ps = new Particle();
    const px = worldPoint;
    const pa = 0;
    const x = hitTest_tmp1;
    const tmp = hitTest_tmp2;
    pb.addShape(ps);

    const n = this.narrowphase;
    const result: Body[] = [];

    // Check bodies
    for (let i = 0, N = bodies.length; i !== N; i++) {
      const b = bodies[i];

      for (let j = 0, NS = b.shapes.length; j !== NS; j++) {
        const s = b.shapes[j];

        // Get shape world position + angle
        x.set(s.position).irotate(b.angle).iadd(b.position);
        const a = s.angle + b.angle;

        if (
          (s instanceof Circle &&
            n.circleParticle(b, s, x, a, pb, ps, px, pa, true)) ||
          (s instanceof Convex &&
            n.particleConvex(pb, ps, px, pa, b, s, x, a, true)) ||
          (s instanceof Capsule &&
            n.particleCapsule(pb, ps, px, pa, b, s, x, a, true)) ||
          (s instanceof Particle &&
            tmp.set(x).isub(worldPoint).squaredMagnitude <
              precision * precision)
        ) {
          result.push(b);
        }
      }
    }

    return result;
  }

  /**
   * Set the stiffness for all equations and contact materials.
   */
  setGlobalStiffness(stiffness: number): void {
    // Set for all constraints
    const constraints = this.constraints;
    for (let i = 0; i !== constraints.length; i++) {
      const c = constraints[i];
      for (let j = 0; j !== c.equations.length; j++) {
        const eq = c.equations[j];
        eq.stiffness = stiffness;
        eq.needsUpdate = true;
      }
    }

    // Set for all contact materials
    const contactMaterials = this.contactMaterials;
    for (let i = 0; i !== contactMaterials.length; i++) {
      const c = contactMaterials[i];
      c.stiffness = c.frictionStiffness = stiffness;
    }

    // Set for default contact material
    const c = this.defaultContactMaterial;
    c.stiffness = c.frictionStiffness = stiffness;
  }

  /**
   * Set the relaxation for all equations and contact materials.
   */
  setGlobalRelaxation(relaxation: number): void {
    // Set for all constraints
    for (let i = 0; i !== this.constraints.length; i++) {
      const c = this.constraints[i];
      for (let j = 0; j !== c.equations.length; j++) {
        const eq = c.equations[j];
        eq.relaxation = relaxation;
        eq.needsUpdate = true;
      }
    }

    // Set for all contact materials
    for (let i = 0; i !== this.contactMaterials.length; i++) {
      const c = this.contactMaterials[i];
      c.relaxation = c.frictionRelaxation = relaxation;
    }

    // Set for default contact material
    const c = this.defaultContactMaterial;
    c.relaxation = c.frictionRelaxation = relaxation;
  }

  /**
   * Ray cast against all bodies in the world.
   */
  raycast(
    result: RaycastResult,
    ray: Ray,
    shouldAddBodies: boolean = true
  ): boolean {
    // Get all bodies within the ray AABB
    ray.getAABB(tmpAABB);
    this.broadphase.aabbQuery(this, tmpAABB, tmpArray, shouldAddBodies);
    ray.intersectBodies(result, tmpArray);
    tmpArray.length = 0;

    return result.hasHit();
  }
}
