import { CompatibleVector, V, V2d } from "../../Vector";
import Body, { SleepState } from "../body/Body";
import DynamicBody from "../body/DynamicBody";
import KinematicBody from "../body/KinematicBody";
import StaticBody from "../body/StaticBody";
import AABB from "../collision/AABB";
import Broadphase from "../collision/broadphase/Broadphase";
import SpatialHashingBroadphase from "../collision/broadphase/SpatialHashingBroadphase";
import Narrowphase from "../collision/narrowphase/Narrowphase";
import Ray, { RayMode } from "../collision/raycast/Ray";
import { RaycastHit, RaycastOptions } from "../collision/raycast/RaycastHit";
import RaycastResult from "../collision/raycast/RaycastResult";
import Constraint from "../constraints/Constraint";
import type ContactEquation from "../equations/ContactEquation";
import EventEmitter from "../events/EventEmitter";
import { PhysicsEventMap } from "../events/PhysicsEvents";
import ContactMaterial from "../material/ContactMaterial";
import Material from "../material/Material";
import Shape from "../shapes/Shape";
import GSSolver from "../solver/GSSolver";
import Solver from "../solver/Solver";
import type Spring from "../springs/Spring";
import OverlapKeeper from "../utils/OverlapKeeper";
import type OverlapKeeperRecord from "../utils/OverlapKeeperRecord";
import IslandManager from "./IslandManager";

export interface WorldOptions {
  solver?: Solver;
  gravity?: CompatibleVector;
  broadphase?: Broadphase;
  islandSplit?: boolean;
}

export enum SleepMode {
  NO_SLEEPING = 1,
  BODY_SLEEPING = 2,
  ISLAND_SLEEPING = 4,
}

/**
 * The dynamics world, where all bodies and constraints live.
 */
export default class World extends EventEmitter<PhysicsEventMap> {
  springs: Spring[] = [];
  bodies: Body[] = [];
  dynamicBodies: Set<DynamicBody> = new Set();
  kinematicBodies: Set<KinematicBody> = new Set();
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
  sleepMode: SleepMode;
  overlapKeeper: OverlapKeeper;

  // Internal reusable objects for raycast API
  private _ray: Ray = new Ray();
  private _raycastResult: RaycastResult = new RaycastResult();

  constructor(options: WorldOptions = {}) {
    super();

    this.solver = options.solver || new GSSolver();
    this.solver.setWorld(this);
    this.narrowphase = new Narrowphase(this);
    this.islandManager = new IslandManager();

    this.gravity = V(0, -9.78);
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

    this.islandSplit = options.islandSplit ?? false;

    // Disable automatic gravity and damping - let game code apply these
    this.applyGravity = false;
    this.applyDamping = false;

    this.sleepMode = SleepMode.NO_SLEEPING;
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
      this.contactMaterials.splice(idx, 1);
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
      this.constraints.splice(idx, 1);
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
        if (!(b instanceof DynamicBody) || b.sleepState === SleepState.SLEEPING) {
          continue;
        }
        const mg = V(g).imul(b.mass * b.gravityScale);
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
        if (b instanceof DynamicBody) {
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
    this.emit({ type: "postBroadphase", pairs: result });

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
      const endOverlaps: OverlapKeeperRecord[] = [];
      this.overlapKeeper.getEndOverlaps(endOverlaps);
      for (let i = endOverlaps.length - 1; i >= 0; i--) {
        const data = endOverlaps[i];
        // These should never be null in practice, but OverlapKeeperRecord allows null
        if (data.shapeA && data.shapeB && data.bodyA && data.bodyB) {
          this.emit({
            type: "endContact",
            shapeA: data.shapeA,
            shapeB: data.shapeB,
            bodyA: data.bodyA,
            bodyB: data.bodyB,
          });
        }
      }
    }

    this.emit({
      type: "preSolve",
      contactEquations: np.contactEquations,
      frictionEquations: np.frictionEquations,
    });

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
        islandManager.equations.push(...np.contactEquations);
        islandManager.equations.push(...np.frictionEquations);
        for (let i = 0; i !== Nconstraints; i++) {
          islandManager.equations.push(...constraints[i].equations);
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
      for (let i = 0; i !== np.contactEquations.length; i++) {
        const eq = np.contactEquations[i];
        if (eq.firstImpact && eq.shapeA && eq.shapeB) {
          this.emit({
            type: "impact",
            bodyA: eq.bodyA,
            bodyB: eq.bodyB,
            shapeA: eq.shapeA,
            shapeB: eq.shapeB,
            contactEquation: eq,
          });
        }
      }
    }

    // Sleeping update
    if (this.sleepMode === SleepMode.BODY_SLEEPING) {
      for (let i = 0; i !== Nbodies; i++) {
        bodies[i].sleepTick(this.time, false, dt);
      }
    } else if (this.sleepMode === SleepMode.ISLAND_SLEEPING && this.islandSplit) {
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

    this.emit({ type: "postStep" });
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
    const xiw = V(xi).irotate(bi.angle).iadd(bi.position);
    const xjw = V(xj).irotate(bj.angle).iadd(bj.position);
    const aiw = ai + bi.angle;
    const ajw = aj + bj.angle;

    // Configure narrowphase parameters from contact material
    np.enableFriction = cm.friction > 0;
    np.frictionCoefficient = cm.friction;
    let reducedMass: number;
    if (bi instanceof StaticBody || bi instanceof KinematicBody) {
      reducedMass = bj.mass;
    } else if (bj instanceof StaticBody || bj instanceof KinematicBody) {
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

    // Skip actual collision if either shape is a sensor
    const sensor = si.sensor || sj.sensor;
    if (sensor) {
      // For sensors, just check overlap without generating equations
      if (np.bodiesOverlap(bi, bj)) {
        this.overlapKeeper.setOverlapping(bi, si, bj, sj);
        if (
          this.has("beginContact") &&
          this.overlapKeeper.isNewOverlap(si, sj)
        ) {
          this.emit({
            type: "beginContact",
            shapeA: si,
            shapeB: sj,
            bodyA: bi,
            bodyB: bj,
            contactEquations: [],
          });
        }
      }
      return;
    }

    // Run collision detection and generate equations
    const numFrictionBefore = np.frictionEquations.length;
    const numContacts = np.collideShapes(bi, si, xiw, aiw, bj, sj, xjw, ajw);

    if (numContacts) {
      const numFrictionEquations =
        np.frictionEquations.length - numFrictionBefore;

      // Wake up sleeping bodies if needed
      if (
        bi.allowSleep &&
        bi instanceof DynamicBody &&
        bi.sleepState === SleepState.SLEEPING &&
        bj.sleepState === SleepState.AWAKE &&
        !(bj instanceof StaticBody)
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
        bj instanceof DynamicBody &&
        bj.sleepState === SleepState.SLEEPING &&
        bi.sleepState === SleepState.AWAKE &&
        !(bi instanceof StaticBody)
      ) {
        const speedSquaredA =
          bi.velocity.squaredMagnitude + Math.pow(bi.angularVelocity, 2);
        const speedLimitSquaredA = Math.pow(bi.sleepSpeedLimit, 2);
        if (speedSquaredA >= speedLimitSquaredA * 2) {
          bj._wakeUpAfterNarrowphase = true;
        }
      }

      // Track overlapping shapes
      this.overlapKeeper.setOverlapping(bi, si, bj, sj);
      if (this.has("beginContact") && this.overlapKeeper.isNewOverlap(si, sj)) {
        // Report new shape overlap
        const contactEquations: ContactEquation[] = [];
        for (
          let i = np.contactEquations.length - numContacts;
          i < np.contactEquations.length;
          i++
        ) {
          contactEquations.push(np.contactEquations[i]);
        }

        this.emit({
          type: "beginContact",
          shapeA: si,
          shapeB: sj,
          bodyA: bi,
          bodyB: bj,
          contactEquations,
        });
      }

      // Divide the max friction force by the number of contacts
      if (numFrictionEquations > 1) {
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

  /**
   * Add a spring to the simulation
   */
  addSpring(spring: Spring): void {
    this.springs.push(spring);
    this.emit({ type: "addSpring", spring });
  }

  /**
   * Remove a spring
   */
  removeSpring(spring: Spring): void {
    const idx = this.springs.indexOf(spring);
    if (idx !== -1) {
      this.springs.splice(idx, 1);
    }
  }

  /**
   * Add a body to the simulation
   */
  addBody(body: Body): void {
    if (this.bodies.indexOf(body) === -1) {
      this.bodies.push(body);
      body.world = this;

      if (body instanceof DynamicBody) {
        this.dynamicBodies.add(body);
      } else if (body instanceof KinematicBody) {
        this.kinematicBodies.add(body);
      }

      this.emit({ type: "addBody", body });
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
        this.bodies.splice(idx, 1);

        if (body instanceof DynamicBody) {
          this.dynamicBodies.delete(body);
        } else if (body instanceof KinematicBody) {
          this.kinematicBodies.delete(body);
        }

        body.resetConstraintVelocity();
        this.emit({ type: "removeBody", body });
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
   * Cast a ray and return the closest hit, or null if nothing was hit.
   *
   * @param from - Start point of the ray
   * @param to - End point of the ray
   * @param options - Optional raycast configuration
   * @returns The closest hit, or null if nothing was hit
   *
   * @example
   * ```typescript
   * const hit = world.raycast([x1, y1], [x2, y2]);
   * if (hit) {
   *   console.log(hit.body, hit.point, hit.normal, hit.distance);
   * }
   * ```
   */
  raycast(
    from: CompatibleVector,
    to: CompatibleVector,
    options?: RaycastOptions
  ): RaycastHit | null {
    const ray = this._ray;
    const result = this._raycastResult;

    // Configure ray
    ray.from.set(from[0], from[1]);
    ray.to.set(to[0], to[1]);
    ray.mode = RayMode.CLOSEST;
    ray.update();

    // Apply options
    if (options?.collisionMask !== undefined) {
      ray.collisionMask = options.collisionMask;
    } else {
      ray.collisionMask = -1; // Default: collide with everything
    }
    ray.skipBackfaces = options?.skipBackfaces ?? false;

    // Reset and perform raycast
    result.reset();
    this._raycastInternal(result, ray);

    // Apply custom filter if provided (need to re-check since internal raycast doesn't know about it)
    if (result.hasHit() && options?.filter) {
      if (!options.filter(result.body!, result.shape!)) {
        return null;
      }
    }

    // Return clean result object
    if (result.hasHit()) {
      return {
        body: result.body!,
        shape: result.shape!,
        point: result.getHitPoint(ray),
        normal: V(result.normal),
        distance: result.getHitDistance(ray),
        fraction: result.fraction!,
      };
    }
    return null;
  }

  /**
   * Cast a ray and return all hits, sorted by distance (closest first).
   *
   * @param from - Start point of the ray
   * @param to - End point of the ray
   * @param options - Optional raycast configuration
   * @returns Array of all hits, sorted by distance
   *
   * @example
   * ```typescript
   * const hits = world.raycastAll([x1, y1], [x2, y2]);
   * for (const hit of hits) {
   *   console.log(hit.body, hit.point);
   * }
   * ```
   */
  raycastAll(
    from: CompatibleVector,
    to: CompatibleVector,
    options?: RaycastOptions
  ): RaycastHit[] {
    const ray = this._ray;
    const result = this._raycastResult;
    const hits: RaycastHit[] = [];

    // Configure ray
    ray.from.set(from[0], from[1]);
    ray.to.set(to[0], to[1]);
    ray.mode = RayMode.ALL;
    ray.update();

    // Apply options
    if (options?.collisionMask !== undefined) {
      ray.collisionMask = options.collisionMask;
    } else {
      ray.collisionMask = -1;
    }
    ray.skipBackfaces = options?.skipBackfaces ?? false;

    // Store original callback
    const originalCallback = ray.callback;

    // Use callback to collect all hits
    ray.callback = (res: RaycastResult) => {
      // Apply custom filter if provided
      if (options?.filter && !options.filter(res.body!, res.shape!)) {
        return;
      }

      hits.push({
        body: res.body!,
        shape: res.shape!,
        point: res.getHitPoint(ray),
        normal: V(res.normal),
        distance: res.getHitDistance(ray),
        fraction: res.fraction!,
      });
    };

    // Reset and perform raycast
    result.reset();
    this._raycastInternal(result, ray);

    // Restore original callback
    ray.callback = originalCallback;

    // Sort by distance (closest first)
    hits.sort((a, b) => a.distance - b.distance);

    return hits;
  }

  /**
   * Internal raycast implementation.
   */
  private _raycastInternal(
    result: RaycastResult,
    ray: Ray,
    shouldAddBodies: boolean = true
  ): boolean {
    // Get all bodies within the ray AABB
    const tmpAABB = new AABB();
    const tmpArray: Body[] = [];
    ray.getAABB(tmpAABB);
    this.broadphase.aabbQuery(this, tmpAABB, tmpArray, shouldAddBodies);
    ray.intersectBodies(result, tmpArray);

    return result.hasHit();
  }
}
