// Physics engine - Barrel export
// Based on p2.js with custom extensions

// Math
export * as polyk from "./math/polyk";

// Re-export V2d for convenience
export { V, V2d } from "../Vector";
export type { CompatibleVector } from "../Vector";

// Events
export { default as EventEmitter } from "./events/EventEmitter";
export type { P2Event } from "./events/EventEmitter";

// Utils
export { default as ContactEquationPool } from "./utils/ContactEquationPool";
export { default as FrictionEquationPool } from "./utils/FrictionEquationPool";
export { default as IslandNodePool } from "./utils/IslandNodePool";
export { default as IslandPool } from "./utils/IslandPool";
export { default as OverlapKeeper } from "./utils/OverlapKeeper";
export { default as OverlapKeeperRecord } from "./utils/OverlapKeeperRecord";
export { default as OverlapKeeperRecordPool } from "./utils/OverlapKeeperRecordPool";
export { default as Pool } from "./utils/Pool";
export type { PoolOptions } from "./utils/Pool";
export { default as TupleDictionary } from "./utils/TupleDictionary";
export {
  appendArray,
  ARRAY_TYPE,
  defaults,
  extend,
  splice,
  default as Utils,
} from "./utils/Utils";

// Collision
export { default as AABB } from "./collision/AABB";
export { default as Broadphase } from "./collision/Broadphase";
export { default as Narrowphase } from "./collision/Narrowphase";
export { default as Ray } from "./collision/Ray";
export type { RayOptions } from "./collision/Ray";
export { default as RaycastResult } from "./collision/RaycastResult";
export { default as SAPBroadphase } from "./collision/SAPBroadphase";

// Material
export { default as ContactMaterial } from "./material/ContactMaterial";
export type { ContactMaterialOptions } from "./material/ContactMaterial";
export { default as Material } from "./material/Material";

// Shapes
export { default as Box } from "./shapes/Box";
export { default as Capsule } from "./shapes/Capsule";
export { default as Circle } from "./shapes/Circle";
export { default as Convex } from "./shapes/Convex";
export { default as Line } from "./shapes/Line";
export { default as Particle } from "./shapes/Particle";
export { default as Shape } from "./shapes/Shape";
export type { ShapeOptions } from "./shapes/Shape";

// Equations
export { default as AngleLockEquation } from "./equations/AngleLockEquation";
export { default as ContactEquation } from "./equations/ContactEquation";
export { default as Equation } from "./equations/Equation";
export { default as FrictionEquation } from "./equations/FrictionEquation";
export { default as RotationalLockEquation } from "./equations/RotationalLockEquation";
export { default as RotationalVelocityEquation } from "./equations/RotationalVelocityEquation";

// Constraints
export { default as Constraint } from "./constraints/Constraint";
export type { ConstraintOptions } from "./constraints/Constraint";
export { default as DistanceConstraint } from "./constraints/DistanceConstraint";
export { default as LockConstraint } from "./constraints/LockConstraint";
export { default as RevoluteConstraint } from "./constraints/RevoluteConstraint";

// Solver
export { default as GSSolver } from "./solver/GSSolver";
export { default as Solver } from "./solver/Solver";

// Objects
export { default as Body } from "./body/Body";
export type { BodyOptions } from "./body/Body";

// Springs
export { default as AimSpring } from "./springs/AimSpring";
export { default as DampedRotationalSpring } from "./springs/DampedRotationalSpring";
export { default as LinearSpring } from "./springs/LinearSpring";
export type { LinearSpringOptions } from "./springs/LinearSpring";
export { default as RopeSpring } from "./springs/RopeSpring";
export { default as RotationalSolenoidSpring } from "./springs/RotationalSolenoidSpring";
export { default as RotationalSpring } from "./springs/RotationalSpring";
export type { RotationalSpringOptions } from "./springs/RotationalSpring";
export { default as Spring } from "./springs/Spring";
export type { SpringOptions } from "./springs/Spring";

// World
export { default as Island } from "./world/Island";
export { default as IslandManager } from "./world/IslandManager";
export { default as IslandNode } from "./world/IslandNode";
export { default as World } from "./world/World";
export type { WorldOptions } from "./world/World";

// Custom extensions
export { default as CCDBody } from "./body/CCDBody";
export { default as SpatialHashingBroadphase } from "./SpatialHashingBroadphase";
