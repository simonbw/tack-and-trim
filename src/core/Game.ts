import { DEFAULT_LAYER, LAYERS, LayerName } from "../config/layers";
import { TICK_LAYERS, TickLayerName } from "../config/tickLayers";
import { ContactList } from "./ContactList";
import { EntityList } from "./EntityList";
import { V } from "./Vector";
import Entity, { GameEventMap } from "./entity/Entity";
import { eventHandlerName } from "./entity/EventHandler";
import { IoEvents } from "./entity/IoEvents";
import { Draw } from "./graphics/Draw";
import { RenderManager, RenderManagerOptions } from "./graphics/RenderManager";
import { WebGPUDeviceManager, getWebGPU } from "./graphics/webgpu/WebGPUDevice";
import { WebGPURenderer } from "./graphics/webgpu/WebGPURenderer";
import { IOManager } from "./io/IO";
import type { Body } from "./physics/body/Body";
import { StaticBody } from "./physics/body/StaticBody";
import { PhysicsEventMap } from "./physics/events/PhysicsEvents";
import { World } from "./physics/world/World";
import { lerp } from "./util/MathUtil";
import { profile, profiler } from "./util/Profiler";

interface GameOptions {
  audio?: AudioContext;
  ticksPerSecond?: number;
  world?: World;
}

/** Top Level control structure */
export class Game {
  /** Keeps track of entities in lots of useful ways */
  readonly entities: EntityList;
  /** Keeps track of entities that are ready to be removed */
  readonly entitiesToRemove: Set<Entity>;
  /** The render manager - coordinates rendering */
  readonly renderer: RenderManager;
  /** Manages keyboard/mouse/gamepad state and events. */
  private _io!: IOManager;
  get io(): IOManager {
    return this._io;
  }
  private set io(value: IOManager) {
    this._io = value;
  }

  /** The top level container for physics. */
  readonly world: World;
  /** Keep track of currently occuring collisions */
  readonly contactList: ContactList;
  /** A static physics body positioned at [0,0] with no shapes. Useful for constraints/springs */
  readonly ground: Body;
  /** The audio context that is connected to the output */
  readonly audio: AudioContext;
  /** Volume control for all sound output by the game. */
  readonly masterGain: GainNode;
  /** Readonly. Whether or not the game is paused */
  paused: boolean = false;
  /** Readonly. Number of frames that have gone by */
  framenumber: number = 0;
  /** Readonly. Number of ticks that have gone by */
  ticknumber: number = 0;
  /** The timestamp when the last frame started */
  lastFrameTime: number = window.performance.now();
  /** Number of ticks that happen per frame at regular speed */
  readonly ticksPerSecond: number;
  /** Number of seconds to simulate per tick */
  readonly tickDuration: number;

  /** ID of the current animation frame request, used for cancellation */
  private animationFrameId: number = 0;
  /** Whether the game has been destroyed */
  private destroyed: boolean = false;

  /** Total amount of game time that has elapsed */
  elapsedTime: number = 0;
  /** Total amount of game time that has elapsed while not paused */
  elapsedUnpausedTime: number = 0;
  /** Keep track of how long each frame is taking on average */
  averageFrameDuration = 1 / 60;

  /** Get the camera */
  get camera() {
    return this.renderer.camera;
  }

  get averageDt() {
    return this.slowMo / (this.averageFrameDuration * this.ticksPerSecond);
  }

  private _slowMo: number = 1.0;
  /** Multiplier of time that passes during tick */
  get slowMo() {
    return this._slowMo;
  }

  set slowMo(value: number) {
    if (value != this._slowMo) {
      this._slowMo = value;
      this.dispatch("slowMoChanged", { slowMo: this._slowMo });
    }
  }

  /**
   * Create a new Game.
   * NOTE: You must call .init() before actually using the game.
   */
  constructor({ audio, ticksPerSecond = 120, world }: GameOptions = {}) {
    this.entities = new EntityList();
    this.entitiesToRemove = new Set();

    this.renderer = new RenderManager(
      LAYERS,
      DEFAULT_LAYER,
      this.onResize.bind(this),
    );

    this.ticksPerSecond = ticksPerSecond;
    this.tickDuration = 1.0 / this.ticksPerSecond;
    this.world = world ?? new World();
    this.world.on("beginContact", this.beginContact, null);
    this.world.on("endContact", this.endContact, null);
    this.world.on("impact", this.impact, null);
    this.ground = new StaticBody();
    this.world.bodies.add(this.ground);
    this.contactList = new ContactList();

    this.audio = audio ?? new AudioContext();
    this.masterGain = this.audio.createGain();
    this.masterGain.connect(this.audio.destination);
  }

  /** Whether WebGPU has been initialized */
  private webGpuInitialized = false;

  /** Start the event loop for the game. */
  async init({
    rendererOptions = {},
  }: {
    rendererOptions?: RenderManagerOptions;
  } = {}) {
    // Initialize WebGPU
    if (!WebGPUDeviceManager.isAvailable()) {
      throw new Error("WebGPU is not available in this browser");
    }
    await getWebGPU().init();
    this.webGpuInitialized = true;

    await this.renderer.init(rendererOptions);
    // IO events don't respect pause state
    const dispatchIo = <E extends keyof IoEvents>(
      event: E,
      data: IoEvents[E],
    ) => this.dispatch(event, data as GameEventMap[E], false);
    this.io = new IOManager(this.renderer.canvas, dispatchIo);
    this.addEntity(this.renderer.camera);

    this.animationFrameId = window.requestAnimationFrame(() =>
      this.loop(this.lastFrameTime),
    );
  }

  /** Check if WebGPU is available and initialized */
  isWebGPUEnabled(): boolean {
    return this.webGpuInitialized;
  }

  /** Get the WebGPU device manager (throws if not initialized) */
  getWebGPUDevice(): WebGPUDeviceManager {
    if (!this.webGpuInitialized) {
      throw new Error("WebGPU is not initialized");
    }
    return getWebGPU();
  }

  /** See pause() and unpause(). */
  togglePause() {
    if (this.paused) {
      this.unpause();
    } else {
      this.pause();
    }
  }

  /** Called when renderer is resized */
  onResize(size: [number, number]) {
    this.dispatch("resize", { size: V(size) });
  }

  /**
   * Pauses the game. This stops physics from running, calls onPause()
   * handlers, and stops updating `pausable` entities.
   */
  pause() {
    if (!this.paused) {
      this.paused = true;
      this.dispatch("pause", undefined);
    }
  }

  /** Resumes the game and calls onUnpause() handlers. */
  unpause() {
    this.paused = false;
    this.dispatch("unpause", undefined);
  }

  /** Destroy the game and clean up all resources. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    // Cancel the animation frame loop
    window.cancelAnimationFrame(this.animationFrameId);

    // Destroy all entities
    for (const entity of this.entities) {
      this.cleanupEntity(entity);
    }
    this.entitiesToRemove.clear();

    // Remove physics world event listeners
    this.world.off("beginContact", this.beginContact);
    this.world.off("endContact", this.endContact);
    this.world.off("impact", this.impact);

    // Clear physics world
    this.world.clear();

    // Destroy IO manager (clears interval and event listeners)
    this.io.destroy();

    // Destroy renderer
    this.renderer.destroy();

    // Close audio context
    this.audio.close();
  }

  /** Dispatch an event. */
  dispatch<EventName extends keyof GameEventMap>(
    eventName: EventName,
    data: GameEventMap[EventName],
    respectPause = true,
  ) {
    const effectivelyPaused = respectPause && this.paused;
    for (const entity of this.entities.getHandlers(eventName)) {
      if (entity.game && !(effectivelyPaused && !entity.pausable)) {
        const functionName = eventHandlerName(eventName);
        const handler = entity[functionName];
        if (typeof handler !== "function") {
          console.error(
            `Entity ${entity.constructor.name} registered for "${eventName}" but has no ${functionName} method`,
            entity,
          );
          continue;
        }
        handler.call(entity, data);
      }
    }
  }

  /** Add an entity to the game. */
  addEntity = <T extends Entity>(entity: T): T => {
    entity.game = this;
    if (entity.onAdd) {
      entity.onAdd({ game: this });
    }

    // If the entity was destroyed during it's onAdd, we shouldn't add it
    if (!entity.isAdded) {
      return entity;
    }

    this.entities.add(entity);

    if (entity.body) {
      entity.body.owner = entity;
      this.world.bodies.add(entity.body);
    }
    if (entity.bodies) {
      for (const body of entity.bodies) {
        body.owner = entity;
        this.world.bodies.add(body);
      }
    }
    if (entity.springs) {
      for (const spring of entity.springs) {
        this.world.addSpring(spring);
      }
    }
    if (entity.constraints) {
      for (const constraint of entity.constraints) {
        this.world.constraints.add(constraint);
      }
    }

    if (entity.onResize) {
      entity.onResize({ size: this.renderer.getSize() });
    }

    if (entity.children) {
      for (const child of entity.children) {
        if (!child.isAdded) {
          this.addEntity(child);
        }
      }
    }

    if (entity.onAfterAdded) {
      entity.onAfterAdded({ game: this });
    }

    return entity;
  };

  /** Shortcut for adding multiple entities. */
  addEntities<T extends readonly Entity[]>(...entities: T): T {
    for (const entity of entities) {
      this.addEntity(entity);
    }
    return entities;
  }

  /**
   * Remove an entity from the game.
   * The entity will actually be removed during the next removal pass.
   * This is because there are times when it's not safe to remove an entity, like in the middle of a physics step.
   */
  removeEntity(entity: Entity) {
    (entity as any).game = undefined;
    if (this.world.stepping) {
      this.entitiesToRemove.add(entity);
    } else {
      this.cleanupEntity(entity);
    }
    return entity;
  }

  /**
   * Removes all non-persistent entities from the game scene.
   * Only removes top-level entities (those without parents) to avoid double-cleanup.
   *
   * @param persistenceThreshold - Entities with persistence level <= this value will be removed (default: 0)
   */
  clearScene(persistenceThreshold = 0) {
    for (const entity of this.entities) {
      if (
        entity.game && // Not already destroyed
        !this.entitiesToRemove.has(entity) && // not already about to be destroyed
        entity.persistenceLevel <= persistenceThreshold &&
        !entity.parent // We only wanna deal with top-level things, let parents handle the rest
      ) {
        entity.destroy();
      }
    }
  }

  private timeToSimulate = 0.0;
  /** Audio time at the end of the last frame's tick loop */
  private lastAudioTime: number = 0;

  /** The main event loop. Run one frame of the game.  */
  @profile
  private async loop(time: number): Promise<void> {
    if (this.destroyed) return;

    this.framenumber += 1;

    const lastFrameDuration = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;

    // Keep a rolling average
    if (0 < lastFrameDuration && lastFrameDuration < 0.3) {
      // Ignore weird durations because they're probably flukes from the user
      // changing to a different tab/window or loading a new level or something
      this.averageFrameDuration = lerp(
        this.averageFrameDuration,
        lastFrameDuration,
        0.05,
      );
    }

    const renderDt = 1.0 / this.getScreenFps();
    this.elapsedTime += renderDt;
    if (!this.paused) {
      this.elapsedUnpausedTime += renderDt;
    }

    this.slowTick(renderDt * this.slowMo);

    this.timeToSimulate += renderDt * this.slowMo;

    // Distribute real audio time evenly across this frame's ticks
    const audioNow = this.audio.currentTime;
    const tickCount = Math.floor(this.timeToSimulate / this.tickDuration);
    const audioTimeStep =
      tickCount > 0 ? (audioNow - this.lastAudioTime) / tickCount : 0;
    let tickAudioTime = this.lastAudioTime;

    while (this.timeToSimulate >= this.tickDuration) {
      this.timeToSimulate -= this.tickDuration;
      tickAudioTime += audioTimeStep;

      await this.tick(this.tickDuration, tickAudioTime);

      if (!this.paused) {
        const stepDt = this.tickDuration;
        this.world.step(stepDt);
        profiler.measure("Game.afterPhysicsStep", () => {
          this.dispatch("afterPhysicsStep", stepDt);
          this.cleanupEntities();
        });

        this.contacts();
      }
    }

    this.lastAudioTime = audioNow;

    this.afterPhysics();

    this.render(renderDt);

    // CRITICAL: Request next frame at END to prevent concurrent loops
    this.animationFrameId = window.requestAnimationFrame((t) => this.loop(t));
  }

  /**
   * Calculates and returns the current screen frames per second based on average frame duration.
   * @returns The current FPS rounded to the nearest integer
   */
  getScreenFps(): number {
    const duration = this.averageFrameDuration;
    return Math.round(1.0 / duration);
  }

  /** Actually remove all the entities slated for removal from the game. */
  private cleanupEntities() {
    for (const entity of this.entitiesToRemove) {
      this.cleanupEntity(entity);
    }
    this.entitiesToRemove.clear();
  }

  private cleanupEntity(entity: Entity) {
    (entity as any).game = undefined; // This should be done by `removeEntity`, but better safe than sorry
    this.entities.remove(entity);

    if (entity.body) {
      this.world.bodies.remove(entity.body);
    }
    if (entity.bodies) {
      for (const body of entity.bodies) {
        this.world.bodies.remove(body);
      }
    }
    if (entity.springs) {
      for (const spring of entity.springs) {
        this.world.removeSpring(spring);
      }
    }
    if (entity.constraints) {
      for (const constraint of entity.constraints) {
        this.world.constraints.remove(constraint);
      }
    }

    if (entity.onDestroy) {
      entity.onDestroy({ game: this });
    }
  }

  /** Called before physics. */
  @profile
  private async tick(dt: number, audioTime: number): Promise<void> {
    this.ticknumber += 1;

    const tickData: GameEventMap["tick"] = { dt, audioTime };

    // Dispatch tick events layer by layer
    for (const layerName of TICK_LAYERS) {
      await profiler.measure(`tick.${layerName}`, () =>
        this.dispatchTickForLayer(layerName, tickData),
      );
    }
  }

  /** Dispatch tick event to entities on a specific layer */
  private async dispatchTickForLayer(
    layerName: TickLayerName,
    tickData: GameEventMap["tick"],
  ): Promise<void> {
    const effectivelyPaused = this.paused;
    const promises: Promise<void>[] = [];

    for (const entity of this.entities.getTickersOnLayer(layerName)) {
      if (entity.game && !(effectivelyPaused && !entity.pausable)) {
        const result = entity.onTick?.(tickData);
        // Only collect actual Promises
        if (result && result instanceof Promise) {
          promises.push(result);
        }
      }
    }

    // Only await if there were any Promises
    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /** Called before normal ticks */
  @profile
  private slowTick(dt: number) {
    this.dispatch("slowTick", dt);
  }

  /** Called after physics. */
  private afterPhysics() {
    this.cleanupEntities();
    this.dispatch("afterPhysics", undefined);
  }

  /** Get the low-level renderer for direct drawing */
  getRenderer(): WebGPURenderer {
    return this.renderer.getRenderer();
  }

  /**
   * Enable or disable GPU timing.
   * When enabled, GPU render time will appear in profiler under "gpu".
   */
  setGpuTimingEnabled(enabled: boolean): void {
    this.renderer.setGpuTimingEnabled(enabled);
  }

  /** Check if GPU timer extension is available */
  hasGpuTimerSupport(): boolean {
    return this.renderer.hasGpuTimerSupport();
  }

  /** Called to render the current frame. */
  @profile
  private render(dt: number) {
    this.cleanupEntities();

    // Begin frame
    this.renderer.beginFrame();

    // Create Draw context for this frame
    const draw = new Draw(this.renderer.getRenderer(), this.renderer.camera);

    // Render each layer in order
    const layerNames = this.renderer.getLayerNames();
    for (const layerName of layerNames) {
      profiler.measure(`layer.${layerName}`, () => {
        // Set the camera transform for this layer
        this.renderer.setLayer(layerName);

        // Dispatch render event for entities on this layer
        this.dispatchRenderForLayer(layerName, dt, draw);
      });
    }

    // End frame
    this.renderer.endFrame();
  }

  /** Dispatch render event to entities on a specific layer */
  private dispatchRenderForLayer(layerName: LayerName, dt: number, draw: Draw) {
    const effectivelyPaused = this.paused;
    const renderData = { dt, layer: layerName, draw, camera: draw.camera };

    for (const entity of this.entities.getRenderersOnLayer(layerName)) {
      if (entity.game && !(effectivelyPaused && !entity.pausable)) {
        entity.onRender?.(renderData);
      }
    }
  }

  // Handle beginning of collision between things.
  // Fired during narrowphase.
  private beginContact = (event: PhysicsEventMap["beginContact"]) => {
    this.contactList.beginContact(event);
    const { shapeA, shapeB, bodyA, bodyB, contactEquations } = event;
    const ownerA = shapeA.owner ?? bodyA.owner;
    const ownerB = shapeB.owner ?? bodyB.owner;

    // If either owner has been removed from the game, we shouldn't do the contact
    if (ownerA?.game && ownerB?.game) {
      if (ownerA?.onBeginContact) {
        ownerA.onBeginContact({
          other: ownerB,
          thisShape: shapeA,
          otherShape: shapeB,
          contactEquations,
        });
      }
      if (ownerB?.onBeginContact) {
        ownerB.onBeginContact({
          other: ownerA,
          thisShape: shapeB,
          otherShape: shapeA,
          contactEquations,
        });
      }
    }
  };

  // Handle end of collision between things.
  // Fired during narrowphase.
  private endContact = (event: PhysicsEventMap["endContact"]) => {
    this.contactList.endContact(event);
    const { shapeA, shapeB, bodyA, bodyB } = event;
    const ownerA = shapeA.owner ?? bodyA.owner;
    const ownerB = shapeB.owner ?? bodyB.owner;

    // If either owner has been removed from the game, we shouldn't do the contact
    if (ownerA?.game && ownerB?.game) {
      if (ownerA?.onEndContact) {
        ownerA.onEndContact({
          other: ownerB,
          thisShape: shapeA,
          otherShape: shapeB,
        });
      }
      if (ownerB?.onEndContact) {
        ownerB.onEndContact({
          other: ownerA,
          thisShape: shapeB,
          otherShape: shapeA,
        });
      }
    }
  };

  @profile
  private contacts() {
    for (const contact of this.contactList.getContacts()) {
      const { shapeA, shapeB, bodyA, bodyB, contactEquations } = contact;
      const ownerA = shapeA.owner ?? bodyA.owner;
      const ownerB = shapeB.owner ?? bodyB.owner;
      if (ownerA?.onContacting) {
        ownerA.onContacting({
          other: ownerB,
          otherShape: shapeB,
          thisShape: shapeA,
          contactEquations,
        });
      }
      if (ownerB?.onContacting) {
        ownerB.onContacting({
          other: ownerA,
          otherShape: shapeA,
          thisShape: shapeB,
          contactEquations,
        });
      }
    }
  }

  // Handle collision between things.
  // Fired after physics step.
  private impact = (event: PhysicsEventMap["impact"]) => {
    const ownerA = event.bodyA.owner;
    const ownerB = event.bodyB.owner;
    // If either owner has been removed from the game, we shouldn't do the contact
    if (ownerA?.game && ownerB?.game) {
      if (ownerA?.onImpact) {
        ownerA.onImpact({ other: ownerB });
      }
      if (ownerB?.onImpact) {
        ownerB.onImpact({ other: ownerA });
      }
    }
  };
}
