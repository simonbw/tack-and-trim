import { V2d, CompatibleVector } from "../../Vector";
import RaycastResult from "../collision/RaycastResult";
import Ray from "../collision/Ray";
import AABB from "../collision/AABB";
import EventEmitter from "../events/EventEmitter";
import type Shape from "../shapes/Shape";
import type World from "../world/World";


export interface BodyOptions {
  force?: CompatibleVector;
  position?: CompatibleVector;
  velocity?: CompatibleVector;
  allowSleep?: boolean;
  collisionResponse?: boolean;
  angle?: number;
  angularForce?: number;
  angularVelocity?: number;
  ccdIterations?: number;
  ccdSpeedThreshold?: number;
  fixedRotation?: boolean;
  fixedX?: boolean;
  fixedY?: boolean;
  gravityScale?: number;
  id?: number;
  mass?: number;
  sleepSpeedLimit?: number;
  sleepTimeLimit?: number;
  damping?: number;
  angularDamping?: number;
  type?: number;
}

// Module-level temp vectors for performance
const shapeAABB = new AABB();
const tmp = new V2d(0, 0);
const Body_applyForce_r = new V2d(0, 0);
const Body_applyForce_forceWorld = new V2d(0, 0);
const Body_applyForce_pointWorld = new V2d(0, 0);
const Body_applyForce_pointLocal = new V2d(0, 0);
const Body_applyImpulse_velo = new V2d(0, 0);
const Body_applyImpulse_impulseWorld = new V2d(0, 0);
const Body_applyImpulse_pointWorld = new V2d(0, 0);
const Body_applyImpulse_pointLocal = new V2d(0, 0);
const adjustCenterOfMass_tmp1 = new V2d(0, 0);
const adjustCenterOfMass_tmp2 = new V2d(0, 0);
const adjustCenterOfMass_tmp3 = new V2d(0, 0);
const adjustCenterOfMass_tmp4 = new V2d(0, 0);
const integrate_fhMinv = new V2d(0, 0);
const integrate_velodt = new V2d(0, 0);
const result = new RaycastResult();
const ray = new Ray({ mode: Ray.ALL });
const direction = new V2d(0, 0);
const end = new V2d(0, 0);
const startToEnd = new V2d(0, 0);
const rememberPosition = new V2d(0, 0);

/**
 * A rigid body. Has got a center of mass, position, velocity and a number of
 * shapes that are used for collisions.
 */
export default class Body extends EventEmitter {
  static _idCounter = 0;

  // Body type constants
  static readonly DYNAMIC = 1;
  static readonly STATIC = 2;
  static readonly KINEMATIC = 4;

  // Sleep state constants
  static readonly AWAKE = 0;
  static readonly SLEEPY = 1;
  static readonly SLEEPING = 2;

  // Events
  static sleepyEvent = { type: "sleepy" };
  static sleepEvent = { type: "sleep" };
  static wakeUpEvent = { type: "wakeup" };

  id: number;
  world: World | null = null;
  shapes: Shape[] = [];
  mass: number;
  invMass: number = 0;
  inertia: number = 0;
  invInertia: number = 0;
  invMassSolve: number = 0;
  invInertiaSolve: number = 0;
  fixedRotation: boolean;
  fixedX: boolean;
  fixedY: boolean;
  massMultiplier: V2d;
  position: V2d;
  interpolatedPosition: V2d;
  interpolatedAngle: number = 0;
  previousPosition: V2d;
  previousAngle: number = 0;
  velocity: V2d;
  vlambda: V2d;
  wlambda: number = 0;
  angle: number;
  angularVelocity: number;
  force: V2d;
  angularForce: number;
  damping: number;
  angularDamping: number;
  type: number;
  boundingRadius: number = 0;
  aabb: AABB;
  aabbNeedsUpdate: boolean = true;
  allowSleep: boolean;
  wantsToSleep: boolean = false;
  sleepState: number;
  sleepSpeedLimit: number;
  sleepTimeLimit: number;
  gravityScale: number;
  collisionResponse: boolean;
  idleTime: number = 0;
  timeLastSleepy: number = 0;
  ccdSpeedThreshold: number;
  ccdIterations: number;
  concavePath: V2d[] | null = null;
  _wakeUpAfterNarrowphase: boolean = false;

  constructor(options: BodyOptions = {}) {
    super();

    this.id = options.id || ++Body._idCounter;
    this.mass = options.mass || 0;
    this.fixedRotation = !!options.fixedRotation;
    this.fixedX = !!options.fixedX;
    this.fixedY = !!options.fixedY;
    this.massMultiplier = new V2d(0, 0);

    this.position = new V2d(0, 0);
    if (options.position) {
      this.position.set(options.position);
    }

    this.interpolatedPosition = new V2d(0, 0);
    this.previousPosition = new V2d(0, 0);

    this.velocity = new V2d(0, 0);
    if (options.velocity) {
      this.velocity.set(options.velocity);
    }

    this.vlambda = new V2d(0, 0);
    this.angle = options.angle || 0;
    this.angularVelocity = options.angularVelocity || 0;

    this.force = new V2d(0, 0);
    if (options.force) {
      this.force.set(options.force);
    }

    this.angularForce = options.angularForce || 0;
    this.damping =
      typeof options.damping === "number" ? options.damping : 0.1;
    this.angularDamping =
      typeof options.angularDamping === "number" ? options.angularDamping : 0.1;

    this.type = Body.STATIC;
    if (typeof options.type !== "undefined") {
      this.type = options.type;
    } else if (!options.mass) {
      this.type = Body.STATIC;
    } else {
      this.type = Body.DYNAMIC;
    }

    this.aabb = new AABB();
    this.allowSleep =
      options.allowSleep !== undefined ? options.allowSleep : true;
    this.sleepState = Body.AWAKE;
    this.sleepSpeedLimit =
      options.sleepSpeedLimit !== undefined ? options.sleepSpeedLimit : 0.2;
    this.sleepTimeLimit =
      options.sleepTimeLimit !== undefined ? options.sleepTimeLimit : 1;
    this.gravityScale =
      options.gravityScale !== undefined ? options.gravityScale : 1;
    this.collisionResponse =
      options.collisionResponse !== undefined ? options.collisionResponse : true;
    this.ccdSpeedThreshold =
      options.ccdSpeedThreshold !== undefined ? options.ccdSpeedThreshold : -1;
    this.ccdIterations =
      options.ccdIterations !== undefined ? options.ccdIterations : 10;

    this.updateMassProperties();
  }

  /**
   * @private
   */
  updateSolveMassProperties(): void {
    if (this.sleepState === Body.SLEEPING || this.type === Body.KINEMATIC) {
      this.invMassSolve = 0;
      this.invInertiaSolve = 0;
    } else {
      this.invMassSolve = this.invMass;
      this.invInertiaSolve = this.invInertia;
    }
  }

  /**
   * Set the total density of the body
   */
  setDensity(density: number): void {
    const totalArea = this.getArea();
    this.mass = totalArea * density;
    this.updateMassProperties();
  }

  /**
   * Get the total area of all shapes in the body
   */
  getArea(): number {
    let totalArea = 0;
    for (let i = 0; i < this.shapes.length; i++) {
      totalArea += this.shapes[i].area;
    }
    return totalArea;
  }

  /**
   * Get the AABB from the body. The AABB is updated if necessary.
   */
  getAABB(): AABB {
    if (this.aabbNeedsUpdate) {
      this.updateAABB();
    }
    return this.aabb;
  }

  /**
   * Updates the AABB of the Body, and set .aabbNeedsUpdate = false.
   */
  updateAABB(): void {
    const shapes = this.shapes;
    const N = shapes.length;
    const offset = tmp;
    const bodyAngle = this.angle;

    for (let i = 0; i !== N; i++) {
      const shape = shapes[i];
      const angle = shape.angle + bodyAngle;

      // Get shape world offset
      offset.set(shape.position).irotate(bodyAngle);
      offset.iadd(this.position);

      // Get shape AABB
      shape.computeAABB(shapeAABB, offset, angle);

      if (i === 0) {
        this.aabb.copy(shapeAABB);
      } else {
        this.aabb.extend(shapeAABB);
      }
    }

    this.aabbNeedsUpdate = false;
  }

  /**
   * Update the bounding radius of the body (this.boundingRadius).
   * Should be done if any of the shape dimensions or positions are changed.
   */
  updateBoundingRadius(): void {
    const shapes = this.shapes;
    const N = shapes.length;
    let radius = 0;

    for (let i = 0; i !== N; i++) {
      const shape = shapes[i];
      const offset = shape.position.magnitude;
      const r = shape.boundingRadius;
      if (offset + r > radius) {
        radius = offset + r;
      }
    }

    this.boundingRadius = radius;
  }

  /**
   * Add a shape to the body. You can pass a local transform when adding a shape,
   * so that the shape gets an offset and angle relative to the body center of mass.
   * Will automatically update the mass properties and bounding radius.
   */
  addShape(shape: Shape, offset?: CompatibleVector, angle?: number): void {
    if (shape.body) {
      throw new Error("A shape can only be added to one body.");
    }
    shape.body = this;

    // Copy the offset vector
    if (offset) {
      shape.position.set(offset);
    } else {
      shape.position.set(0, 0);
    }

    shape.angle = angle || 0;

    this.shapes.push(shape);
    this.updateMassProperties();
    this.updateBoundingRadius();

    this.aabbNeedsUpdate = true;
  }

  /**
   * Remove a shape
   */
  removeShape(shape: Shape): boolean {
    const idx = this.shapes.indexOf(shape);

    if (idx !== -1) {
      this.shapes.splice(idx, 1);
      this.aabbNeedsUpdate = true;
      shape.body = null;
      return true;
    } else {
      return false;
    }
  }

  /**
   * Updates .inertia, .invMass, .invInertia for this Body. Should be called when
   * changing the structure or mass of the Body.
   */
  updateMassProperties(): void {
    if (this.type === Body.STATIC || this.type === Body.KINEMATIC) {
      this.mass = Number.MAX_VALUE;
      this.invMass = 0;
      this.inertia = Number.MAX_VALUE;
      this.invInertia = 0;
    } else {
      const shapes = this.shapes;
      const N = shapes.length;
      const m = this.mass / N;
      let I = 0;

      if (!this.fixedRotation) {
        for (let i = 0; i < N; i++) {
          const shape = shapes[i];
          const r2 = shape.position.squaredMagnitude;
          const Icm = shape.computeMomentOfInertia(m);
          I += Icm + m * r2;
        }
        this.inertia = I;
        this.invInertia = I > 0 ? 1 / I : 0;
      } else {
        this.inertia = Number.MAX_VALUE;
        this.invInertia = 0;
      }

      // Inverse mass properties are easy
      this.invMass = 1 / this.mass;

      this.massMultiplier.set(this.fixedX ? 0 : 1, this.fixedY ? 0 : 1);
    }
  }

  /**
   * Apply force to a point relative to the center of mass of the body.
   * This could for example be a point on the RigidBody surface.
   * Applying force this way will add to Body.force and Body.angularForce.
   * If relativePoint is zero, the force will be applied directly on the center
   * of mass, and the torque produced will be zero.
   */
  applyForce(force: V2d, relativePoint?: V2d): void {
    // Add linear force
    this.force.iadd(force);

    if (relativePoint) {
      // Compute produced rotational force
      const rotForce = relativePoint.crossLength(force);

      // Add rotational force
      this.angularForce += rotForce;
    }
  }

  /**
   * Apply force to a body-local point.
   */
  applyForceLocal(localForce: V2d, localPoint?: V2d): void {
    localPoint = localPoint || Body_applyForce_pointLocal;
    const worldForce = Body_applyForce_forceWorld;
    const worldPoint = Body_applyForce_pointWorld;
    this.vectorToWorldFrame(worldForce, localForce);
    this.vectorToWorldFrame(worldPoint, localPoint);
    this.applyForce(worldForce, worldPoint);
  }

  /**
   * Apply impulse to a point relative to the body. This could for example be a
   * point on the Body surface. An impulse is a force added to a body during a
   * short period of time (impulse = force * time). Impulses will be added to
   * Body.velocity and Body.angularVelocity.
   */
  applyImpulse(impulseVector: V2d, relativePoint?: V2d): void {
    if (this.type !== Body.DYNAMIC) {
      return;
    }

    // Compute produced central impulse velocity
    const velo = Body_applyImpulse_velo;
    velo.set(impulseVector).imul(this.invMass);
    velo.imulComponent(this.massMultiplier);

    // Add linear impulse
    this.velocity.iadd(velo);

    if (relativePoint) {
      // Compute produced rotational impulse velocity
      let rotVelo = relativePoint.crossLength(impulseVector);
      rotVelo *= this.invInertia;

      // Add rotational Impulse
      this.angularVelocity += rotVelo;
    }
  }

  /**
   * Apply impulse to a body-local point.
   */
  applyImpulseLocal(localImpulse: V2d, localPoint?: V2d): void {
    localPoint = localPoint || Body_applyImpulse_pointLocal;
    const worldImpulse = Body_applyImpulse_impulseWorld;
    const worldPoint = Body_applyImpulse_pointWorld;
    this.vectorToWorldFrame(worldImpulse, localImpulse);
    this.vectorToWorldFrame(worldPoint, localPoint);
    this.applyImpulse(worldImpulse, worldPoint);
  }

  /**
   * Transform a world point to local body frame.
   */
  toLocalFrame(out: V2d, worldPoint: V2d): void {
    out.set(worldPoint).itoLocalFrame(this.position, this.angle);
  }

  /**
   * Transform a local point to world frame.
   */
  toWorldFrame(out: V2d, localPoint: V2d): void {
    out.set(localPoint).itoGlobalFrame(this.position, this.angle);
  }

  /**
   * Transform a world vector to local body frame.
   */
  vectorToLocalFrame(out: V2d, worldVector: V2d): void {
    out.set(worldVector).irotate(-this.angle);
  }

  /**
   * Transform a local vector to world frame.
   */
  vectorToWorldFrame(out: V2d, localVector: V2d): void {
    out.set(localVector).irotate(this.angle);
  }

  /**
   * Reads a polygon shape path, and assembles convex shapes from that and puts
   * them at proper offset points.
   * @deprecated This method requires poly-decomp which is not included. Use Convex shapes directly instead.
   */
  fromPolygon(
    _path: V2d[],
    _options: {
      optimalDecomp?: boolean;
      skipSimpleCheck?: boolean;
      removeCollinearPoints?: boolean | number;
    } = {}
  ): boolean {
    throw new Error(
      "fromPolygon requires poly-decomp library which is not included. Use Convex shapes directly instead."
    );
  }

  /**
   * Moves the shape offsets so their center of mass becomes the body center of mass.
   */
  adjustCenterOfMass(): void {
    const offset_times_area = adjustCenterOfMass_tmp2;
    const sum = adjustCenterOfMass_tmp3;
    const cm = adjustCenterOfMass_tmp4;
    let totalArea = 0;
    sum.set(0, 0);

    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      offset_times_area.set(s.position).imul(s.area);
      sum.iadd(offset_times_area);
      totalArea += s.area;
    }

    cm.set(sum).imul(1 / totalArea);

    // Now move all shapes
    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      s.position.isub(cm);
    }

    // Move the body position too
    this.position.iadd(cm);

    // And concave path
    for (let i = 0; this.concavePath && i < this.concavePath.length; i++) {
      this.concavePath[i].isub(cm);
    }

    this.updateMassProperties();
    this.updateBoundingRadius();
  }

  /**
   * Sets the force on the body to zero.
   */
  setZeroForce(): void {
    this.force.set(0.0, 0.0);
    this.angularForce = 0.0;
  }

  resetConstraintVelocity(): void {
    const vlambda = this.vlambda;
    vlambda.set(0, 0);
    this.wlambda = 0;
  }

  addConstraintVelocity(): void {
    const v = this.velocity;
    v.iadd(this.vlambda);
    this.angularVelocity += this.wlambda;
  }

  /**
   * Apply damping, see http://code.google.com/p/bullet/issues/detail?id=74 for details.
   */
  applyDamping(dt: number): void {
    if (this.type === Body.DYNAMIC) {
      // Only for dynamic bodies
      const v = this.velocity;
      v.imul(Math.pow(1.0 - this.damping, dt));
      this.angularVelocity *= Math.pow(1.0 - this.angularDamping, dt);
    }
  }

  /**
   * Wake the body up. Normally you should not need this, as the body is
   * automatically awoken at events such as collisions.
   * Sets the sleepState to Body.AWAKE and emits the wakeUp event if the
   * body wasn't awake before.
   */
  wakeUp(): void {
    const s = this.sleepState;
    this.sleepState = Body.AWAKE;
    this.idleTime = 0;
    if (s !== Body.AWAKE) {
      this.emit(Body.wakeUpEvent);
    }
  }

  /**
   * Force body sleep
   */
  sleep(): void {
    this.sleepState = Body.SLEEPING;
    this.angularVelocity = 0;
    this.angularForce = 0;
    this.velocity.set(0, 0);
    this.force.set(0, 0);
    this.emit(Body.sleepEvent);
  }

  /**
   * Called every timestep to update internal sleep timer and change sleep state if needed.
   */
  sleepTick(time: number, dontSleep: boolean, dt: number): void {
    if (!this.allowSleep || this.type === Body.SLEEPING) {
      return;
    }

    this.wantsToSleep = false;

    const sleepState = this.sleepState;
    const speedSquared =
      this.velocity.squaredMagnitude + Math.pow(this.angularVelocity, 2);
    const speedLimitSquared = Math.pow(this.sleepSpeedLimit, 2);

    // Add to idle time
    if (speedSquared >= speedLimitSquared) {
      this.idleTime = 0;
      this.sleepState = Body.AWAKE;
    } else {
      this.idleTime += dt;
      this.sleepState = Body.SLEEPY;
    }
    if (this.idleTime > this.sleepTimeLimit) {
      if (!dontSleep) {
        this.sleep();
      } else {
        this.wantsToSleep = true;
      }
    }
  }

  /**
   * Check if the body is overlapping another body.
   * Note that this method only works if the body was added to a World
   * and if at least one step was taken.
   */
  overlaps(body: Body): boolean {
    return this.world!.overlapKeeper.bodiesAreOverlapping(this, body);
  }

  /**
   * Move the body forward in time given its current velocity.
   */
  integrate(dt: number): void {
    const minv = this.invMass;
    const f = this.force;
    const pos = this.position;
    const velo = this.velocity;

    // Save old position
    this.previousPosition.set(this.position);
    this.previousAngle = this.angle;

    // Velocity update
    if (!this.fixedRotation) {
      this.angularVelocity += this.angularForce * this.invInertia * dt;
    }
    integrate_fhMinv.set(f).imul(dt * minv);
    integrate_fhMinv.imulComponent(this.massMultiplier);
    velo.iadd(integrate_fhMinv);

    // CCD
    if (!this.integrateToTimeOfImpact(dt)) {
      // Regular position update
      integrate_velodt.set(velo).imul(dt);
      pos.iadd(integrate_velodt);
      if (!this.fixedRotation) {
        this.angle += this.angularVelocity * dt;
      }
    }

    this.aabbNeedsUpdate = true;
  }

  integrateToTimeOfImpact(dt: number): boolean {
    if (
      this.ccdSpeedThreshold < 0 ||
      this.velocity.squaredMagnitude < Math.pow(this.ccdSpeedThreshold, 2)
    ) {
      return false;
    }

    direction.set(this.velocity).inormalize();

    end.set(this.velocity).imul(dt);
    end.iadd(this.position);

    startToEnd.set(end).isub(this.position);
    const startToEndAngle = this.angularVelocity * dt;
    const len = startToEnd.magnitude;

    let timeOfImpact = 1;

    let hit: Body | null = null;
    const that = this;
    result.reset();
    ray.callback = function (res: RaycastResult) {
      if (res.body === that) {
        return;
      }
      hit = res.body;
      res.getHitPoint(end, ray);
      startToEnd.set(end).isub(that.position);
      timeOfImpact = startToEnd.magnitude / len;
      res.stop();
    };
    ray.from.set(this.position);
    ray.to.set(end);
    ray.update();
    this.world!.raycast(result, ray);

    if (!hit) {
      return false;
    }

    // TypeScript narrowing helper - hit is guaranteed non-null after the check above
    const hitBody: Body = hit;

    const rememberAngle = this.angle;
    rememberPosition.set(this.position);

    // Got a start and end point. Approximate time of impact using binary search
    let iter = 0;
    let tmin = 0;
    let tmid = 0;
    let tmax = timeOfImpact;
    while (tmax >= tmin && iter < this.ccdIterations) {
      iter++;

      // calculate the midpoint
      tmid = (tmax - tmin) / 2;

      // Move the body to that point
      integrate_velodt.set(startToEnd).imul(timeOfImpact);
      this.position.set(rememberPosition).iadd(integrate_velodt);
      this.angle = rememberAngle + startToEndAngle * timeOfImpact;
      this.updateAABB();

      // check overlap
      const overlaps =
        this.aabb.overlaps(hitBody.aabb) &&
        this.world!.narrowphase.bodiesOverlap(this, hitBody);

      if (overlaps) {
        // change min to search upper interval
        tmin = tmid;
      } else {
        // change max to search lower interval
        tmax = tmid;
      }
    }

    timeOfImpact = tmid;

    this.position.set(rememberPosition);
    this.angle = rememberAngle;

    // move to TOI
    integrate_velodt.set(startToEnd).imul(timeOfImpact);
    this.position.iadd(integrate_velodt);
    if (!this.fixedRotation) {
      this.angle += startToEndAngle * timeOfImpact;
    }

    return true;
  }

  /**
   * Get velocity of a point in the body.
   */
  getVelocityAtPoint(result: V2d, relativePoint: V2d): V2d {
    result.set(relativePoint).icrossVZ(this.angularVelocity);
    result.set(this.velocity).isub(result);
    return result;
  }
}
