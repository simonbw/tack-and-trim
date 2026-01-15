import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { clamp, invLerp, lerp } from "../../core/util/MathUtil";
import { V, V2d } from "../../core/Vector";
import { Boat } from "../boat/Boat";
import { WakeParticle, WakeSide } from "./WakeParticle";

// Units: feet (ft), ft/s, seconds
const CONFIG = {
  MAX_AGE: 3.0, // seconds
  SPAWN_DISTANCE: 1.3, // Spawn particles every N ft of distance traveled
  MIN_SPAWN_INTERVAL: 0.15, // seconds - max ~6.7 spawns/sec at high speed
  MIN_SPEED: 3, // ft/s (~2 kts) - wake starts forming
  MAX_SPEED: 12, // ft/s (~7 kts) - hull speed limit
  REAR_OFFSET: -6, // ft behind hull center
  INITIAL_SPREAD: 2, // ft initial lateral spread
  SPREAD_RATE: 5, // ft/s lateral spreading rate
  COLOR: 0xffffff,
  MIN_ALPHA: 0.2,
  MAX_ALPHA: 0.7,
  MIN_LINE_WIDTH: 1, // pixels
  MAX_LINE_WIDTH: 3, // pixels
  // Wake particle lifespan range for natural variation
  MIN_PARTICLE_LIFESPAN: 2.0, // seconds
  MAX_PARTICLE_LIFESPAN: 5.0, // seconds
};

export class Wake extends BaseEntity {
  layer = "wake" as const;
  tickLayer = "effects" as const;

  private lastSpawnPos: V2d | null = null;
  private lastSpawnTime: number = 0;

  // Track the most recently spawned particle on each side (head of chain)
  // New particles link to these, forming a chain from newest to oldest
  private leftChainHead: WakeParticle | null = null;
  private rightChainHead: WakeParticle | null = null;

  boat: Boat;
  leftSpawnLocal: V2d;
  rightSpawnLocal: V2d;

  constructor(boat: Boat, leftSpawnLocal: V2d, rightSpawnLocal: V2d) {
    super();
    this.boat = boat;
    this.leftSpawnLocal = leftSpawnLocal;
    this.rightSpawnLocal = rightSpawnLocal;
  }

  @on("tick")
  onTick(_dt: number) {
    const velocity = this.boat.getVelocity();
    const speed = velocity.magnitude;

    if (speed < CONFIG.MIN_SPEED) return;

    const boatPos = this.boat.getPosition();
    const now = this.game?.elapsedUnpausedTime ?? 0;

    // Check distance traveled since last spawn
    if (this.lastSpawnPos) {
      const distSq = this.lastSpawnPos.squaredDistanceTo(boatPos);
      if (distSq < CONFIG.SPAWN_DISTANCE * CONFIG.SPAWN_DISTANCE) return;
    }

    // Also check time since last spawn to limit rate at high speeds
    if (now - this.lastSpawnTime < CONFIG.MIN_SPAWN_INTERVAL) return;

    // Clone position since getPosition() returns a reference to the physics body's position
    this.lastSpawnPos = boatPos.clone();
    this.lastSpawnTime = now;

    const speedFactor = clamp(
      invLerp(CONFIG.MIN_SPEED, CONFIG.MAX_SPEED, speed),
    );

    const body = this.boat.hull.body;
    const wakeSpeed = speed * 0.3; // Wake moves slower than boat

    // Spawn left and right wake particles and link them into chains
    this.spawnAndLinkParticle("left", body, wakeSpeed, speedFactor);
    this.spawnAndLinkParticle("right", body, wakeSpeed, speedFactor);
  }

  private spawnAndLinkParticle(
    side: WakeSide,
    body: { toWorldFrame: (v: V2d) => V2d; angle: number },
    wakeSpeed: number,
    speedFactor: number,
  ) {
    const sideSign = side === "left" ? 1 : -1;

    const pos = body.toWorldFrame(
      side === "left" ? this.leftSpawnLocal : this.rightSpawnLocal,
    );
    const vel = V(0, wakeSpeed * sideSign).irotate(body.angle);
    const lifespan = lerp(
      CONFIG.MIN_PARTICLE_LIFESPAN,
      CONFIG.MAX_PARTICLE_LIFESPAN,
      Math.random(),
    );

    const particle = new WakeParticle(pos, vel, side, speedFactor, lifespan);

    // Link to previous head of chain
    const prevHead = side === "left" ? this.leftChainHead : this.rightChainHead;

    if (prevHead && !prevHead.isDestroyed) {
      // New particle's next points to the previous head (older particle)
      particle.next = prevHead;
      // Previous head's prev points back to new particle
      prevHead.prev = particle;
    }

    // Update chain head reference
    if (side === "left") {
      this.leftChainHead = particle;
    } else {
      this.rightChainHead = particle;
    }

    this.game?.addEntity(particle);
  }
}
