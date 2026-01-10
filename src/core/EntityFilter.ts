import type Entity from "./entity/Entity";
import type { WithOwner } from "./entity/WithOwner";

export type EntityFilter<T extends Entity> = (e: Entity) => e is T;

type EntityWithBody = Entity & { body: Body & WithOwner };
export const hasBody = (e: Entity): e is EntityWithBody => Boolean(e.body);
