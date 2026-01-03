import { CompatibleVector } from "../../Vector";
import { SleepState } from "../body/Body";
import DynamicBody from "../body/DynamicBody";
import StaticBody from "../body/StaticBody";
import Broadphase from "../collision/broadphase/Broadphase";
import SpatialHashingBroadphase from "../collision/broadphase/SpatialHashingBroadphase";
import {
  Collision,
  SensorOverlap,
  getContactsFromCollisionPairs as getCollisionsFromPossible,
} from "../collision/pipeline/getContactsFromCollisionPairs";
import { raycast, raycastAll } from "../collision/raycast/Raycast";
import { RaycastHit, RaycastOptions } from "../collision/raycast/RaycastHit";
import { generateContactEquationsForCollision } from "../collision/response/ContactGenerator";
import { generateFrictionEquationsForCollision } from "../collision/response/FrictionGenerator";
import ContactEquation from "../equations/ContactEquation";
import FrictionEquation from "../equations/FrictionEquation";
import EventEmitter from "../events/EventEmitter";
import { PhysicsEventMap } from "../events/PhysicsEvents";
import GSSolver from "../solver/GSSolver";
import Solver from "../solver/Solver";
import type Spring from "../springs/Spring";
import BodyManager from "./BodyManager";
import ConstraintManager from "./ConstraintManager";
import ContactMaterialManager from "./ContactMaterialManager";
import { splitIntoIslands, type Island } from "./Island";
import OverlapKeeper, {
  bodyKey,
  type OverlapChanges,
  type ShapeOverlap,
} from "./OverlapKeeper";

export interface WorldOptions {
  solver?: Solver;
  broadphase?: Broadphase;
  islandSplit?: boolean;
}

export enum SleepMode {
  NO_SLEEPING = 1,
  BODY_SLEEPING = 2,
  ISLAND_SLEEPING = 4,
}

/** The dynamics world, where all bodies and constraints live. */
export default class World extends EventEmitter<PhysicsEventMap> {
  bodies: BodyManager;
  constraints: ConstraintManager;
  contactMaterials: ContactMaterialManager;
  springs: Set<Spring>;
  solver: Solver;
  broadphase: Broadphase;
  solveConstraints: boolean = true;
  time: number = 0.0;
  stepping: boolean = false;
  islandSplit: boolean;
  emitImpactEvent: boolean = true;
  /** When true, multiple contacts between shapes produce one averaged friction equation instead of many. */
  frictionReduction: boolean = true;
  _constraintIdCounter: number = 0;
  _bodyIdCounter: number = 0;
  sleepMode: SleepMode;
  overlapKeeper: OverlapKeeper;

  constructor(options: WorldOptions = {}) {
    super();

    this.bodies = new BodyManager(this);
    this.constraints = new ConstraintManager();
    this.springs = new Set<Spring>();

    this.solver = options.solver || new GSSolver();
    this.solver.setWorld(this);

    this.broadphase = options.broadphase || new SpatialHashingBroadphase();
    this.broadphase.setWorld(this);

    this.contactMaterials = new ContactMaterialManager();

    this.islandSplit = options.islandSplit ?? false;

    this.sleepMode = SleepMode.NO_SLEEPING;
    this.overlapKeeper = new OverlapKeeper();
  }

  /** Step the physics world forward in time. */
  step(dt: number): void {
    this.stepping = true;

    // 1. Apply forces (springs, damping)
    this.applyForces(dt);

    // 2. Broadphase - get potential collision pairs
    const possibleCollisions = this.doBroadphase();

    // 3. Narrowphase - get actual collisions
    const { collisions, sensorOverlaps } =
      getCollisionsFromPossible(possibleCollisions);

    // 4. Update overlap tracking
    const overlapChanges = this.updateOverlapTracking(
      collisions,
      sensorOverlaps
    );

    // 5. Build contact equations to resolve overlaps
    const collisionsWithContactEquations: [Collision, ContactEquation[]][] =
      collisions.map((collision) => [
        collision,
        generateContactEquationsForCollision(
          collision,
          this.contactMaterials.get(
            collision.shapeA.material,
            collision.shapeB.material
          ),
          overlapChanges.newlyOverlappingBodies.has(
            bodyKey(collision.bodyA, collision.bodyB)
          )
        ),
      ]);

    // 6. Build friction equations and flatten all equations
    const contactEquations: ContactEquation[] =
      collisionsWithContactEquations.flatMap(
        ([, contactEquations]) => contactEquations
      );

    const frictionEquations: FrictionEquation[] =
      collisionsWithContactEquations.flatMap(([collision, contactEquations]) =>
        generateFrictionEquationsForCollision(
          collision,
          contactEquations,
          this.contactMaterials.get(
            collision.shapeA.material,
            collision.shapeB.material
          ),
          this.frictionReduction
        )
      );

    // 7. Handle wake-ups for sleeping bodies
    this.handleCollisionWakeUps(collisions);

    // 8. Emit collision events (using overlapChanges from step 4)
    this.emitContactEvents(overlapChanges, collisionsWithContactEquations);
    this.emitPreSolveAndWakeUp(contactEquations, frictionEquations);

    // 9. Solve constraints
    const islands = this.solve(dt, contactEquations, frictionEquations);

    // 10. Integrate positions
    this.integrate(dt);

    // 11. Emit impact events
    this.emitImpactEvents(contactEquations);

    // 12. Update sleeping
    this.updateSleeping(dt, islands);

    this.time += dt;

    this.stepping = false;
    this.emit({ type: "postStep" });
  }

  private doBroadphase() {
    const possibleCollisions = this.broadphase.getCollisionPairs(this);

    const disabledByConstraints = new Set<string>();
    for (const constraint of this.constraints.collideConnectedDisabled) {
      disabledByConstraints.add(bodyKey(constraint.bodyA, constraint.bodyB));
    }

    const filteredPossibleCollisions = possibleCollisions.filter(
      ([bodyA, bodyB]) => !disabledByConstraints.has(bodyKey(bodyA, bodyB))
    );

    this.emit({ type: "postBroadphase", pairs: filteredPossibleCollisions });
    return filteredPossibleCollisions;
  }

  private applyForces(dt: number): void {
    // Add spring forces
    for (const spring of this.springs) {
      spring.applyForce();
    }

    // Apply damping
    for (const body of this.bodies.dynamic) {
      body.applyDamping(dt);
    }
  }

  /** Handle wake-up logic for sleeping bodies that collide with fast-moving bodies */
  private handleCollisionWakeUps(collisions: Collision[]): void {
    for (const { bodyA, bodyB } of collisions) {
      // Check if bodyA should wake up
      if (
        bodyA.allowSleep &&
        bodyA instanceof DynamicBody &&
        bodyA.sleepState === SleepState.SLEEPING &&
        bodyB.sleepState === SleepState.AWAKE &&
        !(bodyB instanceof StaticBody)
      ) {
        const speedSquaredB =
          bodyB.velocity.squaredMagnitude + bodyB.angularVelocity ** 2;
        const speedLimitSquaredB = bodyB.sleepSpeedLimit ** 2;
        if (speedSquaredB >= speedLimitSquaredB * 2) {
          bodyA._wakeUpAfterNarrowphase = true;
        }
      }

      // Check if bodyB should wake up
      if (
        bodyB.allowSleep &&
        bodyB instanceof DynamicBody &&
        bodyB.sleepState === SleepState.SLEEPING &&
        bodyA.sleepState === SleepState.AWAKE &&
        !(bodyA instanceof StaticBody)
      ) {
        const speedSquaredA =
          bodyA.velocity.squaredMagnitude + bodyA.angularVelocity ** 2;
        const speedLimitSquaredA = bodyA.sleepSpeedLimit ** 2;
        if (speedSquaredA >= speedLimitSquaredA * 2) {
          bodyB._wakeUpAfterNarrowphase = true;
        }
      }
    }
  }

  /** Update overlap tracking and return changes (called before contact equation generation) */
  private updateOverlapTracking(
    collisions: Collision[],
    sensorOverlaps: SensorOverlap[]
  ): OverlapChanges {
    // Build overlap input (without contact equations - they don't exist yet)
    const currentOverlaps: ShapeOverlap[] = [
      ...collisions.map((collision) => ({
        ...collision,
        contactEquations: [] as ContactEquation[],
      })),
      ...sensorOverlaps.map((sensor) => ({
        ...sensor,
        contactEquations: [] as ContactEquation[],
      })),
    ];

    return this.overlapKeeper.updateOverlaps(currentOverlaps);
  }

  /** Emit beginContact/endContact events using pre-computed overlap changes */
  private emitContactEvents(
    overlapChanges: OverlapChanges,
    collisionsWithContacts: [Collision, ContactEquation[]][]
  ): void {
    const { newOverlaps, endedOverlaps } = overlapChanges;

    // Emit beginContact events, but only if we have at least one listener
    if (this.has("beginContact")) {
      // Build lookup for contact equations (newOverlaps don't have them yet)
      const contactsByShapePair = new Map<string, ContactEquation[]>();
      for (const [collision, contacts] of collisionsWithContacts) {
        const key = `${collision.shapeA.id}:${collision.shapeB.id}`;
        contactsByShapePair.set(key, contacts);
      }

      for (const overlap of newOverlaps) {
        const key = `${overlap.shapeA.id}:${overlap.shapeB.id}`;
        const contacts = contactsByShapePair.get(key) ?? [];
        this.emit({
          type: "beginContact",
          ...overlap,
          contactEquations: contacts,
        });
      }
    }

    // Emit endContact events, but only if we have at least one listener
    if (this.has("endContact")) {
      for (const overlap of endedOverlaps) {
        this.emit({ type: "endContact", ...overlap });
      }
    }
  }

  /** Wake up bodies and emit preSolve event */
  private emitPreSolveAndWakeUp(
    contacts: ContactEquation[],
    friction: FrictionEquation[]
  ): void {
    // Wake up bodies that need it
    for (const body of this.bodies) {
      if (body._wakeUpAfterNarrowphase) {
        body.wakeUp();
        body._wakeUpAfterNarrowphase = false;
      }
    }

    this.emit({
      type: "preSolve",
      contactEquations: contacts,
      frictionEquations: friction,
    });
  }

  private solve(
    dt: number,
    contacts: ContactEquation[],
    friction: FrictionEquation[]
  ): Island[] | undefined {
    const solver = this.solver;

    // Update constraint equations
    for (const c of this.constraints) {
      c.update();
    }

    const hasEquations =
      contacts.length || friction.length || this.constraints.length;

    if (!hasEquations) {
      return undefined;
    }

    if (this.islandSplit) {
      // Collect all equations
      const allEquations = [
        ...contacts,
        ...friction,
        ...[...this.constraints].flatMap((c) => c.equations),
      ];

      // Split into islands and solve each
      const islands = splitIntoIslands(this.bodies.all, allEquations);
      for (const island of islands) {
        if (island.equations.length) {
          solver.solveIsland(dt, island);
        }
      }
      return islands;
    } else {
      solver.addEquations(contacts);
      solver.addEquations(friction);

      for (const c of this.constraints) {
        solver.addEquations(c.equations);
      }

      if (this.solveConstraints) {
        solver.solve(dt, this);
      }

      solver.removeAllEquations();
      return undefined;
    }
  }

  private integrate(dt: number): void {
    // We only need to integrate kinematic and dynamic bodies
    for (const body of this.bodies.kinematic) {
      body.integrate(dt);
    }
    for (const body of this.bodies.dynamic) {
      body.integrate(dt);
    }

    // Reset forces
    // TODO: Can we limit this to only dynamic and kinematic bodies?
    // Do static bodies ever have forces? And if they do, does it matter?
    for (const body of this.bodies.dynamic) {
      body.setZeroForce();
    }
  }

  /** Emit impact events for first-time contacts */
  private emitImpactEvents(contacts: ContactEquation[]): void {
    if (this.emitImpactEvent && this.has("impact")) {
      for (const eq of contacts) {
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
  }

  private updateSleeping(dt: number, islands: Island[] | undefined): void {
    if (this.sleepMode === SleepMode.BODY_SLEEPING) {
      for (const body of this.bodies) {
        body.sleepTick(this.time, false, dt);
      }
    } else if (
      this.sleepMode === SleepMode.ISLAND_SLEEPING &&
      this.islandSplit &&
      islands
    ) {
      // Tell all bodies to sleep tick but don't sleep yet
      for (const body of this.bodies) {
        body.sleepTick(this.time, true, dt);
      }

      // Sleep islands where all dynamic bodies want to sleep
      for (const island of islands) {
        const allWantToSleep = island.bodies.every(
          (body) => !(body instanceof DynamicBody) || body.wantsToSleep
        );
        if (allWantToSleep) {
          for (const body of island.bodies) {
            body.sleep();
          }
        }
      }
    }
  }

  /** Add a spring to the simulation */
  addSpring(spring: Spring): void {
    this.springs.add(spring);
    this.emit({ type: "addSpring", spring });
  }

  /** Remove a spring */
  removeSpring(spring: Spring): void {
    this.springs.delete(spring);
  }

  /** Resets the World, removes all bodies, constraints and springs. */
  clear(): void {
    this.time = 0;

    // Remove all solver equations
    this.solver.removeAllEquations();

    // Remove all constraints
    this.constraints.clear();

    // Remove all bodies
    this.bodies.clear();
    this.springs.clear();
    this.contactMaterials = new ContactMaterialManager();
  }

  /**
   * Cast a ray and return the closest hit, or null if nothing was hit.
   *
   * @param from - Start point of the ray
   * @param to - End point of the ray
   * @param options - Optional raycast configuration
   * @returns The closest hit, or null if nothing was hit
   */
  raycast(
    from: CompatibleVector,
    to: CompatibleVector,
    options?: RaycastOptions
  ): RaycastHit | null {
    return raycast(this, from, to, options);
  }

  /**
   * Cast a ray and return all hits, sorted by distance (closest first).
   *
   * @param from - Start point of the ray
   * @param to - End point of the ray
   * @param options - Optional raycast configuration
   * @returns Array of all hits, sorted by distance
   */
  raycastAll(
    from: CompatibleVector,
    to: CompatibleVector,
    options?: RaycastOptions
  ): RaycastHit[] {
    return raycastAll(this, from, to, options);
  }
}
