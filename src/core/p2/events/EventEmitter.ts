/**
 * Event object passed to listeners
 */
export interface P2Event {
  type: string;
  target?: EventEmitter;
}

/**
 * Listener function with optional context
 */
interface ListenerWithContext {
  (event: P2Event): void;
  context?: unknown;
}

/**
 * Base class for objects that dispatch events.
 */
export default class EventEmitter {
  private _listeners?: Record<string, ListenerWithContext[]>;

  /**
   * Add an event listener
   * @param type Event type
   * @param listener Callback function
   * @param context Optional context to bind the listener to
   * @returns The self object, for chainability.
   */
  on(
    type: string,
    listener: (event: P2Event) => void,
    context?: unknown
  ): this {
    const listenerWithContext = listener as ListenerWithContext;
    listenerWithContext.context = context ?? this;

    if (this._listeners === undefined) {
      this._listeners = {};
    }

    const listeners = this._listeners;
    if (listeners[type] === undefined) {
      listeners[type] = [];
    }

    if (listeners[type].indexOf(listenerWithContext) === -1) {
      listeners[type].push(listenerWithContext);
    }

    return this;
  }

  /**
   * Check if an event listener is added
   * @param type Event type
   * @param listener Optional specific listener to check for
   * @returns True if listener(s) exist for the type
   */
  has(type: string, listener?: (event: P2Event) => void): boolean {
    if (this._listeners === undefined) {
      return false;
    }

    const listeners = this._listeners;
    if (listener) {
      if (
        listeners[type] !== undefined &&
        listeners[type].indexOf(listener as ListenerWithContext) !== -1
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
  off(type: string, listener: (event: P2Event) => void): this {
    if (this._listeners === undefined) {
      return this;
    }

    const listeners = this._listeners;
    const index = listeners[type].indexOf(listener as ListenerWithContext);
    if (index !== -1) {
      listeners[type].splice(index, 1);
    }

    return this;
  }

  /**
   * Emit an event.
   * @param event The event object to emit
   * @returns The self object, for chainability.
   */
  emit(event: P2Event): this {
    if (this._listeners === undefined) {
      return this;
    }

    const listeners = this._listeners;
    const listenerArray = listeners[event.type];
    if (listenerArray !== undefined) {
      event.target = this;
      for (let i = 0, l = listenerArray.length; i < l; i++) {
        const listener = listenerArray[i];
        listener.call(listener.context, event);
      }
    }

    return this;
  }
}
