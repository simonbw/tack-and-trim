import vec2, { Vec2 } from "../math/vec2";
import Constraint from "../constraints/Constraint";
import FrictionEquation from "../equations/FrictionEquation";
import Body from "./Body";
import type World from "../world/World";

export interface WheelOptions {
  localForwardVector?: Vec2;
  localPosition?: Vec2;
  sideFriction?: number;
}

// Module-level temp vectors
const worldVelocity = vec2.create();
const relativePoint = vec2.create();
const tmpVec = vec2.create();

/**
 * A TopDownVehicle for top-down vehicle games.
 */
export default class TopDownVehicle {
  chassisBody: Body;
  wheels: WheelConstraint[] = [];
  groundBody: Body;
  world: World | null = null;
  preStepCallback: () => void;

  constructor(chassisBody: Body) {
    this.chassisBody = chassisBody;

    // A dummy body to constrain the chassis to
    this.groundBody = new Body({ mass: 0 });

    this.preStepCallback = () => {
      this.update();
    };
  }

  addToWorld(world: World): void {
    this.world = world;
    world.addBody(this.groundBody);
    world.on("preStep", this.preStepCallback);
    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      world.addConstraint(wheel);
    }
  }

  removeFromWorld(): void {
    const world = this.world!;
    world.removeBody(this.groundBody);
    world.off("preStep", this.preStepCallback);
    for (let i = 0; i < this.wheels.length; i++) {
      const wheel = this.wheels[i];
      world.removeConstraint(wheel);
    }
    this.world = null;
  }

  addWheel(wheelOptions?: WheelOptions): WheelConstraint {
    const wheel = new WheelConstraint(this, wheelOptions);
    this.wheels.push(wheel);
    return wheel;
  }

  update(): void {
    for (let i = 0; i < this.wheels.length; i++) {
      this.wheels[i].update();
    }
  }
}

/**
 * A wheel constraint for the TopDownVehicle.
 */
export class WheelConstraint extends Constraint {
  vehicle: TopDownVehicle;
  forwardEquation: FrictionEquation;
  sideEquation: FrictionEquation;

  /**
   * Steering angle in radians.
   */
  steerValue: number = 0;

  /**
   * Engine force applied to the wheel.
   */
  engineForce: number = 0;

  /**
   * The local wheel forward vector in local body space.
   */
  localForwardVector: Vec2;

  /**
   * The local position of the wheel in the chassis body.
   */
  localPosition: Vec2;

  constructor(vehicle: TopDownVehicle, options: WheelOptions = {}) {
    super(vehicle.chassisBody, vehicle.groundBody);

    this.vehicle = vehicle;

    this.forwardEquation = new FrictionEquation(
      vehicle.chassisBody,
      vehicle.groundBody
    );

    this.sideEquation = new FrictionEquation(
      vehicle.chassisBody,
      vehicle.groundBody
    );

    this.setSideFriction(
      options.sideFriction !== undefined ? options.sideFriction : 5
    );

    this.localForwardVector = vec2.fromValues(0, 1);
    if (options.localForwardVector) {
      vec2.copy(this.localForwardVector, options.localForwardVector);
    }

    this.localPosition = vec2.fromValues(0, 0);
    if (options.localPosition) {
      vec2.copy(this.localPosition, options.localPosition);
    }

    this.equations.push(this.forwardEquation, this.sideEquation);

    this.setBrakeForce(0);
  }

  setBrakeForce(force: number): void {
    this.forwardEquation.setSlipForce(force);
  }

  setSideFriction(force: number): void {
    this.sideEquation.setSlipForce(force);
  }

  getSpeed(): number {
    this.vehicle.chassisBody.vectorToWorldFrame(
      relativePoint,
      this.localForwardVector
    );
    this.vehicle.chassisBody.getVelocityAtPoint(worldVelocity, relativePoint);
    return vec2.dot(worldVelocity, relativePoint);
  }

  update(): void {
    // Directional
    this.vehicle.chassisBody.vectorToWorldFrame(
      this.forwardEquation.t,
      this.localForwardVector
    );
    vec2.rotate(this.sideEquation.t, this.localForwardVector, Math.PI / 2);
    this.vehicle.chassisBody.vectorToWorldFrame(
      this.sideEquation.t,
      this.sideEquation.t
    );

    vec2.rotate(this.forwardEquation.t, this.forwardEquation.t, this.steerValue);
    vec2.rotate(this.sideEquation.t, this.sideEquation.t, this.steerValue);

    // Attachment point
    this.vehicle.chassisBody.toWorldFrame(
      this.forwardEquation.contactPointB,
      this.localPosition
    );
    vec2.copy(this.sideEquation.contactPointB, this.forwardEquation.contactPointB);

    this.vehicle.chassisBody.vectorToWorldFrame(
      this.forwardEquation.contactPointA,
      this.localPosition
    );
    vec2.copy(this.sideEquation.contactPointA, this.forwardEquation.contactPointA);

    // Add engine force
    vec2.normalize(tmpVec, this.forwardEquation.t);
    vec2.scale(tmpVec, tmpVec, this.engineForce);

    this.vehicle.chassisBody.applyForce(tmpVec, this.forwardEquation.contactPointA);
  }
}
