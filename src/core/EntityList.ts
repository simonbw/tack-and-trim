import { DEFAULT_LAYER } from "../config/layers";
import { DEFAULT_TICK_LAYER } from "../config/tickLayers";
import Entity, { GameEventHandler, GameEventName } from "./entity/Entity";
import { getHandlers } from "./entity/handler";
import { EntityFilter, hasBody } from "./EntityFilter";
import { FilterMultiMap } from "./util/FilterListMap";
import { MultiMap } from "./util/MultiMap";

/** Constructor type for entity classes (supports both concrete and abstract classes) */
export type Constructor<T = Entity> =
  | (new (...args: any[]) => T)
  | (abstract new (...args: any[]) => T);

/** Keeps track of entities. Has lots of useful indexes. */
export class EntityList implements Iterable<Entity> {
  /** Maps entity ids to entities */
  private idToEntity = new Map<string, Entity>();
  /** Maps tags to entities */
  private tagged = new MultiMap<string, Entity>();
  /** Maps event types to entities that handle them */
  private handlers = new MultiMap<GameEventName, Entity>();
  /** Maps filters to entities that pass them */
  private filters = new FilterMultiMap<Entity>();
  /** Maps render layers to entities that render on them */
  private renderLayerEntities = new MultiMap<string, Entity>();
  /** Maps tick layers to entities that tick on them */
  private tickLayerEntities = new MultiMap<string, Entity>();
  /** Maps constructors to entities of that type */
  private constructorMap = new MultiMap<Constructor<Entity>, Entity>();
  /** All entities */
  all = new Set<Entity>();

  constructor() {
    this.addFilter(hasBody);
  }

  get withBody() {
    return this.getByFilter(hasBody);
  }

  /** Adds an entity to this list and all sublists and does all the bookkeeping */
  add(entity: Entity) {
    this.all.add(entity);

    this.filters.addItem(entity);

    if (entity.tags) {
      for (const tag of entity.tags) {
        this.tagged.add(tag, entity);
      }
    }

    for (const eventName of getHandlers(entity)) {
      this.handlers.add(eventName, entity);
    }

    // Index by render layer for efficient per-layer rendering
    if (this.handlers.get("render").has(entity)) {
      const layers = entity.layers ?? [entity.layer ?? DEFAULT_LAYER];
      for (const layer of layers) {
        this.renderLayerEntities.add(layer, entity);
      }
    }

    // Index by tick layer for efficient per-layer ticking
    if (this.handlers.get("tick").has(entity)) {
      const tickLayers = entity.tickLayers ?? [
        entity.tickLayer ?? DEFAULT_TICK_LAYER,
      ];
      for (const layer of tickLayers) {
        this.tickLayerEntities.add(layer, entity);
      }
    }

    // Index by constructor for type-based queries
    this.constructorMap.add(entity.constructor as Constructor<Entity>, entity);

    if (entity.id) {
      if (this.idToEntity.has(entity.id)) {
        throw new Error(`entities with duplicate ids: ${entity.id}`);
      }
      this.idToEntity.set(entity.id, entity);
    }
  }

  /** Removes an entity from this list and all the sublists and does some bookkeeping */
  remove(entity: Entity) {
    this.all.delete(entity);

    this.filters.removeItem(entity);

    if (entity.tags) {
      for (const tag of entity.tags) {
        this.tagged.remove(tag, entity);
      }
    }

    // Remove from layer index before removing from handlers (need to check handlers.has first)
    if (this.handlers.has("render", entity)) {
      const layers = entity.layers ?? [entity.layer ?? DEFAULT_LAYER];
      for (const layer of layers) {
        this.renderLayerEntities.remove(layer, entity);
      }
    }

    // Remove from tick layer index before removing from handlers
    if (this.handlers.has("tick", entity)) {
      const tickLayers = entity.tickLayers ?? [
        entity.tickLayer ?? DEFAULT_TICK_LAYER,
      ];
      for (const layer of tickLayers) {
        this.tickLayerEntities.remove(layer, entity);
      }
    }

    for (const eventName of getHandlers(entity)) {
      this.handlers.remove(eventName, entity);
    }

    // Remove from constructor index
    this.constructorMap.remove(
      entity.constructor as Constructor<Entity>,
      entity,
    );

    if (entity.id) {
      this.idToEntity.delete(entity.id);
    }
  }

  /** Get the entity with the given id. */
  getById(id: string) {
    return this.idToEntity.get(id);
  }

  /** Returns all entities with the given tag. */
  getTagged(tag: string): Iterable<Entity> {
    return this.tagged.get(tag);
  }

  /** Returns all entities that have all the given tags */
  getTaggedAll(...tags: string[]): Iterable<Entity> {
    if (tags.length === 0) {
      return [];
    }
    const result = new Set<Entity>();
    const [firstTag, ...otherTags] = tags;
    for (const e of this.getTagged(firstTag)) {
      if (otherTags.every((t) => e.tags!.includes(t))) {
        result.add(e);
      }
    }
    return result;
  }

  /** Returns all entities that have at least one of the given tags */
  getTaggedAny(...tags: string[]): Iterable<Entity> {
    const result = new Set<Entity>();
    for (const tag of tags) {
      for (const e of this.getTagged(tag)) {
        result.add(e);
      }
    }
    return result;
  }

  /** Adds a filter for fast lookup with getByFilter() in the future. */
  addFilter<T extends Entity>(filter: EntityFilter<T>): void {
    this.filters.addFilter(filter, this.all);
  }

  /** Removes a filter that was added with addFilter(). */
  removeFilter<T extends Entity>(filter: EntityFilter<T>): void {
    this.filters.removeFilter(filter);
  }

  /**
   * Return all the entities that pass a type guard.
   * Pair with addFilter() to make this fast.
   */
  getByFilter<T extends Entity>(
    filter: EntityFilter<T>,
  ): Iterable<T> & { readonly length: number } {
    const result = this.filters.getItems(filter);
    return result ?? [...this.all].filter(filter);
  }

  /** Get all entities that handle a specific event type. */
  getHandlers(
    eventType: GameEventName,
  ): Iterable<Entity & GameEventHandler<GameEventName>> {
    return this.handlers.get(eventType) as Iterable<
      Entity & GameEventHandler<GameEventName>
    >;
  }

  /** Get all entities that render on a specific layer. */
  getRenderersOnLayer(layer: string): Iterable<Entity> {
    return this.renderLayerEntities.get(layer);
  }

  /** Get all entities that tick on a specific layer. */
  getTickersOnLayer(layer: string): Iterable<Entity> {
    return this.tickLayerEntities.get(layer);
  }

  /**
   * Get all entities of a specific type.
   * @param constructor The entity class constructor
   * @returns A readonly set of all entities of that type
   */
  byConstructor<T extends Entity>(constructor: Constructor<T>): ReadonlySet<T> {
    return this.constructorMap.get(constructor) as ReadonlySet<T>;
  }

  /**
   * Get the single entity of a specific type.
   * Throws if zero or multiple instances are found.
   * @param constructor The entity class constructor
   * @returns The single entity of that type
   */
  getSingleton<T extends Entity>(constructor: Constructor<T>): T {
    const instances = this.byConstructor(constructor);
    if (instances.size === 0) {
      throw new Error(`No instance of ${constructor.name} found`);
    }
    if (instances.size > 1) {
      throw new Error(
        `Multiple instances of ${constructor.name} found (expected singleton)`,
      );
    }
    return [...instances][0];
  }

  /**
   * Try to get the single entity of a specific type.
   * Returns undefined if not found, throws if multiple instances are found.
   * @param constructor The entity class constructor
   * @returns The single entity of that type, or undefined if not found
   */
  tryGetSingleton<T extends Entity>(
    constructor: Constructor<T>,
  ): T | undefined {
    const instances = this.byConstructor(constructor);
    if (instances.size === 0) {
      return undefined;
    }
    if (instances.size > 1) {
      throw new Error(
        `Multiple instances of ${constructor.name} found (expected singleton)`,
      );
    }
    return [...instances][0];
  }

  /** Iterate through all the entities. */
  [Symbol.iterator]() {
    return this.all[Symbol.iterator]();
  }
}
