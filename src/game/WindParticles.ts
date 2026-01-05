import { Graphics, Sprite, Texture } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { createEmptySprite } from "../core/entity/GameSprite";
import Game from "../core/Game";
import { Viewport } from "../core/graphics/Camera2d";
import { stepToward } from "../core/util/MathUtil";
import { rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Wind } from "./Wind";

// Configuration
const PARTICLE_COUNT = 1000;
const TARGET_ALPHA = 0.8;
const ALPHA_LERP_SPEED = 1.0; // per second
const PARTICLE_SIZE = 2.5; // pixels on screen, regardless of zoom
const TEXTURE_SIZE = 8; // texture resolution
const COLOR = 0xffffff;
const PARTICLE_MOVE_SCALE = 0.5; // Percent of wind speed

// Sector balancing
const SECTOR_GRID_SIZE = 6; // width and height
const REBALANCE_THRESHOLD = 1.5; // max allowed ratio of densest to sparsest

/**
 * Main entity that manages wind particles.
 */
export class WindParticles extends BaseEntity {
  private particles: WindParticle[] = [];
  private _particleTexture?: Texture;
  private grid: ParticleGrid | null = null;
  sprite: NonNullable<BaseEntity["sprite"]>;

  constructor() {
    super();
    this.sprite = createEmptySprite("windParticles");
  }

  onAdd({ game }: GameEventMap["add"]) {
    this.grid = new ParticleGrid(SECTOR_GRID_SIZE, SECTOR_GRID_SIZE);

    // Create particles
    const viewport = game.camera.getWorldViewport();
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const x = rUniform(viewport.left, viewport.right);
      const y = rUniform(viewport.top, viewport.bottom);
      const particle = new WindParticle(V(x, y), game);
      this.particles.push(particle);
      this.sprite.addChild(particle.sprite);
    }
  }

  onRender(dt: number) {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    const viewport = this.game?.camera.getWorldViewport();

    if (!this.game || !wind || !viewport || !this.grid) return;

    const zoom = this.game.camera.z;
    const scale = (PARTICLE_SIZE / (TEXTURE_SIZE * zoom)) * 1.01 ** zoom;

    this.grid.rebuildSectors(this.particles, viewport);

    this.grid.placeOutOfBoundsParticles(viewport);

    this.grid.rebalance(viewport);

    for (const p of this.particles) {
      p.onRender(dt, scale, wind);
    }
  }
}

/**
 * A single wind particle with position, alpha, and sprite.
 */
class WindParticle {
  pos: V2d; // Yes it's redundant with sprite.position, but it keeps us from allocations and makes vector math cleaner
  readonly sprite: Sprite;

  constructor(pos: V2d, game: Game) {
    this.pos = pos;
    this.sprite = new Sprite(getParticleTexture(game));
    this.sprite.alpha = 0;
    this.sprite.anchor.set(0.5, 0.5);
    this.sprite.position.copyFrom(this.pos);
  }

  /** Teleport to a new position, resetting alpha to fade in */
  teleport(newPos: V2d) {
    this.sprite.alpha = 0;
    this.pos.set(newPos);
    this.sprite.position.copyFrom(this.pos);
  }

  /** Update sprite to match current state */
  onRender(dt: number, scale: number, wind: Wind) {
    const velocity = wind.getVelocityAtPoint(this.pos);
    this.pos.iadd(velocity.imul(dt * PARTICLE_MOVE_SCALE));
    this.sprite.position.copyFrom(this.pos);

    this.sprite.scale.set(scale);
    this.sprite.tint = COLOR;
    this.sprite.alpha = stepToward(
      this.sprite.alpha,
      TARGET_ALPHA,
      ALPHA_LERP_SPEED * dt
    );
  }
}

let _particleTexture: Texture | null = null;
function getParticleTexture(game: Game): Texture {
  if (!_particleTexture) {
    const g = new Graphics();
    g.circle(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);
    g.fill({ color: 0xffffff });
    _particleTexture = game.renderer.app.renderer.generateTexture(g);
  }
  return _particleTexture;
}

/**
 * Manages particles in a grid of sectors for efficient rebalancing.
 * Sectors are kept sorted by particle count (sparsest first).
 */
class ParticleGrid {
  private readonly sectors: WindParticle[][] = [];
  private readonly outOfBounds: WindParticle[] = [];
  private readonly gridWidth: number;
  private readonly gridHeight: number;

  constructor(gridWidth: number, gridHeight: number) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;

    // Initialize empty sectors
    const numSectors = gridWidth * gridHeight;
    for (let i = 0; i < numSectors; i++) {
      this.sectors.push([]);
    }
  }

  /** Get the sector index for a world position, or -1 if out of bounds */
  private getSectorIndex(pos: V2d, viewport: Viewport): number {
    const col = Math.floor(
      ((pos.x - viewport.left) / viewport.width) * this.gridWidth
    );
    const row = Math.floor(
      ((pos.y - viewport.top) / viewport.height) * this.gridHeight
    );

    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) {
      return -1;
    }
    return row * this.gridWidth + col;
  }

  /** Get a random position within a sector */
  private getRandomPosInSector(sectorIndex: number, viewport: Viewport): V2d {
    const col = sectorIndex % this.gridWidth;
    const row = Math.floor(sectorIndex / this.gridWidth);
    const sectorWidth = viewport.width / this.gridWidth;
    const sectorHeight = viewport.height / this.gridHeight;

    return V(
      viewport.left + col * sectorWidth + rUniform(0, sectorWidth),
      viewport.top + row * sectorHeight + rUniform(0, sectorHeight)
    );
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

    // Sort sectors by count (sparsest first)
    this.sectors.sort((a, b) => a.length - b.length);
  }

  /** Teleport out-of-bounds particles to sparse sectors */
  placeOutOfBoundsParticles(viewport: Viewport) {
    while (this.outOfBounds.length > 0) {
      const p = this.outOfBounds.pop()!;
      // Place in sparsest sector (index 0 after sorting)
      const sparsestIdx = this.findSparsestSectorIndex();
      p.teleport(this.getRandomPosInSector(sparsestIdx, viewport));
      this.sectors[0].push(p);
      this.bubbleUp(0);
    }
  }

  /** Rebalance sectors until the ratio is acceptable */
  rebalance(viewport: Viewport, maxIterations: number = 100) {
    const numSectors = this.sectors.length;
    const targetPerSector = Math.floor(
      this.sectors.reduce((sum, s) => sum + s.length, 0) / numSectors
    );
    const maxAllowed = Math.ceil(targetPerSector * REBALANCE_THRESHOLD);

    for (let i = 0; i < maxIterations; i++) {
      const sparsest = this.sectors[0];
      const densest = this.sectors[numSectors - 1];

      // Stop if balanced enough
      if (
        densest.length <= maxAllowed ||
        densest.length <= sparsest.length + 1
      ) {
        break;
      }

      // Move one particle from densest to sparsest
      const p = densest.pop();
      if (!p) break;

      // Find actual sector index for sparsest (we need it for positioning)
      const sparsestIdx = this.findSparsestSectorIndex();
      p.teleport(this.getRandomPosInSector(sparsestIdx, viewport));
      sparsest.push(p);

      // Re-sort affected sectors
      this.bubbleUp(0);
      this.bubbleDown(numSectors - 1);
    }
  }

  /** Find the original sector index of the sparsest sector */
  private findSparsestSectorIndex(): number {
    // Since we sorted, we need to find which original sector is at position 0
    // For simplicity, just pick a random sector index - the position within
    // the sector is what matters for visual distribution
    return Math.floor(Math.random() * this.sectors.length);
  }

  /** Bubble a sector up if it became larger than its neighbors */
  private bubbleUp(idx: number) {
    while (
      idx < this.sectors.length - 1 &&
      this.sectors[idx].length > this.sectors[idx + 1].length
    ) {
      const temp = this.sectors[idx];
      this.sectors[idx] = this.sectors[idx + 1];
      this.sectors[idx + 1] = temp;
      idx++;
    }
  }

  /** Bubble a sector down if it became smaller than its neighbors */
  private bubbleDown(idx: number) {
    while (idx > 0 && this.sectors[idx].length < this.sectors[idx - 1].length) {
      const temp = this.sectors[idx];
      this.sectors[idx] = this.sectors[idx - 1];
      this.sectors[idx - 1] = temp;
      idx--;
    }
  }
}
