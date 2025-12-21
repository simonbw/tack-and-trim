/**
 * Global event types that can be dispatched by the Game and listened to by entities.
 */
export type CustomEvents = {
  /** An example event.
   *
   * Call game.dispatch('exampleEvent', { level: 1, message: 'example message' }) to dispatch this event.
   * Add an onExampleEvent({ level, message }) function to an entity to listen to this event.
   */
  exampleEvent: { level: number; message: string };
};
