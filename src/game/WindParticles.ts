import BaseEntity from "../core/entity/BaseEntity";
import { on } from "../core/entity/handler";
import { Viewport } from "../core/graphics/Camera2d";
import { range } from "../core/util/FunctionalUtils";
import { invLerp, stepToward, sum } from "../core/util/MathUtil";
import { profile } from "../core/util/Profiler";
import { rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { WindInfo } from "./world-data/wind/WindInfo";

// Configuration (visual/screen-space, not world units)
const PARTICLE_COUNT = 0; // Target particles per sector
const SPAWN_RATE = 500; // particles per second (spawn and despawn)
const TARGET_ALPHA = 0.8; // Dimensionless opacity
const ALPHA_LERP_SPEED = 0.7; // 1/s - alpha transition speed
const PARTICLE_SIZE = 1.5; // pixels on screen, regardless of zoom
const COLOR = 0xffffff;
const PARTICLE_MOVE_SCALE = 0.5; // Dimensionless - fraction of wind speed

// Sector balancing
const SECTOR_GRID_SIZE = 6; // Grid divisions per axis
const REBALANCE_THRESHOLD = 1.5; // max allowed density ratio. Must be > 1.0

/**
 * Main entity that manages wind particles.
 */
export class WindParticles extends BaseEntity {
  layer = "windParticles" as const;

  private particles: WindParticle[] = [];
  private grid: ParticleGrid | null = null;
  targetParticleCount = PARTICLE_COUNT;

  constructor() {
    super();
  }

  @on("add")
  onAdd() {
    this.grid = new ParticleGrid(SECTOR_GRID_SIZE, SECTOR_GRID_SIZE);
  }

  @on("render")
  @profile
  onRender({
    dt,
    draw,
  }: {
    dt: number;
    draw: import("../core/graphics/Draw").Draw;
  }) {
    if (!this.game || !this.grid) {
      return;
    }
    const wind = WindInfo.fromGame(this.game);
    const viewport = this.game.camera.getWorldViewport();

    const zoom = this.game.camera.z;
    // Particle radius in world units that appears as PARTICLE_SIZE pixels on screen
    const radius = (PARTICLE_SIZE / zoom) * 1.01 ** zoom;

    this.grid.rebuildSectors(this.particles, viewport);

    // Spawn or despawn particles toward target count
    const diff = this.targetParticleCount - this.particles.length;
    const maxChange = Math.ceil(SPAWN_RATE * dt);
    const change = Math.min(Math.abs(diff), maxChange) * Math.sign(diff);

    if (change > 0) {
      // Spawn particles
      for (let i = 0; i < change; i++) {
        const pos = this.grid.getSpawnPosition(viewport);
        const particle = new WindParticle(pos);
        this.particles.push(particle);
      }
    } else if (change < 0) {
      // Despawn particles
      for (let i = 0; i < -change; i++) {
        const particle = this.grid.popFromDensest();
        if (!particle) break;
        const idx = this.particles.indexOf(particle);
        if (idx !== -1) this.particles.splice(idx, 1);
      }
    }

    this.grid.placeOutOfBoundsParticles(viewport);
    this.grid.rebalance(viewport);

    // Update and draw particles
    for (const p of this.particles) {
      p.update(dt, wind);
      draw.fillCircle(p.pos.x, p.pos.y, radius, {
        color: COLOR,
        alpha: p.alpha,
      });
    }
  }
}

/**
 * A single wind particle with position and alpha.
 */
class WindParticle {
  pos: V2d;
  alpha: number = 0;

  constructor(pos: V2d) {
    this.pos = pos;
  }

  /** Teleport to a new position, resetting alpha to fade in */
  teleport(newPos: V2d) {
    this.alpha = 0;
    this.pos.set(newPos);
  }

  /** Update particle state */
  update(dt: number, wind: WindInfo) {
    const velocity = wind.getVelocityAtPoint(this.pos);
    this.pos.iadd(velocity.imul(dt * PARTICLE_MOVE_SCALE));

    this.alpha = stepToward(this.alpha, TARGET_ALPHA, ALPHA_LERP_SPEED * dt);
  }
}

/**
 * Manages particles in a grid of sectors for efficient rebalancing.
 * Sectors are kept sorted by particle count (sparsest first).
 */
class ParticleGrid {
  private readonly sectors: WindParticle[][];
  private readonly sortedIndices: number[];
  private readonly outOfBounds: WindParticle[] = [];
  private readonly gridWidth: number;
  private readonly gridHeight: number;

  private get sparsestIndex(): number {
    return this.sortedIndices[0];
  }
  private get densestIndex(): number {
    return this.sortedIndices[this.sortedIndices.length - 1];
  }

  constructor(gridWidth: number, gridHeight: number) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;

    // Initialize empty sectors
    const numSectors = gridWidth * gridHeight;
    if (numSectors <= 1) {
      throw new Error(
        `Invalid sector grid size: ${numSectors} (${gridWidth}x${gridHeight})`,
      );
    }
    this.sectors = range(numSectors).map(() => []);
    this.sortedIndices = range(numSectors);
  }

  /** Get the sector index for a world position, or -1 if out of bounds */
  private getSectorIndex(pos: V2d, viewport: Viewport): number {
    const x = invLerp(viewport.left, viewport.right, pos.x) * this.gridWidth;
    const y = invLerp(viewport.top, viewport.bottom, pos.y) * this.gridHeight;
    const col = Math.floor(x);
    const row = Math.floor(y);

    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) {
      return -1;
    }
    return row * this.gridWidth + col;
  }

  private getSectorBounds(
    sectorIndex: number,
    viewport: Viewport,
  ): { left: number; right: number; top: number; bottom: number } {
    const col = sectorIndex % this.gridWidth;
    const row = Math.floor(sectorIndex / this.gridWidth);
    const sectorWidth = viewport.width / this.gridWidth;
    const sectorHeight = viewport.height / this.gridHeight;

    const left = viewport.left + col * sectorWidth;
    const right = left + sectorWidth;
    const top = viewport.top + row * sectorHeight;
    const bottom = top + sectorHeight;

    return { left, right, top, bottom };
  }

  /** Get a random position within a sector */
  private getRandomPosInSector(sectorIndex: number, viewport: Viewport): V2d {
    const { left, right, top, bottom } = this.getSectorBounds(
      sectorIndex,
      viewport,
    );
    return V(rUniform(left, right), rUniform(top, bottom));
  }

  /** Rebuild sector assignments from particle positions */
  rebuildSectors(particles: WindParticle[], viewport: Viewport) {
    // Clear all sectors
    for (const sector of this.sectors) {
      sector.length = 0;
    }
    this.outOfBounds.length = 0;

    // Assign particles to sectors
    for (const p of particles) {
      const idx = this.getSectorIndex(p.pos, viewport);
      if (idx === -1) {
        this.outOfBounds.push(p);
      } else {
        this.sectors[idx].push(p);
      }
    }

    // Sort indices by sector count (sparsest first)
    this.sortedIndices.sort(
      (a, b) => this.sectors[a].length - this.sectors[b].length,
    );
  }

  /** Teleport out-of-bounds particles to sparse sectors */
  placeOutOfBoundsParticles(viewport: Viewport) {
    while (this.outOfBounds.length > 0) {
      const p = this.outOfBounds.pop()!;
      const sectorIndex = this.sparsestIndex;
      p.teleport(this.getRandomPosInSector(sectorIndex, viewport));
      this.sectors[sectorIndex].push(p);
      this.bubbleUp();
    }
  }

  /** Rebalance sectors until the ratio is acceptable */
  rebalance(viewport: Viewport) {
    const numSectors = this.sectors.length;
    const totalParticles = sum(...this.sectors.map((s) => s.length));
    const perSector = totalParticles / numSectors;
    const maxAllowed = Math.max(Math.ceil(perSector * REBALANCE_THRESHOLD), 1); // never allow 0

    while (this.sectors[this.densestIndex].length > maxAllowed) {
      const p = this.sectors[this.densestIndex].pop()!;
      const sectorIndex = this.sparsestIndex;
      p.teleport(this.getRandomPosInSector(sectorIndex, viewport));
      this.sectors[sectorIndex].push(p);
      this.bubbleUp();
      this.bubbleDown();
    }
  }

  /** Get a position in the sparsest sector for spawning new particles */
  getSpawnPosition(viewport: Viewport): V2d {
    return this.getRandomPosInSector(this.sparsestIndex, viewport);
  }

  /** Remove and return a particle from the densest sector */
  popFromDensest(): WindParticle | undefined {
    const sector = this.sectors[this.densestIndex];
    if (sector.length === 0) return undefined;
    const p = sector.pop()!;
    this.bubbleDown();
    return p;
  }

  /** Bubble a sector up in sortedIndices if it became larger than its neighbors */
  private bubbleUp() {
    for (
      let i = 0;
      i < this.sortedIndices.length - 1 &&
      this.sectors[this.sortedIndices[i]].length >
        this.sectors[this.sortedIndices[i + 1]].length;
      i++
    ) {
      const temp = this.sortedIndices[i];
      this.sortedIndices[i] = this.sortedIndices[i + 1];
      this.sortedIndices[i + 1] = temp;
    }
  }

  /** Bubble a sector down in sortedIndices if it became smaller than its neighbors */
  private bubbleDown() {
    for (
      let i = this.sortedIndices.length - 1;
      i > 0 &&
      this.sectors[this.sortedIndices[i]].length <
        this.sectors[this.sortedIndices[i - 1]].length;
      i--
    ) {
      const temp = this.sortedIndices[i];
      this.sortedIndices[i] = this.sortedIndices[i - 1];
      this.sortedIndices[i - 1] = temp;
    }
  }
}
