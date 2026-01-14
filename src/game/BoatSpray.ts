import BaseEntity from "../core/entity/BaseEntity";
import { range } from "../core/util/FunctionalUtils";
import { clamp, lerp, lerpV2d } from "../core/util/MathUtil";
import { chooseWeighted, rNormal } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Boat } from "./boat/Boat";
import { SprayParticle } from "./SprayParticle";
import { WaterInfo } from "./water/WaterInfo";

// Spawn rate (linear with velocity and edge length)
const MIN_IMPACT_SPEED = 3; // ft/s - minimum normal velocity to generate spray
const SPAWN_PER_FT_PER_SECOND = 0.2; // particles/sec per ft of edge per ft/s of impact
const MAX_SPAWN_RATE = 500; // emergency cap (shouldn't hit normally)

// Particle size scaling with velocity
const MIN_SIZE = 0.06; // ft - at low speeds
const SIZE_VELOCITY_SCALE = 0.001; // ft per ft/s - size increase per speed increase

// Particle velocity - scales with impact for more violent spray at high speeds
const SPRAY_SPEED_SCALE = 0.5; // additional ft/s per ft/s of vNormal
const BASE_VZ = 2; // ft/s - base vertical velocity
const VZ_VELOCITY_SCALE = 0.5; // additional vz per ft/s of impact

// Wave interaction
const WAVE_BONUS_SCALE = 0.3; // How much dh/dt affects spray intensity

/**
 * Spawns spray particles from a boat's hull based on physics.
 *
 * Spray intensity is determined by:
 * - Normal component of relative velocity (hull vs water) - LINEAR
 * - Edge length (longer edges spawn more)
 * - Wave impact bonus (more spray when hitting rising waves)
 *
 * Higher velocity also produces larger particles with higher arcs,
 * giving the visual impression of more energy without exploding particle count.
 */
export class BoatSpray extends BaseEntity {
  tickLayer = "effects" as const;
  private edges: Edge[];
  private spawnAccumulator = 0;

  constructor(private boat: Boat) {
    super();
    const numEdges = boat.config.hull.vertices.length;

    const vertices = boat.config.hull.vertices;
    this.edges = range(numEdges).map((i) => new Edge(boat, i));
  }

  onTick(dt: number): void {
    const water = WaterInfo.fromGame(this.game!);

    let totalSpawnRate = 0;
    for (const edge of this.edges) {
      edge.update(water);
      totalSpawnRate += edge.spawnRate;
    }

    if (totalSpawnRate === 0) return;

    // Spawn particles
    const clampedSpawnRate = Math.min(
      SPAWN_PER_FT_PER_SECOND * totalSpawnRate,
      MAX_SPAWN_RATE,
    );
    this.spawnAccumulator += dt * clampedSpawnRate;

    while (this.spawnAccumulator >= 1) {
      const edge = chooseWeighted(this.edges, (edge) => edge.spawnRate);
      this.spawnParticle(edge);
    }
  }

  spawnParticle(edge: Edge) {
    this.spawnAccumulator -= 1;

    // Spray velocity: relative velocity plus outward spray

    // The additional velocity beyond just velocity at the point
    const spraySpeed = lerp(0, edge.vDotN * SPRAY_SPEED_SCALE, Math.random());

    // Reflect the apparent velocity off the edge (like a billiard ball).
    // reflection = v - 2(v · n)n, but we want the outward bounce, so we negate it:
    // spray direction = -v + 2(v · n)n = 2(v · n)n - v
    const sprayVelocity = edge.worldNormal
      .mul(2 * edge.vDotN)
      .isub(edge.apparentVelocity)
      .irotate(rNormal(0, 0.3))
      .inormalize(spraySpeed);

    // Size increases with impact velocity
    const maxSize = MIN_SIZE + edge.vDotN * SIZE_VELOCITY_SCALE;
    const size = lerp(MIN_SIZE, maxSize, Math.random());

    // Vertical velocity increases with impact velocity
    const minZVelocity = BASE_VZ;
    const maxZVelocity = BASE_VZ + edge.vDotN * VZ_VELOCITY_SCALE;
    const zVelocity = lerp(minZVelocity, maxZVelocity, Math.random());

    const position = edge.randomPosOnEdge();
    const velocity = edge.apparentVelocity.add(sprayVelocity);

    this.game!.addEntity(
      new SprayParticle(position, velocity, zVelocity, size),
    );
  }
}

class Edge {
  /** Start vertex in boat local space */
  v1: V2d;
  /** End vertex in boat local space */
  v2: V2d;
  /** Start vertex in world space */
  p1 = V();
  /** End vertex in world space */
  p2 = V();
  /** Edge displacement vector in world space */
  _displacement = V();
  /** Midpoint in world space */
  _midpoint = V();
  /** World normal vector */
  worldNormal = V();
  /** Apparent velocity (hull vs water) in world space */
  apparentVelocity = V();
  /** Normal component of apparent velocity */
  vDotN = 0;
  /** Multiplier for spawn rate, and particle velocity. Based on wave impact. Between 1 and 2. */
  waveBonus = 0;
  spawnRate = 0;
  boat: Boat;

  constructor(boat: Boat, i: number) {
    this.boat = boat;

    const vertices = boat.config.hull.vertices;
    this.v1 = vertices[i];
    this.v2 = vertices[(i + 1) % vertices.length];
  }

  update(water: WaterInfo) {
    const hullBody = this.boat.hull.body;

    // Transform edge endpoints to world frame
    this.p1.set(this.v1).itoGlobalFrame(hullBody.position, hullBody.angle);
    this.p2.set(this.v2).itoGlobalFrame(hullBody.position, hullBody.angle);

    // Edge displacement and length
    this._displacement.set(this.p2).isub(this.p1);

    // Hull velocity: average of velocities at endpoints
    this.apparentVelocity
      .set(hullBody.getVelocityAtWorldPoint(this.p1))
      .iadd(hullBody.getVelocityAtWorldPoint(this.p2))
      .imul(0.5);

    // Subtract water velocity (sample at midpoint)
    this._midpoint.set(this.p1).iadd(this.p2).imul(0.5);
    const waterState = water.getStateAtPoint(this._midpoint);
    this.apparentVelocity.isub(waterState.velocity);

    // Outward normal
    this.worldNormal.set(this._displacement).irotate90cw().inormalize();

    // Normal component of velocity
    this.vDotN = this.apparentVelocity.dot(this.worldNormal);

    if (this.vDotN < MIN_IMPACT_SPEED) {
      this.spawnRate = 0;
    } else {
      // Wave bonus and weight
      // TODO: This shouldn't be based on wave speed, but on the relative vertical speed based on the boat at this point and the water's speed
      this.waveBonus =
        1 + clamp(waterState.surfaceHeightRate * WAVE_BONUS_SCALE, 0, 1);
      this.spawnRate =
        this._displacement.magnitude * this.vDotN * this.waveBonus;
    }
  }

  randomPosOnEdge() {
    return lerpV2d(this.p1, this.p2, Math.random());
  }
}
