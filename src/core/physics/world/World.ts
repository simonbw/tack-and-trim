import { profile, profiler } from "../../util/Profiler";
import { CompatibleVector } from "../../Vector";
import { SleepState } from "../body/Body";
import { DynamicBody } from "../body/DynamicBody";
import { Broadphase } from "../collision/broadphase/Broadphase";
import { SpatialHashingBroadphase } from "../collision/broadphase/SpatialHashingBroadphase";
import {
  Collision,
  getContactsFromPairs,
  SensorOverlap,
} from "../collision/narrowphase/getContactsFromCollisionPairs";
import { raycast, raycastAll } from "../collision/raycast/Raycast";
import { RaycastHit, RaycastOptions } from "../collision/raycast/RaycastHit";
import { generateContactEquationsForCollision } from "../collision/response/ContactGenerator";
import { generateFrictionEquationsForCollision } from "../collision/response/FrictionGenerator";
import { ContactEquation } from "../equations/ContactEquation";
import { FrictionEquation } from "../equations/FrictionEquation";
import { EventEmitter } from "../events/EventEmitter";
import { PhysicsEventMap } from "../events/PhysicsEvents";
import {
  DEFAULT_SOLVER_CONFIG,
  solveEquations,
  solveIsland,
  type SolverConfig,
} from "../solver/GSSolver";
import type { Spring } from "../springs/Spring";
import { BodyManager } from "./BodyManager";
import { ConstraintManager } from "./ConstraintManager";
import { ContactMaterialManager } from "./ContactMaterialManager";
import { splitIntoIslands, type Island } from "./Island";
import {
  bodyKey,
  OverlapKeeper,
  type OverlapChanges,
  type ShapeOverlap,
} from "./OverlapKeeper";

/** Options for creating a World. */
export interface WorldOptions {
  /** Configuration for the constraint solver (iterations, tolerance). */
  solverConfig?: Partial<SolverConfig>;
  /** Broadphase algorithm for collision culling. Defaults to SpatialHashingBroadphase. */
  broadphase?: Broadphase;
  /** Enable island splitting for more efficient solving and sleeping. */
  islandSplit?: boolean;
}

/** Controls how bodies are allowed to sleep. */
export enum SleepMode {
  /** Bodies never sleep. */
  NO_SLEEPING = 1,
  /** Individual bodies sleep when idle. */
  BODY_SLEEPING = 2,
  /** Connected body groups (islands) sleep together. Requires islandSplit=true. */
  ISLAND_SLEEPING = 4,
}

/**
 * The physics simulation world. Contains all bodies, constraints, springs, and handles stepping.
 *
 * @example
 * ```ts
 * const world = new World({ islandSplit: true });
 * world.bodies.add(new DynamicBody({ mass: 1 }));
 * world.step(1/60);
 * ```
 */
export class World extends EventEmitter<PhysicsEventMap> {
  /** Manages all bodies in the simulation. */
  bodies: BodyManager;
  /** Manages all constraints between bodies. */
  constraints: ConstraintManager;
  /** Manages friction/restitution properties between material pairs. */
  contactMaterials: ContactMaterialManager;
  /** All springs in the simulation. */
  springs: Set<Spring>;
  /** Configuration for the Gauss-Seidel constraint solver. */
  solverConfig: SolverConfig;
  /** Broadphase algorithm used for collision culling. */
  broadphase: Broadphase;
  /** Total simulated time in seconds. */
  time: number = 0.0;
  /** True while step() is executing. */
  stepping: boolean = false;
  /** Whether to split bodies into islands for solving. */
  islandSplit: boolean;
  /** Whether to emit "impact" events on first contact. */
  emitImpactEvent: boolean = true;
  /** When true, multiple contacts between shapes produce one averaged friction equation instead of many. */
  frictionReduction: boolean = true;
  /** @internal */
  _constraintIdCounter: number = 0;
  /** @internal */
  _bodyIdCounter: number = 0;
  /** Controls body sleeping behavior. */
  sleepMode: SleepMode;
  /** Tracks shape overlaps for begin/end contact events. */
  overlapKeeper: OverlapKeeper;

  /** Creates a new physics world. */
  constructor(options: WorldOptions = {}) {
    super();

    this.bodies = new BodyManager(this);
    this.constraints = new ConstraintManager();
    this.springs = new Set<Spring>();

    this.solverConfig = { ...DEFAULT_SOLVER_CONFIG, ...options.solverConfig };

    this.broadphase = options.broadphase ?? new SpatialHashingBroadphase();
    this.broadphase.setWorld(this);

    this.contactMaterials = new ContactMaterialManager();

    this.islandSplit = options.islandSplit ?? false;

    this.sleepMode = SleepMode.NO_SLEEPING;
    this.overlapKeeper = new OverlapKeeper();
  }

  /**
   * Step the simulation forward by dt seconds.
   * Applies forces, detects collisions, solves constraints, and integrates positions.
   */
  @profile
  step(dt: number): void {
    this.stepping = true;

    // 1. Apply forces (springs, damping)
    this.applyForces(dt);

    // 2. Broadphase - get potential collision pairs
    const pairsToCheck = this.doBroadphase();

    // 3. Narrowphase - get actual collisions
    const { collisions, sensorOverlaps } = profiler.measure(
      "World.narrowphase",
      () => getContactsFromPairs(pairsToCheck),
    );

    // 4. Update overlap tracking
    const overlapChanges = this.updateOverlapTracking(
      collisions,
      sensorOverlaps,
    );

    // 5. Build contact equations to resolve overlaps
    profiler.start("World.contactEquations");
    const collisionsWithContactEquations: [Collision, ContactEquation[]][] =
      collisions.map((collision) => [
        collision,
        generateContactEquationsForCollision(
          collision,
          this.contactMaterials.get(
            collision.shapeA.material,
            collision.shapeB.material,
          ),
          overlapChanges.newlyOverlappingBodies.has(
            bodyKey(collision.bodyA, collision.bodyB),
          ),
        ),
      ]);

    const contactEquations: ContactEquation[] =
      collisionsWithContactEquations.flatMap(
        ([, contactEquations]) => contactEquations,
      );
    profiler.end("World.contactEquations");

    // 6. Build friction equations and flatten all equations
    profiler.start("World.frictionEquations");
    const frictionEquations: FrictionEquation[] =
      collisionsWithContactEquations.flatMap(([collision, contactEquations]) =>
        generateFrictionEquationsForCollision(
          collision,
          contactEquations,
          this.contactMaterials.get(
            collision.shapeA.material,
            collision.shapeB.material,
          ),
          this.frictionReduction,
        ),
      );
    profiler.end("World.frictionEquations");

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

  @profile
  private applyForces(dt: number): void {
    // Add spring forces
    for (const spring of this.springs) {
      spring.applyForce();
    }

    // Apply damping (only to awake bodies)
    for (const body of this.bodies.dynamicAwake) {
      body.applyDamping(dt);
    }
  }

  @profile
  private doBroadphase() {
    const possibleCollisions = this.broadphase.getCollisionPairs(this);

    // Use pre-computed disabled body keys from ConstraintManager
    const disabledBodyKeys = this.constraints.disabledBodyKeys;

    const filteredPossibleCollisions = possibleCollisions.filter(
      ([bodyA, bodyB]) => !disabledBodyKeys.has(bodyKey(bodyA, bodyB)),
    );

    this.emit({ type: "postBroadphase", pairs: filteredPossibleCollisions });
    return filteredPossibleCollisions;
  }

  /** Update overlap tracking and return changes (called before contact equation generation) */
  @profile
  private updateOverlapTracking(
    collisions: Collision[],
    sensorOverlaps: SensorOverlap[],
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

  /** Handle wake-up logic for sleeping bodies that collide with fast-moving bodies */
  @profile
  private handleCollisionWakeUps(collisions: Collision[]): void {
    for (const { bodyA, bodyB } of collisions) {
      // Only dynamic bodies can sleep or wake other bodies
      const dynA = bodyA instanceof DynamicBody ? bodyA : null;
      const dynB = bodyB instanceof DynamicBody ? bodyB : null;

      // Check if bodyA (sleeping) should be woken by bodyB (fast-moving)
      if (
        dynA &&
        dynB &&
        dynA.allowSleep &&
        dynA.sleepState === SleepState.SLEEPING &&
        dynB.sleepState === SleepState.AWAKE
      ) {
        const speedSquaredB =
          dynB.velocity.squaredMagnitude + dynB.angularVelocity ** 2;
        const speedLimitSquaredB = dynB.sleepSpeedLimit ** 2;
        if (speedSquaredB >= speedLimitSquaredB * 2) {
          dynA._wakeUpAfterNarrowphase = true;
        }
      }

      // Check if bodyB (sleeping) should be woken by bodyA (fast-moving)
      if (
        dynA &&
        dynB &&
        dynB.allowSleep &&
        dynB.sleepState === SleepState.SLEEPING &&
        dynA.sleepState === SleepState.AWAKE
      ) {
        const speedSquaredA =
          dynA.velocity.squaredMagnitude + dynA.angularVelocity ** 2;
        const speedLimitSquaredA = dynA.sleepSpeedLimit ** 2;
        if (speedSquaredA >= speedLimitSquaredA * 2) {
          dynB._wakeUpAfterNarrowphase = true;
        }
      }
    }
  }

  /** Emit beginContact/endContact events using pre-computed overlap changes */
  @profile
  private emitContactEvents(
    overlapChanges: OverlapChanges,
    collisionsWithContacts: [Collision, ContactEquation[]][],
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
  @profile
  private emitPreSolveAndWakeUp(
    contacts: ContactEquation[],
    friction: FrictionEquation[],
  ): void {
    // Wake up bodies that need it - check all dynamic bodies since sleeping ones may have the flag
    for (const body of this.bodies.dynamic) {
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

  @profile
  private solve(
    dt: number,
    contacts: ContactEquation[],
    friction: FrictionEquation[],
  ): Island[] | undefined {
    // Update constraint equations
    for (const c of this.constraints) {
      c.update();
    }

    // Collect all equations
    const allEquations = [
      ...contacts,
      ...friction,
      ...[...this.constraints].flatMap((c) => c.equations),
    ];

    if (allEquations.length === 0) {
      return undefined;
    }

    if (this.islandSplit) {
      // Split into islands and solve each
      const islands = splitIntoIslands(this.bodies.all, allEquations);
      for (const island of islands) {
        if (island.equations.length) {
          solveIsland(island, dt, this.solverConfig);
        }
      }
      return islands;
    } else {
      solveEquations(
        allEquations,
        this.bodies.dynamicAwake,
        dt,
        this.solverConfig,
      );
      return undefined;
    }
  }

  @profile
  private integrate(dt: number): void {
    // We only need to integrate kinematic and awake dynamic bodies
    for (const body of this.bodies.kinematic) {
      body.integrate(dt);
    }
    for (const body of this.bodies.dynamicAwake) {
      body.integrate(dt);
      body.setZeroForce();
    }
  }

  /** Emit impact events for first-time contacts */
  @profile
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

  @profile
  private updateSleeping(dt: number, islands: Island[] | undefined): void {
    if (this.sleepMode === SleepMode.BODY_SLEEPING) {
      // Only awake dynamic bodies participate in sleep logic
      // Use Array.from since sleepTick may modify the set via sleep()
      for (const body of Array.from(this.bodies.dynamicAwake)) {
        body.sleepTick(this.time, false, dt);
      }
    } else if (
      this.sleepMode === SleepMode.ISLAND_SLEEPING &&
      this.islandSplit &&
      islands
    ) {
      // Only awake dynamic bodies participate in sleep logic
      for (const body of this.bodies.dynamicAwake) {
        body.sleepTick(this.time, true, dt);
      }

      // Sleep islands where all dynamic bodies want to sleep
      for (const island of islands) {
        const allWantToSleep = island.bodies.every(
          (body) => !(body instanceof DynamicBody) || body.wantsToSleep,
        );
        if (allWantToSleep) {
          for (const body of island.bodies) {
            if (body instanceof DynamicBody) {
              body.sleep();
            }
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
    options?: RaycastOptions,
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
    options?: RaycastOptions,
  ): RaycastHit[] {
    return raycastAll(this, from, to, options);
  }
}
