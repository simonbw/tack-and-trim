/**
 * Type-safe event handler decorator for entities.
 *
 * Usage:
 *   @on("tick")
 *   onTick(dt: number) { ... }
 */

import type { GameEventMap, GameEventName } from "./Entity";

// Type for what a handler function should look like for a given event
type HandlerFn<K extends GameEventName> = GameEventMap[K] extends void
  ? () => void
  : (data: GameEventMap[K]) => void;

// Map from class constructor to its directly declared handlers
const classHandlers = new WeakMap<object, Set<GameEventName>>();

// Track which (class, event) pairs have already been processed
// Key format: uses a WeakMap of class -> Set of event names
const processedHandlers = new WeakMap<object, Set<GameEventName>>();

/**
 * Decorator that marks a method as an event handler.
 * Provides compile-time type checking for the handler signature.
 *
 * @example
 * class MyEntity extends BaseEntity {
 *   @on("tick")
 *   onTick(dt: number) {
 *     // dt is type-checked to be number
 *   }
 *
 *   @on("render")
 *   onRender({ dt, draw }: GameEventMap["render"]) {
 *     // Parameters are type-checked
 *   }
 * }
 */
export function on<K extends GameEventName>(event: K) {
  return function <T extends HandlerFn<K>>(
    _target: T,
    context: ClassMethodDecoratorContext,
  ): T {
    const methodName = String(context.name);

    // Use addInitializer to register handlers on first instantiation
    // We need this because we don't have access to the class constructor at decoration time
    context.addInitializer(function (this: unknown) {
      const instance = this as object;

      // Validate method name matches expected pattern
      const expectedName = `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
      if (methodName !== expectedName) {
        throw new Error(
          `@on("${event}") requires the method to be named "${expectedName}", but found "${methodName}"`,
        );
      }

      // Find which class in the prototype chain actually owns this method
      let proto = Object.getPrototypeOf(instance);
      while (proto && proto !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(proto, methodName)) {
          const owningClass = proto.constructor;

          // Check if we've already processed this (class, event) pair
          let processed = processedHandlers.get(owningClass);
          if (!processed) {
            processed = new Set();
            processedHandlers.set(owningClass, processed);
          }
          if (processed.has(event)) {
            return; // Already registered
          }
          processed.add(event);

          // Register this event for the class that owns the method
          let handlers = classHandlers.get(owningClass);
          if (!handlers) {
            handlers = new Set();
            classHandlers.set(owningClass, handlers);
          }
          handlers.add(event);
          return;
        }
        proto = Object.getPrototypeOf(proto);
      }
    });

    return _target;
  };
}

/**
 * Get all registered event handlers for an entity.
 * Returns an array of event names that the entity handles.
 * Walks up the prototype chain to collect handlers from parent classes.
 */
export function getHandlers(entity: object): readonly GameEventName[] {
  const result = new Set<GameEventName>();

  // Walk up the prototype chain to collect all handlers
  let current: object | null = entity.constructor;
  while (current && current !== Object && current !== Function) {
    const handlers = classHandlers.get(current);
    if (handlers) {
      for (const event of handlers) {
        result.add(event);
      }
    }
    current = Object.getPrototypeOf(current);
  }

  return Array.from(result);
}
