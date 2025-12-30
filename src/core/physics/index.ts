// Physics engine - Barrel export
// Based on p2.js with custom extensions

// Math
export { default as vec2 } from "./math/vec2";
export type { Vec2 } from "./math/vec2";
export * as polyk from "./math/polyk";

// Re-export V2d for convenience
export { V2d, V } from "../Vector";
export type { CompatibleVector } from "../Vector";

// Events
export { default as EventEmitter } from "./events/EventEmitter";
export type { P2Event } from "./events/EventEmitter";

// Utils
export { default as Utils, ARRAY_TYPE, appendArray, splice, extend, defaults } from "./utils/Utils";
export { default as Pool } from "./utils/Pool";
export type { PoolOptions } from "./utils/Pool";
export { default as TupleDictionary } from "./utils/TupleDictionary";
export { default as OverlapKeeper } from "./utils/OverlapKeeper";
export { default as OverlapKeeperRecord } from "./utils/OverlapKeeperRecord";
export { default as OverlapKeeperRecordPool } from "./utils/OverlapKeeperRecordPool";
export { default as ContactEquationPool } from "./utils/ContactEquationPool";
export { default as FrictionEquationPool } from "./utils/FrictionEquationPool";
export { default as IslandNodePool } from "./utils/IslandNodePool";
export { default as IslandPool } from "./utils/IslandPool";

// Collision
export { default as AABB } from "./collision/AABB";
export { default as Broadphase } from "./collision/Broadphase";
export { default as SAPBroadphase } from "./collision/SAPBroadphase";
export { default as Narrowphase } from "./collision/Narrowphase";
export { default as Ray } from "./collision/Ray";
export type { RayOptions } from "./collision/Ray";
export { default as RaycastResult } from "./collision/RaycastResult";

// Material
export { default as Material } from "./material/Material";
export { default as ContactMaterial } from "./material/ContactMaterial";
export type { ContactMaterialOptions } from "./material/ContactMaterial";

// Shapes
export { default as Shape } from "./shapes/Shape";
export type { ShapeOptions } from "./shapes/Shape";
export { default as Circle } from "./shapes/Circle";
export { default as Particle } from "./shapes/Particle";
export { default as Line } from "./shapes/Line";
export { default as Capsule } from "./shapes/Capsule";
export { default as Convex } from "./shapes/Convex";
export { default as Box } from "./shapes/Box";

// Equations
export { default as Equation } from "./equations/Equation";
export { default as ContactEquation } from "./equations/ContactEquation";
export { default as FrictionEquation } from "./equations/FrictionEquation";
export { default as AngleLockEquation } from "./equations/AngleLockEquation";
export { default as RotationalLockEquation } from "./equations/RotationalLockEquation";
export { default as RotationalVelocityEquation } from "./equations/RotationalVelocityEquation";

// Constraints
export { default as Constraint } from "./constraints/Constraint";
export type { ConstraintOptions } from "./constraints/Constraint";
export { default as DistanceConstraint } from "./constraints/DistanceConstraint";
export { default as RevoluteConstraint } from "./constraints/RevoluteConstraint";
export { default as LockConstraint } from "./constraints/LockConstraint";

// Solver
export { default as Solver } from "./solver/Solver";
export { default as GSSolver } from "./solver/GSSolver";

// Objects
export { default as Body } from "./objects/Body";
export type { BodyOptions } from "./objects/Body";
export { default as Spring } from "./objects/Spring";
export { default as LinearSpring } from "./objects/LinearSpring";
export type { LinearSpringOptions } from "./objects/LinearSpring";
export { default as RotationalSpring } from "./objects/RotationalSpring";
export type { RotationalSpringOptions } from "./objects/RotationalSpring";

// World
export { default as World } from "./world/World";
export type { WorldOptions } from "./world/World";
export { default as Island } from "./world/Island";
export { default as IslandNode } from "./world/IslandNode";
export { default as IslandManager } from "./world/IslandManager";

// Custom extensions
export { default as CustomWorld } from "./CustomWorld";
export { default as CustomSolver } from "./CustomSolver";
export { default as SpatialHashingBroadphase } from "./SpatialHashingBroadphase";
export { default as CCDBody } from "./CCDBody";

// Custom springs
export { default as AimSpring } from "./AimSpring";
export { default as RopeSpring } from "./RopeSpring";
export { default as DampedRotationalSpring } from "./DampedRotationalSpring";
export { default as RotationalSolenoidSpring } from "./RotationalSolenoidSpring";
