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

// Records which events each class handles (including inherited handlers).
// Populated by the @on decorator when the first instance of each class is created.
// After the first instance, inherited decorators ensure child classes get parent handlers too.
const registeredHandlers = new WeakMap<object, Set<GameEventName>>();

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

    // Validate method name matches expected pattern
    const expectedName = `on${event.charAt(0).toUpperCase()}${event.slice(1)}`;
    if (methodName !== expectedName) {
      throw new Error(
        `@on("${event}") requires the method to be named "${expectedName}", but found "${methodName}"`,
      );
    }

    // Register the handler when instances are created.
    // Runs on every instantiation, but after the first instance we just do a quick check and return.
    context.addInitializer(function (this: unknown) {
      const constructor = (this as object).constructor;

      // Fast path: if already registered, bail immediately
      const handlers = registeredHandlers.get(constructor);
      if (handlers?.has(event)) {
        return;
      }

      // Slow path: first instance of this class, register the handler
      if (!handlers) {
        const newHandlers = new Set<GameEventName>();
        registeredHandlers.set(constructor, newHandlers);
        newHandlers.add(event);
      } else {
        handlers.add(event);
      }
    });

    return _target;
  };
}

/**
 * Get all registered event handlers for an entity.
 * Returns the set of event names that the entity handles (including inherited handlers).
 */
export function getHandlers(entity: object): Iterable<GameEventName> {
  return registeredHandlers.get(entity.constructor) ?? new Set();
}
