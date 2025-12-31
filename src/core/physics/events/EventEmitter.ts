/**
 * Event object passed to listeners
 */
export interface P2Event {
  type: string;
  target?: EventEmitter<any>;
}

/**
 * Listener function with optional context
 */
interface ListenerWithContext<T = P2Event> {
  (event: T): void;
  context?: unknown;
}

/**
 * Base class for objects that dispatch events.
 * @template EventMap - A map of event type names to their event payloads
 */
export default class EventEmitter<EventMap extends Record<string, P2Event> = Record<string, P2Event>> {
  private _listeners?: Partial<Record<keyof EventMap, ListenerWithContext<EventMap[keyof EventMap]>[]>>;

  /**
   * Add an event listener
   * @param type Event type
   * @param listener Callback function
   * @param context Optional context to bind the listener to
   * @returns The self object, for chainability.
   */
  on<K extends keyof EventMap>(
    type: K,
    listener: (event: EventMap[K]) => void,
    context?: unknown
  ): this {
    const listenerWithContext = listener as ListenerWithContext<EventMap[K]>;
    listenerWithContext.context = context ?? this;

    if (this._listeners === undefined) {
      this._listeners = {};
    }

    const listeners = this._listeners;
    if (listeners[type] === undefined) {
      listeners[type] = [];
    }

    if (listeners[type]!.indexOf(listenerWithContext as any) === -1) {
      listeners[type]!.push(listenerWithContext as any);
    }

    return this;
  }

  /**
   * Check if an event listener is added
   * @param type Event type
   * @param listener Optional specific listener to check for
   * @returns True if listener(s) exist for the type
   */
  has<K extends keyof EventMap>(
    type: K,
    listener?: (event: EventMap[K]) => void
  ): boolean {
    if (this._listeners === undefined) {
      return false;
    }

    const listeners = this._listeners;
    if (listener) {
      if (
        listeners[type] !== undefined &&
        listeners[type]!.indexOf(listener as any) !== -1
      ) {
        return true;
      }
    } else {
      if (listeners[type] !== undefined) {
        return true;
      }
    }

    return false;
  }

  /**
   * Remove an event listener
   * @param type Event type
   * @param listener The listener to remove
   * @returns The self object, for chainability.
   */
  off<K extends keyof EventMap>(
    type: K,
    listener: (event: EventMap[K]) => void
  ): this {
    if (this._listeners === undefined) {
      return this;
    }

    const listeners = this._listeners;
    if (listeners[type]) {
      const index = listeners[type]!.indexOf(listener as any);
      if (index !== -1) {
        listeners[type]!.splice(index, 1);
      }
    }

    return this;
  }

  /**
   * Emit an event.
   * @param event The event object to emit
   * @returns The self object, for chainability.
   */
  emit<K extends keyof EventMap>(event: EventMap[K]): this {
    if (this._listeners === undefined) {
      return this;
    }

    const listeners = this._listeners;
    const listenerArray = listeners[event.type as K];
    if (listenerArray !== undefined) {
      (event as any).target = this;
      for (let i = 0, l = listenerArray.length; i < l; i++) {
        const listener = listenerArray[i];
        listener.call(listener.context, event);
      }
    }

    return this;
  }
}
