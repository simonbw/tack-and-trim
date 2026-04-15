/**
 * Boat grounding physics.
 *
 * Keeps the boat from sinking through the seabed and from passing through
 * terrain when running aground. One {@link TerrainContactConstraint} per
 * contact point (hull-outline vertices at draft depth, rudder, mast tip)
 * couples the hull body to `game.ground` via a point-to-rigid contact
 * equation that supplies both the normal push-up and Coulomb friction for
 * that point.
 *
 * Terrain and water heights are sampled once per tick via GPU queries
 * (1-frame latency). The owning entity keeps the cached floor-z values and
 * each constraint reads its own slot via a closure captured at construction.
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import { TerrainContactConstraint } from "../../core/physics/constraints/TerrainContactConstraint";
import { V, type V2d } from "../../core/Vector";
import { TerrainQuery } from "../world/terrain/TerrainQuery";
import { WaterQuery } from "../world/water/WaterQuery";
import type { Boat } from "./Boat";
import type { GroundingConfig } from "./BoatConfig";

export class BoatGrounding extends BaseEntity {
  private readonly boat: Boat;
  private readonly config: GroundingConfig;

  // Contact point definitions in hull-local coordinates. Order matches
  // the query point array so constraint callbacks can look up by index.
  private readonly contactLocals: { x: number; y: number; z: number }[];
  private readonly hullVertexCount: number;
  private readonly rudderIndex: number;

  // Scratch array for query point positions; reused each tick.
  private queryPoints: V2d[] = [];

  private terrainQuery: TerrainQuery;
  private waterQuery: WaterQuery;

  // Cached floor z (water-relative) per contact point, refreshed each tick.
  // `null` until the first query result arrives.
  private floorZCache: (number | null)[];

  private contactConstraints: TerrainContactConstraint[] = [];

  constructor(boat: Boat) {
    super();
    this.boat = boat;
    this.config = boat.config.grounding;

    const hullVertices = boat.config.hull.vertices;
    const rudderPos = boat.config.rudder.position;
    const hullDraft = boat.config.hull.draft;
    const rudderDraft = boat.config.rudder.draft;
    const mastPos = boat.config.rig.mastPosition;
    const mastTopZ = boat.config.rig.mainsail.zHead ?? 20;

    // One contact point under each gunwale/deck vertex, projected down to
    // the hull bottom. Sampling the full outline lets the hull rest tilted
    // on an uneven seabed rather than pivoting on a single center point.
    this.contactLocals = [];
    for (const v of hullVertices) {
      this.contactLocals.push({ x: v.x, y: v.y, z: -hullDraft });
    }
    this.hullVertexCount = hullVertices.length;

    this.contactLocals.push({
      x: rudderPos.x,
      y: rudderPos.y,
      z: -rudderDraft,
    });
    this.rudderIndex = this.contactLocals.length - 1;

    // Mast tip: hull-local XY at the mast pivot, z at the mast head. The
    // mast is rigidly attached to the hull body, so this local point
    // transforms to the mast tip world position every tick through the
    // hull's 3D orientation.
    this.contactLocals.push({ x: mastPos.x, y: mastPos.y, z: mastTopZ });

    // Pre-allocate query points (updated each tick to match current hull pose).
    for (let i = 0; i < this.contactLocals.length; i++) {
      this.queryPoints.push(V(0, 0));
    }

    this.floorZCache = new Array(this.contactLocals.length).fill(null);

    this.terrainQuery = this.addChild(new TerrainQuery(() => this.queryPoints));
    this.waterQuery = this.addChild(new WaterQuery(() => this.queryPoints));
  }

  @on("add")
  onAdd() {
    const hullBody = this.boat.hull.body;
    const ground = this.game!.ground;

    // Per-contact friction coefficients: hull vertices and the mast tip use
    // the hull friction, the rudder uses its own. Keel friction is unused
    // now that the keel isn't part of the contact set.
    const frictions: number[] = [];
    for (let i = 0; i < this.hullVertexCount; i++) {
      frictions.push(this.config.hullFriction);
    }
    frictions.push(this.config.rudderFriction);
    frictions.push(this.config.hullFriction);

    const constraints: TerrainContactConstraint[] = [];
    for (let i = 0; i < this.contactLocals.length; i++) {
      const local = this.contactLocals[i];
      const index = i;
      constraints.push(
        new TerrainContactConstraint(
          ground,
          hullBody,
          local.x,
          local.y,
          local.z,
          () => this.floorZCache[index],
          frictions[i],
          { collideConnected: true },
        ),
      );
    }
    this.contactConstraints = constraints;
    this.constraints = constraints;
  }

  @on("tick")
  onTick({ dt }: GameEventMap["tick"]) {
    const hull = this.boat.hull;
    const body = hull.body;

    // Refresh query XY to match the current hull pose so next frame's
    // terrain/water results correspond to the *current* contact positions.
    for (let i = 0; i < this.contactLocals.length; i++) {
      const local = this.contactLocals[i];
      const world = body.toWorldFrame(V(local.x, local.y));
      this.queryPoints[i].set(world[0], world[1]);
    }

    // Refresh the cached floor z values from the latest query results.
    // Water-relative frame: floorZ = terrainHeight - waterSurfaceHeight.
    const tCount = this.terrainQuery.length;
    const wCount = this.waterQuery.length;
    const count = Math.min(tCount, wCount, this.contactLocals.length);
    for (let i = 0; i < count; i++) {
      const terrainHeight = this.terrainQuery.get(i).height;
      const surfaceHeight = this.waterQuery.get(i).surfaceHeight;
      this.floorZCache[i] = terrainHeight - surfaceHeight;
    }
    for (let i = count; i < this.floorZCache.length; i++) {
      this.floorZCache[i] = null;
    }

    if (count === 0) return;

    // Accumulate grounding damage from the constraints' reported penetration.
    // The constraints handle all force application; this is gameplay
    // bookkeeping. Per-vertex contributions are averaged across the hull
    // outline so total damage stays comparable to the old single-point model.
    const speed = body.velocity.magnitude;
    if (speed < 0.01) return;

    const hullShare = this.hullVertexCount > 0 ? 1 / this.hullVertexCount : 0;
    for (let i = 0; i < this.hullVertexCount; i++) {
      const c = this.contactConstraints[i];
      if (!c.isActive()) continue;
      const penetration = c.getPenetration();
      if (penetration > 0) {
        this.boat.hullDamage.applyGroundingDamage(
          penetration * hullShare,
          speed,
          dt,
        );
      }
    }

    const rudderC = this.contactConstraints[this.rudderIndex];
    if (rudderC.isActive() && rudderC.getPenetration() > 0) {
      this.boat.rudderDamage.applyGroundingDamage(
        rudderC.getPenetration(),
        speed,
        dt,
      );
    }
  }
}
