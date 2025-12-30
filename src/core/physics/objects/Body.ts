import vec2, { Vec2 } from "../math/vec2";
import RaycastResult from "../collision/RaycastResult";
import Ray from "../collision/Ray";
import AABB from "../collision/AABB";
import EventEmitter from "../events/EventEmitter";
import type Shape from "../shapes/Shape";
import type World from "../world/World";


export interface BodyOptions {
  force?: Vec2;
  position?: Vec2;
  velocity?: Vec2;
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
const tmp = vec2.create();
const Body_applyForce_r = vec2.create();
const Body_applyForce_forceWorld = vec2.create();
const Body_applyForce_pointWorld = vec2.create();
const Body_applyForce_pointLocal = vec2.create();
const Body_applyImpulse_velo = vec2.create();
const Body_applyImpulse_impulseWorld = vec2.create();
const Body_applyImpulse_pointWorld = vec2.create();
const Body_applyImpulse_pointLocal = vec2.create();
const adjustCenterOfMass_tmp1 = vec2.fromValues(0, 0);
const adjustCenterOfMass_tmp2 = vec2.fromValues(0, 0);
const adjustCenterOfMass_tmp3 = vec2.fromValues(0, 0);
const adjustCenterOfMass_tmp4 = vec2.fromValues(0, 0);
const integrate_fhMinv = vec2.create();
const integrate_velodt = vec2.create();
const result = new RaycastResult();
const ray = new Ray({ mode: Ray.ALL });
const direction = vec2.create();
const end = vec2.create();
const startToEnd = vec2.create();
const rememberPosition = vec2.create();

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
  massMultiplier: Vec2;
  position: Vec2;
  interpolatedPosition: Vec2;
  interpolatedAngle: number = 0;
  previousPosition: Vec2;
  previousAngle: number = 0;
  velocity: Vec2;
  vlambda: Vec2;
  wlambda: number = 0;
  angle: number;
  angularVelocity: number;
  force: Vec2;
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
  concavePath: Vec2[] | null = null;
  _wakeUpAfterNarrowphase: boolean = false;

  constructor(options: BodyOptions = {}) {
    super();

    this.id = options.id || ++Body._idCounter;
    this.mass = options.mass || 0;
    this.fixedRotation = !!options.fixedRotation;
    this.fixedX = !!options.fixedX;
    this.fixedY = !!options.fixedY;
    this.massMultiplier = vec2.create();

    this.position = vec2.fromValues(0, 0);
    if (options.position) {
      vec2.copy(this.position, options.position);
    }

    this.interpolatedPosition = vec2.fromValues(0, 0);
    this.previousPosition = vec2.fromValues(0, 0);

    this.velocity = vec2.fromValues(0, 0);
    if (options.velocity) {
      vec2.copy(this.velocity, options.velocity);
    }

    this.vlambda = vec2.fromValues(0, 0);
    this.angle = options.angle || 0;
    this.angularVelocity = options.angularVelocity || 0;

    this.force = vec2.create();
    if (options.force) {
      vec2.copy(this.force, options.force);
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
      vec2.rotate(offset, shape.position, bodyAngle);
      vec2.add(offset, offset, this.position);

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
      const offset = vec2.length(shape.position);
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
  addShape(shape: Shape, offset?: Vec2, angle?: number): void {
    if (shape.body) {
      throw new Error("A shape can only be added to one body.");
    }
    shape.body = this;

    // Copy the offset vector
    if (offset) {
      vec2.copy(shape.position, offset);
    } else {
      vec2.set(shape.position, 0, 0);
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
          const r2 = vec2.squaredLength(shape.position);
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

      vec2.set(this.massMultiplier, this.fixedX ? 0 : 1, this.fixedY ? 0 : 1);
    }
  }

  /**
   * Apply force to a point relative to the center of mass of the body.
   * This could for example be a point on the RigidBody surface.
   * Applying force this way will add to Body.force and Body.angularForce.
   * If relativePoint is zero, the force will be applied directly on the center
   * of mass, and the torque produced will be zero.
   */
  applyForce(force: Vec2, relativePoint?: Vec2): void {
    // Add linear force
    vec2.add(this.force, this.force, force);

    if (relativePoint) {
      // Compute produced rotational force
      const rotForce = vec2.crossLength(relativePoint, force);

      // Add rotational force
      this.angularForce += rotForce;
    }
  }

  /**
   * Apply force to a body-local point.
   */
  applyForceLocal(localForce: Vec2, localPoint?: Vec2): void {
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
  applyImpulse(impulseVector: Vec2, relativePoint?: Vec2): void {
    if (this.type !== Body.DYNAMIC) {
      return;
    }

    // Compute produced central impulse velocity
    const velo = Body_applyImpulse_velo;
    vec2.scale(velo, impulseVector, this.invMass);
    vec2.multiply(velo, this.massMultiplier, velo);

    // Add linear impulse
    vec2.add(this.velocity, velo, this.velocity);

    if (relativePoint) {
      // Compute produced rotational impulse velocity
      let rotVelo = vec2.crossLength(relativePoint, impulseVector);
      rotVelo *= this.invInertia;

      // Add rotational Impulse
      this.angularVelocity += rotVelo;
    }
  }

  /**
   * Apply impulse to a body-local point.
   */
  applyImpulseLocal(localImpulse: Vec2, localPoint?: Vec2): void {
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
  toLocalFrame(out: Vec2, worldPoint: Vec2): void {
    vec2.toLocalFrame(out, worldPoint, this.position, this.angle);
  }

  /**
   * Transform a local point to world frame.
   */
  toWorldFrame(out: Vec2, localPoint: Vec2): void {
    vec2.toGlobalFrame(out, localPoint, this.position, this.angle);
  }

  /**
   * Transform a world vector to local body frame.
   */
  vectorToLocalFrame(out: Vec2, worldVector: Vec2): void {
    vec2.vectorToLocalFrame(out, worldVector, this.angle);
  }

  /**
   * Transform a local vector to world frame.
   */
  vectorToWorldFrame(out: Vec2, localVector: Vec2): void {
    vec2.vectorToGlobalFrame(out, localVector, this.angle);
  }

  /**
   * Reads a polygon shape path, and assembles convex shapes from that and puts
   * them at proper offset points.
   * @deprecated This method requires poly-decomp which is not included. Use Convex shapes directly instead.
   */
  fromPolygon(
    _path: Vec2[],
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
    vec2.set(sum, 0, 0);

    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      vec2.scale(offset_times_area, s.position, s.area);
      vec2.add(sum, sum, offset_times_area);
      totalArea += s.area;
    }

    vec2.scale(cm, sum, 1 / totalArea);

    // Now move all shapes
    for (let i = 0; i !== this.shapes.length; i++) {
      const s = this.shapes[i];
      vec2.sub(s.position, s.position, cm);
    }

    // Move the body position too
    vec2.add(this.position, this.position, cm);

    // And concave path
    for (let i = 0; this.concavePath && i < this.concavePath.length; i++) {
      vec2.sub(this.concavePath[i], this.concavePath[i], cm);
    }

    this.updateMassProperties();
    this.updateBoundingRadius();
  }

  /**
   * Sets the force on the body to zero.
   */
  setZeroForce(): void {
    vec2.set(this.force, 0.0, 0.0);
    this.angularForce = 0.0;
  }

  resetConstraintVelocity(): void {
    const vlambda = this.vlambda;
    vec2.set(vlambda, 0, 0);
    this.wlambda = 0;
  }

  addConstraintVelocity(): void {
    const v = this.velocity;
    vec2.add(v, v, this.vlambda);
    this.angularVelocity += this.wlambda;
  }

  /**
   * Apply damping, see http://code.google.com/p/bullet/issues/detail?id=74 for details.
   */
  applyDamping(dt: number): void {
    if (this.type === Body.DYNAMIC) {
      // Only for dynamic bodies
      const v = this.velocity;
      vec2.scale(v, v, Math.pow(1.0 - this.damping, dt));
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
    vec2.set(this.velocity, 0, 0);
    vec2.set(this.force, 0, 0);
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
      vec2.squaredLength(this.velocity) + Math.pow(this.angularVelocity, 2);
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
    vec2.copy(this.previousPosition, this.position);
    this.previousAngle = this.angle;

    // Velocity update
    if (!this.fixedRotation) {
      this.angularVelocity += this.angularForce * this.invInertia * dt;
    }
    vec2.scale(integrate_fhMinv, f, dt * minv);
    vec2.multiply(integrate_fhMinv, this.massMultiplier, integrate_fhMinv);
    vec2.add(velo, integrate_fhMinv, velo);

    // CCD
    if (!this.integrateToTimeOfImpact(dt)) {
      // Regular position update
      vec2.scale(integrate_velodt, velo, dt);
      vec2.add(pos, pos, integrate_velodt);
      if (!this.fixedRotation) {
        this.angle += this.angularVelocity * dt;
      }
    }

    this.aabbNeedsUpdate = true;
  }

  integrateToTimeOfImpact(dt: number): boolean {
    if (
      this.ccdSpeedThreshold < 0 ||
      vec2.squaredLength(this.velocity) < Math.pow(this.ccdSpeedThreshold, 2)
    ) {
      return false;
    }

    vec2.normalize(direction, this.velocity);

    vec2.scale(end, this.velocity, dt);
    vec2.add(end, end, this.position);

    vec2.sub(startToEnd, end, this.position);
    const startToEndAngle = this.angularVelocity * dt;
    const len = vec2.length(startToEnd);

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
      vec2.sub(startToEnd, end, that.position);
      timeOfImpact = vec2.length(startToEnd) / len;
      res.stop();
    };
    vec2.copy(ray.from, this.position);
    vec2.copy(ray.to, end);
    ray.update();
    this.world!.raycast(result, ray);

    if (!hit) {
      return false;
    }

    // TypeScript narrowing helper - hit is guaranteed non-null after the check above
    const hitBody: Body = hit;

    const rememberAngle = this.angle;
    vec2.copy(rememberPosition, this.position);

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
      vec2.scale(integrate_velodt, startToEnd, timeOfImpact);
      vec2.add(this.position, rememberPosition, integrate_velodt);
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

    vec2.copy(this.position, rememberPosition);
    this.angle = rememberAngle;

    // move to TOI
    vec2.scale(integrate_velodt, startToEnd, timeOfImpact);
    vec2.add(this.position, this.position, integrate_velodt);
    if (!this.fixedRotation) {
      this.angle += startToEndAngle * timeOfImpact;
    }

    return true;
  }

  /**
   * Get velocity of a point in the body.
   */
  getVelocityAtPoint(result: Vec2, relativePoint: Vec2): Vec2 {
    vec2.crossVZ(result, relativePoint, this.angularVelocity);
    vec2.subtract(result, this.velocity, result);
    return result;
  }
}
