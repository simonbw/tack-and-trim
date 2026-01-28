/**
 * Terrain type classification for terrain queries
 */
export enum TerrainType {
  Grass = 0,
  Sand = 1,
  Rock = 2,
  Water = 3,
}

/**
 * Type guard for valid terrain type values
 */
export function isValidTerrainType(value: number): value is TerrainType {
  return value >= 0 && value <= 3 && Number.isInteger(value);
}
