/**
 * Rope obstacle primitives.
 *
 * A rope obstacle is a 1D curve in hull-local 3D space that rope segments
 * cannot pass through. The `RopeObstacleCollider` tests each rope segment
 * against each obstacle every tick and enforces a pulley-style wrap
 * constraint at the geometrically-correct bend point when a crossing is
 * detected.
 *
 * Obstacle types are a tagged union to allow future extension (stanchions,
 * mast, boom, shrouds, lifelines). V1 supports gunwale edges only.
 */

export type RopeObstacle = GunwaleEdgeObstacle;

/**
 * A single edge of the hull's deck polygon at z = deckHeight. Rope segments
 * that straddle this edge (one particle inside the hull, the other outside)
 * are wrapped around the edge via a pulley constraint.
 */
export interface GunwaleEdgeObstacle {
  readonly kind: "gunwaleEdge";
  /** Endpoint A, hull-local XY. */
  readonly ax: number;
  readonly ay: number;
  /** Endpoint B, hull-local XY. */
  readonly bx: number;
  readonly by: number;
  /** Outward unit normal (hull-local XY). Points away from the hull interior. */
  readonly nx: number;
  readonly ny: number;
  /** Unit tangent from A to B (hull-local XY). */
  readonly tx: number;
  readonly ty: number;
  /** Length from A to B. */
  readonly length: number;
  /** Hull-local z of the edge (deckHeight). */
  readonly z: number;
}

/**
 * Build gunwale-edge obstacles from a CCW deck polygon at the given z.
 *
 * Assumes the input polygon is counter-clockwise in hull-local XY. Each
 * consecutive pair of vertices becomes one `GunwaleEdgeObstacle` with
 * precomputed tangent, outward normal, and length.
 */
export function buildGunwaleObstacles(
  deckPolygon: ReadonlyArray<readonly [number, number]>,
  deckHeight: number,
): GunwaleEdgeObstacle[] {
  const n = deckPolygon.length;
  if (n < 3) return [];

  // Determine winding via signed area: >0 CCW, <0 CW.
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [xi, yi] = deckPolygon[i];
    const [xj, yj] = deckPolygon[(i + 1) % n];
    area += xi * yj - xj * yi;
  }
  const ccw = area >= 0;

  const out: GunwaleEdgeObstacle[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = deckPolygon[i];
    const [bx, by] = deckPolygon[(i + 1) % n];
    const ex = bx - ax;
    const ey = by - ay;
    const length = Math.hypot(ex, ey);
    if (length < 1e-10) continue;
    const tx = ex / length;
    const ty = ey / length;
    // For CCW polygons, outward normal of edge (A -> B) is (ty, -tx).
    // For CW it is (-ty, tx).
    const nx = ccw ? ty : -ty;
    const ny = ccw ? -tx : tx;
    out.push({
      kind: "gunwaleEdge",
      ax,
      ay,
      bx,
      by,
      nx,
      ny,
      tx,
      ty,
      length,
      z: deckHeight,
    });
  }
  return out;
}
