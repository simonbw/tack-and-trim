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

// Symbol to store handler metadata on the class constructor
const HANDLERS_KEY = Symbol("handlers");

// Type for the metadata we store
type HandlerMetadata = GameEventName[];

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
    // Use addInitializer to register metadata on the constructor
    // This runs once per class (when first instance is created)
    context.addInitializer(function (this: unknown) {
      const constructor = (this as object).constructor as {
        [HANDLERS_KEY]?: HandlerMetadata;
      };

      // Initialize handlers array if not present
      if (!constructor[HANDLERS_KEY]) {
        constructor[HANDLERS_KEY] = [];
      }

      // Only add if not already registered (handles inheritance)
      if (!constructor[HANDLERS_KEY].includes(event)) {
        constructor[HANDLERS_KEY].push(event);
      }
    });

    return _target;
  };
}

/**
 * Get all registered event handlers for an entity.
 * Returns an array of event names that the entity handles.
 */
export function getHandlers(entity: object): readonly GameEventName[] {
  const constructor = entity.constructor as {
    [HANDLERS_KEY]?: HandlerMetadata;
  };
  return constructor[HANDLERS_KEY] ?? [];
}
