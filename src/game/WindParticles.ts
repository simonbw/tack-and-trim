import { Graphics, Sprite, Texture } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { createEmptySprite } from "../core/entity/GameSprite";
import Game from "../core/Game";
import { Viewport } from "../core/graphics/Camera2d";
import { range } from "../core/util/FunctionalUtils";
import { invLerp, stepToward, sum } from "../core/util/MathUtil";
import { rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Wind } from "./Wind";

// Configuration
const PARTICLE_COUNT = 2000;
const TARGET_ALPHA = 0.8;
const ALPHA_LERP_SPEED = 0.7; // per second
const PARTICLE_SIZE = 2.5; // pixels on screen, regardless of zoom
const TEXTURE_SIZE = 8; // texture resolution
const COLOR = 0xffffff;
const PARTICLE_MOVE_SCALE = 0.5; // Percent of wind speed

// Sector balancing
const SECTOR_GRID_SIZE = 6; // width and height
const REBALANCE_THRESHOLD = 1.5; // max allowed ratio of densest to sparsest. Must be greater that 1.0

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
  private readonly sectors: WindParticle[][];
  private readonly outOfBounds: WindParticle[] = [];
  private readonly gridWidth: number;
  private readonly gridHeight: number;

  private readonly sparsestIndex = 0;
  private get densestIndex(): number {
    return this.sectors.length - 1;
  }

  constructor(gridWidth: number, gridHeight: number) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;

    // Initialize empty sectors
    const numSectors = gridWidth * gridHeight;
    if (numSectors <= 1) {
      throw new Error(
        `Invalid sector grid size: ${numSectors} (${gridWidth}x${gridHeight})`
      );
    }
    this.sectors = range(numSectors).map(() => []);
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
    viewport: Viewport
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
      viewport
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

    // Sort sectors by count (sparsest first)
    this.sectors.sort((a, b) => a.length - b.length);
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

  /** Bubble a sector up if it became larger than its neighbors */
  private bubbleUp() {
    for (
      let i = 0;
      i < this.sectors.length - 1 &&
      this.sectors[i].length > this.sectors[i + 1].length;
      i++
    ) {
      const temp = this.sectors[i];
      this.sectors[i] = this.sectors[i + 1];
      this.sectors[i + 1] = temp;
    }
  }

  /** Bubble a sector down if it became smaller than its neighbors */
  private bubbleDown() {
    for (
      let i = this.sectors.length - 1;
      i > 0 && this.sectors[i].length < this.sectors[i - 1].length;
      i--
    ) {
      const temp = this.sectors[i];
      this.sectors[i] = this.sectors[i - 1];
      this.sectors[i - 1] = temp;
    }
  }
}
