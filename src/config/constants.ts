/** Levels of persistence for entities. Determines at what lifecycle stages the entity is cleaned up. */
export enum Persistence {
  /** DEFAULT, cleared at the end of each level */
  Level = 0,
  /** Cleared at the end of each game */
  Game = 1,
  /** Never cleared */
  Permanent = 2,
}
