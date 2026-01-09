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
  /** Called when added to the game */
  add: { game: Game; parent?: Entity };
  /** Called right after being added to the game */
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
