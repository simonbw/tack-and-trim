import { World, Body } from "./physics";
import { DEFAULT_LAYER, LAYERS } from "../config/layers";
import ContactList, {
  ContactInfo,
  ContactInfoWithEquations,
} from "./ContactList";
import EntityList from "./EntityList";
import { V } from "./Vector";
import Entity, { GameEventMap } from "./entity/Entity";
import { eventHandlerName } from "./entity/EventHandler";
import { WithOwner } from "./entity/WithOwner";
import {
  GameRenderer2d,
  GameRenderer2dOptions,
} from "./graphics/GameRenderer2d";
import { IOManager } from "./io/IO";
import { lerp } from "./util/MathUtil";

interface GameOptions {
  audio?: AudioContext;
  ticksPerSecond?: number;
  world?: World;
}

/**
 * Top Level control structure
 */
export default class Game {
  /** Keeps track of entities in lots of useful ways */
  readonly entities: EntityList;
  /** Keeps track of entities that are ready to be removed */
  readonly entitiesToRemove: Set<Entity>;
  /** TODO: Document game.renderer */
  readonly renderer: GameRenderer2d;
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

  /** TODO: Document game.camera */
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

    this.renderer = new GameRenderer2d(
      LAYERS,
      DEFAULT_LAYER,
      this.onResize.bind(this)
    );

    this.ticksPerSecond = ticksPerSecond;
    this.tickDuration = 1.0 / this.ticksPerSecond;
    this.world = world ?? new World({ gravity: [0, 0] });
    this.world.on("beginContact", this.beginContact as any, null);
    this.world.on("endContact", this.endContact as any, null);
    this.world.on("impact", this.impact as any, null);
    this.ground = new Body({ mass: 0 });
    this.world.addBody(this.ground);
    this.contactList = new ContactList();

    this.audio = audio ?? new AudioContext();
    this.masterGain = this.audio.createGain();
    this.masterGain.connect(this.audio.destination);
  }

  /** Start the event loop for the game. */
  async init({
    rendererOptions = {},
  }: {
    rendererOptions?: GameRenderer2dOptions;
  } = {}) {
    await this.renderer.init(rendererOptions);
    this.io = new IOManager(this.renderer.canvas);
    this.addEntity(this.renderer.camera);

    this.animationFrameId = window.requestAnimationFrame(() =>
      this.loop(this.lastFrameTime)
    );
  }

  /** See pause() and unpause(). */
  togglePause() {
    if (this.paused) {
      this.unpause();
    } else {
      this.pause();
    }
  }

  /** TODO: Document onResize */
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
    this.world.off("beginContact", this.beginContact as any);
    this.world.off("endContact", this.endContact as any);
    this.world.off("impact", this.impact as any);

    // Clear physics world
    this.world.clear();

    // Destroy IO manager (clears interval and event listeners)
    this.io.destroy();

    // Destroy renderer (removes resize listener, destroys Pixi app)
    this.renderer.destroy();

    // Close audio context
    this.audio.close();
  }

  /** Dispatch an event. */
  dispatch<EventName extends keyof GameEventMap>(
    eventName: EventName,
    data: GameEventMap[EventName],
    respectPause = true
  ) {
    const effectivelyPaused = respectPause && this.paused;
    for (const entity of this.entities.getHandlers(eventName)) {
      if (entity.game && !(effectivelyPaused && !entity.pausable)) {
        const functionName = eventHandlerName(eventName);
        entity[functionName](data);
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
    if (!entity.game) {
      return entity;
    }

    this.entities.add(entity);
    this.io.addHandler(entity);

    if (entity.body) {
      entity.body.owner = entity;
      this.world.addBody(entity.body);
    }
    if (entity.bodies) {
      for (const body of entity.bodies) {
        body.owner = entity;
        this.world.addBody(body);
      }
    }
    if (entity.springs) {
      for (const spring of entity.springs) {
        this.world.addSpring(spring);
      }
    }
    if (entity.constraints) {
      for (const constraint of entity.constraints) {
        this.world.addConstraint(constraint);
      }
    }

    if (entity.sprite) {
      this.renderer.addSprite(entity.sprite);
      entity.sprite.owner = entity;
    }
    if (entity.sprites) {
      for (const sprite of entity.sprites) {
        this.renderer.addSprite(sprite);
        sprite.owner = entity;
      }
    }

    if (entity.onResize) {
      entity.onResize({ size: this.renderer.getSize() });
    }

    if (entity.children) {
      for (const child of entity.children) {
        if (!child.game) {
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
    entity.game = undefined;
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
   * @example
   * // Remove all level-specific entities (Persistence.Level)
   * game.clearScene();
   *
   * // Remove level and game-specific entities (Persistence.Level and Persistence.Game)
   * game.clearScene(Persistence.Game);
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
  private iterationsRemaining = 0.0;
  /** The main event loop. Run one frame of the game.  */
  private loop(time: number): void {
    if (this.destroyed) return;
    this.animationFrameId = window.requestAnimationFrame((t) => this.loop(t));
    this.framenumber += 1;

    const lastFrameDuration = (time - this.lastFrameTime) / 1000;
    this.lastFrameTime = time;

    // TODO: This honestly doesn't work great
    // Keep a rolling average
    if (0 < lastFrameDuration && lastFrameDuration < 0.3) {
      // Ignore weird durations because they're probably flukes from the user
      // changing to a different tab/window or loading a new level or something
      this.averageFrameDuration = lerp(
        this.averageFrameDuration,
        lastFrameDuration,
        0.05
      );
    }

    const renderDt = 1.0 / this.getScreenFps();
    this.elapsedTime += renderDt;
    if (!this.paused) {
      this.elapsedUnpausedTime += renderDt;
    }

    this.slowTick(renderDt * this.slowMo);

    this.timeToSimulate += renderDt * this.slowMo;
    while (this.timeToSimulate >= this.tickDuration) {
      this.timeToSimulate -= this.tickDuration;
      this.tick(this.tickDuration);
      if (!this.paused) {
        const stepDt = this.tickDuration;
        this.world.step(stepDt);
        this.validatePhysics();
        this.cleanupEntities();
        this.contacts();
      }
    }

    this.afterPhysics();

    this.render(renderDt);
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
    entity.game = undefined; // This should be done by `removeEntity`, but better safe than sorry
    this.entities.remove(entity);
    this.io.removeHandler(entity);

    if (entity.body) {
      this.world.removeBody(entity.body);
    }
    if (entity.bodies) {
      for (const body of entity.bodies) {
        this.world.removeBody(body);
      }
    }
    if (entity.springs) {
      for (const spring of entity.springs) {
        this.world.removeSpring(spring);
      }
    }
    if (entity.constraints) {
      for (const constraint of entity.constraints) {
        this.world.removeConstraint(constraint);
      }
    }

    if (entity.sprite) {
      this.renderer.removeSprite(entity.sprite);
      entity.sprite.destroy({ children: true });
    }
    if (entity.sprites) {
      for (const sprite of entity.sprites) {
        this.renderer.removeSprite(sprite);
        sprite.destroy({ children: true });
      }
    }

    if (entity.onDestroy) {
      entity.onDestroy({ game: this });
    }
  }

  /** Called before physics. */
  private tick(dt: number) {
    this.ticknumber += 1;
    this.dispatch("beforeTick", dt);
    this.dispatch("tick", dt);
  }

  /** Called before normal ticks */
  private slowTick(dt: number) {
    this.dispatch("slowTick", dt);
  }

  /** Called after physics. */
  private afterPhysics() {
    this.cleanupEntities();
    this.dispatch("afterPhysics", undefined);
  }

  /** Validate physics state and reset any bodies that have gone unstable. */
  private validatePhysics() {
    const MAX_POSITION = 10000;
    const MAX_VELOCITY = 500;

    for (const body of this.world.bodies) {
      if (body.type === Body.STATIC) continue;

      const [x, y] = body.position;
      const [vx, vy] = body.velocity;

      // Check for NaN/Infinity or extreme positions
      const positionBad =
        !isFinite(x) ||
        !isFinite(y) ||
        Math.abs(x) > MAX_POSITION ||
        Math.abs(y) > MAX_POSITION;
      const velocityBad = !isFinite(vx) || !isFinite(vy);

      if (positionBad || velocityBad) {
        const owner = (body as Body & { owner?: Entity }).owner;
        console.warn(
          "Physics instability detected, resetting body:",
          owner?.constructor?.name ?? "unknown",
          {
            position: [x, y],
            velocity: [vx, vy],
            angularVelocity: body.angularVelocity,
          }
        );
        body.position.set(0, 0);
        body.velocity.set(0, 0);
        body.angularVelocity = 0;
        continue;
      }

      // Clamp extreme velocities
      const speed = Math.sqrt(vx * vx + vy * vy);
      if (speed > MAX_VELOCITY) {
        const owner = (body as Body & { owner?: Entity }).owner;
        console.warn(
          "Physics velocity clamped:",
          owner?.constructor?.name ?? "unknown",
          { speed, maxVelocity: MAX_VELOCITY }
        );
        const scale = MAX_VELOCITY / speed;
        body.velocity[0] *= scale;
        body.velocity[1] *= scale;
      }
    }
  }

  /** Called before actually rendering. */
  private render(dt: number) {
    this.cleanupEntities();
    this.dispatch("render", dt);
    this.dispatch("lateRender", dt);
    this.renderer.render();
  }

  // Handle beginning of collision between things.
  // Fired during narrowphase.
  private beginContact = (contactInfo: ContactInfoWithEquations) => {
    this.contactList.beginContact(contactInfo);
    const { shapeA, shapeB, bodyA, bodyB, contactEquations } = contactInfo;
    const ownerA = shapeA.owner || bodyA.owner;
    const ownerB = shapeB.owner || bodyB.owner;

    // If either owner has been removed from the game, we shouldn't do the contact
    if (!(ownerA && !ownerA.game) || (ownerB && !ownerB.game)) {
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
  private endContact = (contactInfo: ContactInfo) => {
    this.contactList.endContact(contactInfo);
    const { shapeA, shapeB, bodyA, bodyB } = contactInfo;
    const ownerA = shapeA.owner || bodyA.owner;
    const ownerB = shapeB.owner || bodyB.owner;

    // If either owner has been removed from the game, we shouldn't do the contact
    if (!(ownerA && !ownerA.game) || (ownerB && !ownerB.game)) {
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

  private contacts() {
    for (const contactInfo of this.contactList.getContacts()) {
      const { shapeA, shapeB, bodyA, bodyB, contactEquations } = contactInfo;
      const ownerA = shapeA.owner || bodyA.owner;
      const ownerB = shapeB.owner || bodyB.owner;
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
  private impact = (e: {
    bodyA: Body & WithOwner;
    bodyB: Body & WithOwner;
  }) => {
    const ownerA = e.bodyA.owner;
    const ownerB = e.bodyB.owner;
    // If either owner has been removed from the game, we shouldn't do the contact
    if (!(ownerA && !ownerA.game) || (ownerB && !ownerB.game)) {
      if (ownerA?.onImpact) {
        ownerA.onImpact({ other: ownerB });
      }
      if (ownerB?.onImpact) {
        ownerB.onImpact({ other: ownerA });
      }
    }
  };
}
