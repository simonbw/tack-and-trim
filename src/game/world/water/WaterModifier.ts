/**
 * Axis-Aligned Bounding Box for spatial queries
 */
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Water modifier data types
 */
export type WaterModifierData =
  | { type: "wake"; strength: number; direction: number }
  | { type: "current"; velocity: { x: number; y: number } }
  | { type: "obstacle"; dampingFactor: number };

/**
 * Interface for objects that modify water behavior in a spatial region
 */
export interface WaterModifier {
  /**
   * Spatial bounds of this modifier's influence
   */
  getBounds(): AABB;

  /**
   * Get modifier data at a specific point
   * Returns undefined if point is outside influence area
   */
  getModifierAt(x: number, y: number): WaterModifierData | undefined;
}
