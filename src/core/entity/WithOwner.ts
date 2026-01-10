import Entity from "./Entity";

/**
 * Interface for objects that can be associated with an owning Entity.
 *
 * This interface is primarily used by physics bodies and shapes to maintain
 * a reference back to their owning Entity. When an entity with a `body` or
 * `bodies` property is added to the game, the Game automatically sets the
 * `owner` property on each body to point to the entity.
 *
 * This owner reference is essential for the collision system - when two
 * physics bodies collide, the system uses the `owner` property to determine
 * which entities are involved and dispatch the appropriate contact events
 * (onBeginContact, onEndContact, onContacting, onImpact) to those entities.
 *
 * @example
 * // The Game automatically sets owner when adding entities:
 * // In Game.addEntity():
 * if (entity.body) {
 *   entity.body.owner = entity;
 *   this.world.bodies.add(entity.body);
 * }
 *
 * // In collision handlers, owner is used to find the entity:
 * const ownerA = bodyA.owner;
 * const ownerB = bodyB.owner;
 * ownerA?.onBeginContact({ other: ownerB, ... });
 */
export interface WithOwner {
  /**
   * The Entity that owns this object (typically a physics body or shape).
   *
   * This property is automatically set by the Game when an entity with
   * physics bodies is added. It allows the physics/collision system to
   * route events back to the appropriate Entity.
   */
  owner?: Entity;
}
