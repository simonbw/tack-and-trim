import { LayerName } from "../../config/layers";
import Game from "../Game";
import { Draw } from "../graphics/Draw";
import { V2d } from "../Vector";
import Entity from "./Entity";

/** Data passed to onRender and onLateRender callbacks */
export interface RenderEventData {
  /** Delta time since last frame */
  dt: number;
  /** The layer being rendered */
  layer: LayerName;
  /** The drawing API */
  draw: Draw;
}

export type BaseGameEvents = {
  /**
   * Called when added to the game, during the early phase of entity setup.
   *
   * At this point:
   * - `this.game` is set and accessible
   * - The entity is NOT yet in the EntityList
   * - Physics bodies/springs/constraints are NOT yet in the world
   * - Children have NOT been added yet
   * - IO handlers are NOT yet registered
   *
   * Use `onAdd` when you need access to `this.game` to complete initialization
   * but don't depend on physics or children being set up.
   *
   * If the entity is destroyed during onAdd (e.g., via `this.destroy()`),
   * the entity will not be fully added to the game.
   *
   * @see onAfterAdded - Called after all setup is complete
   */
  add: { game: Game; parent?: Entity };
  /**
   * Called after the entity is fully added to the game.
   *
   * At this point:
   * - `this.game` is set and accessible
   * - The entity IS in the EntityList (can be found via tags, id, filters)
   * - Physics bodies/springs/constraints ARE in the world
   * - All children HAVE been added
   * - IO handlers ARE registered
   * - `onResize` has been called if the entity has that handler
   *
   * Use `onAfterAdded` when you need to interact with the fully initialized
   * entity, such as querying other entities, accessing physics state, or
   * relying on children being present.
   *
   * @see onAdd - Called during early setup before physics/children
   */
  afterAdded: { game: Game };
  /** Called after physics */
  afterPhysics: void;
  /** Called after each physics step (inside the tick loop, before contacts) */
  afterPhysicsStep: number;
  /** Called before the tick happens */
  beforeTick: number;
  /** Called before rendering - use destructuring: onRender({ dt, layer, draw }) */
  render: RenderEventData;
  /** Called right before rendering, for special cases */
  lateRender: RenderEventData;
  /** Called during the update tick */
  tick: number;
  /** Called less frequently */
  slowTick: number;
  /** Called when the game is paused */
  pause: void;
  /** Called when the game is unpaused */
  unpause: void;
  /** Called after being destroyed */
  destroy: { game: Game };
  /** Called when the renderer is resized or recreated for some reason */
  resize: { size: V2d };
  /** Called when the slow motion factor changes */
  slowMoChanged: { slowMo: number };
};
