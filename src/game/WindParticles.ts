import { Graphics, Sprite, Texture } from "pixi.js";
import BaseEntity from "../core/entity/BaseEntity";
import { GameEventMap } from "../core/entity/Entity";
import { createEmptySprite } from "../core/entity/GameSprite";
import { Camera2d, Viewport } from "../core/graphics/Camera2d";
import { range } from "../core/util/FunctionalUtils";
import { rUniform } from "../core/util/Random";
import { V, V2d } from "../core/Vector";
import { Wind } from "./Wind";

interface WindParticle {
  pos: V2d;
  alpha: number;
  sprite: Sprite;
}

// Configuration
const PARTICLE_COUNT = 1000;
const TARGET_ALPHA = 0.8;
const ALPHA_LERP_SPEED = 3; // per second
const SCREEN_SIZE = 2; // pixels on screen, regardless of zoom
const TEXTURE_SIZE = 8; // texture resolution
const VIEWPORT_MARGIN = 20;
const COLOR = 0xffffff;

// Sector balancing
const SECTOR_GRID_SIZE = 5; // 4x4 grid
const REBALANCE_THRESHOLD = 2.5; // rebalance when max/min ratio exceeds this

export class WindParticles extends BaseEntity {
  private particles: WindParticle[] = [];
  private particleTexture: Texture | null = null;
  sprite: NonNullable<BaseEntity["sprite"]>;

  constructor() {
    super();
    this.sprite = createEmptySprite("windParticles");
  }

  onAdd({ game }: GameEventMap["add"]) {
    const g = new Graphics();
    g.circle(TEXTURE_SIZE / 2, TEXTURE_SIZE / 2, TEXTURE_SIZE / 2);
    g.fill({ color: 0xffffff });
    this.particleTexture = game.renderer.app.renderer.generateTexture(g);

    this.initializeParticles(game.camera.getWorldViewport());
  }

  private initializeParticles(viewport: Viewport) {
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const sprite = new Sprite(this.particleTexture!);
      sprite.anchor.set(0.5, 0.5);
      this.sprite.addChild(sprite);

      const particle: WindParticle = {
        pos: V(
          rUniform(viewport.left, viewport.right),
          rUniform(viewport.top, viewport.bottom)
        ),
        alpha: TARGET_ALPHA, // Start fully visible
        sprite,
      };
      this.particles.push(particle);
    }
  }

  private getSectorIndex(
    pos: V2d,
    viewport: Viewport
  ): { row: number; col: number } {
    const col = Math.floor(
      ((pos.x - viewport.left) / viewport.width) * SECTOR_GRID_SIZE
    );
    const row = Math.floor(
      ((pos.y - viewport.top) / viewport.height) * SECTOR_GRID_SIZE
    );
    return {
      row: Math.max(0, Math.min(SECTOR_GRID_SIZE - 1, row)),
      col: Math.max(0, Math.min(SECTOR_GRID_SIZE - 1, col)),
    };
  }

  private getRandomPositionInSector(
    row: number,
    col: number,
    viewport: Viewport
  ): V2d {
    const sectorWidth = viewport.width / SECTOR_GRID_SIZE;
    const sectorHeight = viewport.height / SECTOR_GRID_SIZE;

    const x = viewport.left + col * sectorWidth + Math.random() * sectorWidth;
    const y = viewport.top + row * sectorHeight + Math.random() * sectorHeight;

    return V(x, y);
  }

  private teleportParticle(
    p: WindParticle,
    row: number,
    col: number,
    viewport: Viewport
  ) {
    p.pos = this.getRandomPositionInSector(row, col, viewport);
    p.alpha = 0; // Start invisible, will fade in
  }

  onRender(dt: number) {
    const wind = this.game?.entities.getById("wind") as Wind | undefined;
    const viewport = this.game?.camera.getWorldViewport();

    if (!this.game || !wind || !viewport) return;

    const zoom = this.game.camera.z;
    // Scale proportional to zoom - bigger when zoomed in, smaller when zoomed out
    const scale = (SCREEN_SIZE * zoom) / TEXTURE_SIZE;
    const margin = VIEWPORT_MARGIN;

    // Step 1: Group particles by sector and find out-of-bounds ones
    const sectorParticles: WindParticle[][][] = Array.from(
      { length: SECTOR_GRID_SIZE },
      () => Array.from({ length: SECTOR_GRID_SIZE }, () => [])
    );
    const outOfBounds: WindParticle[] = [];

    for (const p of this.particles) {
      const outsideViewport =
        p.pos.x < viewport.left - margin ||
        p.pos.x > viewport.right + margin ||
        p.pos.y < viewport.top - margin ||
        p.pos.y > viewport.bottom + margin;

      if (outsideViewport) {
        outOfBounds.push(p);
      } else {
        const { row, col } = this.getSectorIndex(p.pos, viewport);
        sectorParticles[row][col].push(p);
      }
    }

    // Step 2: Rebalance sectors aggressively
    const targetPerSector = Math.floor(
      this.particles.length / (SECTOR_GRID_SIZE * SECTOR_GRID_SIZE)
    );
    const maxAllowed = Math.floor(targetPerSector * REBALANCE_THRESHOLD);

    // First, teleport all out-of-bounds particles to sparse sectors
    for (const p of outOfBounds) {
      const { row, col } = this.findSparsestSectorFromGrid(sectorParticles);
      this.teleportParticle(p, row, col, viewport);
      sectorParticles[row][col].push(p);
    }

    // Then, rebalance until no sector exceeds the limit
    let iterations = 0;
    const maxIterations = 100; // Safety limit
    while (iterations < maxIterations) {
      const {
        row: denseRow,
        col: denseCol,
        count: maxCount,
      } = this.findDensestSectorFromGrid(sectorParticles);
      const {
        row: sparseRow,
        col: sparseCol,
        count: minCount,
      } = this.findSparsestSectorFromGrid(sectorParticles);

      // Stop if balanced enough
      if (
        maxCount <= maxAllowed ||
        minCount === 0 ||
        maxCount <= minCount + 1
      ) {
        break;
      }

      // Move one particle from dense to sparse
      const p = sectorParticles[denseRow][denseCol].pop();
      if (p) {
        this.teleportParticle(p, sparseRow, sparseCol, viewport);
        sectorParticles[sparseRow][sparseCol].push(p);
      }
      iterations++;
    }

    // Step 3: Apply wind movement and update sprites
    for (const p of this.particles) {
      // Move with wind
      const velocity = wind.getVelocityAtPoint(p.pos);
      p.pos.iadd(velocity.imul(dt));

      // Lerp alpha toward target
      p.alpha += (TARGET_ALPHA - p.alpha) * ALPHA_LERP_SPEED * dt;

      // Update sprite
      p.sprite.position.set(p.pos.x, p.pos.y);
      p.sprite.scale.set(scale);
      p.sprite.alpha = p.alpha;
      p.sprite.tint = COLOR;
    }
  }

  private findSparsestSectorFromGrid(grid: WindParticle[][][]): {
    row: number;
    col: number;
    count: number;
  } {
    let minCount = Infinity;
    let minRow = 0;
    let minCol = 0;

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        if (grid[row][col].length < minCount) {
          minCount = grid[row][col].length;
          minRow = row;
          minCol = col;
        }
      }
    }

    return { row: minRow, col: minCol, count: minCount };
  }

  private findDensestSectorFromGrid(grid: WindParticle[][][]): {
    row: number;
    col: number;
    count: number;
  } {
    let maxCount = -Infinity;
    let maxRow = 0;
    let maxCol = 0;

    for (let row = 0; row < SECTOR_GRID_SIZE; row++) {
      for (let col = 0; col < SECTOR_GRID_SIZE; col++) {
        if (grid[row][col].length > maxCount) {
          maxCount = grid[row][col].length;
          maxRow = row;
          maxCol = col;
        }
      }
    }

    return { row: maxRow, col: maxCol, count: maxCount };
  }
}

class WindParticle extends BaseEntity {
  position: V2d;
  wind: Wind;
  particleSprite: Sprite;

  constructor(position: V2d, wind: Wind) {
    super();
    this.position = position;
    this.wind = wind;
    this.particleSprite = new Sprite();
    this.particleSprite.position.set(position.x, position.y);
  }

  onAdd({ game, parent }: GameEventMap["add"]) {}

  onRender(dt: GameEventMap["render"]) {
    const velocity = this.wind.getVelocityAtPoint(this.position);
    const movement = velocity.imul(dt);
    this.position.iadd(movement);
  }

  teleport(newPosition: V2d) {
    this.position.set(newPosition);
    this.particleSprite.position.set(newPosition.x, newPosition.y);
    // TODO: update other sprite properties
  }
}

/**
 * Keeps particles in a grid of sectors.
 * Has methods for rebalancing the particles across sectors so that no sector
 * has too many or too few particles.
 */
class ParticleGrid {
  readonly allParticles = new Set<WindParticle>();
  readonly sectors: WindParticle[][] = [];
  readonly outOfBounds: WindParticle[] = [];
  camera: Camera2d;

  constructor(
    readonly gridWidth: number,
    readonly gridHeight: number,
    camera: Camera2d
  ) {
    this.gridWidth = gridWidth;
    this.gridHeight = gridHeight;
    this.camera = camera;
    const nCells = gridWidth * gridHeight + 1;
    this.sectors = range(nCells).map(() => []);
  }

  sectorIndexFromWorldPos(pos: V2d): number {
    const viewport = this.camera.getWorldViewport();
    const col = Math.floor(
      ((pos.x - viewport.left) / viewport.width) * this.gridWidth
    );
    const row = Math.floor(
      ((pos.y - viewport.top) / viewport.height) * this.gridHeight
    );
    if (col < 0 || col >= this.gridWidth || row < 0 || row >= this.gridHeight) {
      return -1; // Out of bounds
    }
    return this.sectorIndexFromRowCol(row, col);
  }

  sectorIndexFromRowCol(row: number, col: number): number {
    return row * this.gridWidth + col;
  }

  addParticle(particle: WindParticle) {
    this.allParticles.add(particle);
  }

  removeParticle(particle: WindParticle) {
    this.allParticles.delete(particle);
  }

  /** Rebuild the sectors based on current particle locations and current viewport */
  updateSectors() {
    for (const sector of this.sectors) {
      sector.length = 0;
    }
    this.outOfBounds.length = 0;
    for (const p of this.allParticles) {
      const sectorIdx = this.sectorIndexFromWorldPos(p.pos);
      if (sectorIdx === -1) {
        this.outOfBounds.push(p);
      } else {
        this.sectors[sectorIdx].push(p);
      }
    }
    this.sectors.sort((a, b) => a.length - b.length);
  }

  getSectorBounds(sectorIndex: number): {
    top: number;
    bottom: number;
    left: number;
    right: number;
  } {
    const col = sectorIndex % this.gridWidth;
    const row = Math.floor(sectorIndex / this.gridWidth);
    const sectorWidth = this.camera.getWorldViewport().width / this.gridWidth;
    const sectorHeight =
      this.camera.getWorldViewport().height / this.gridHeight;
    return {
      top: row * sectorHeight,
      bottom: (row + 1) * sectorHeight,
      left: col * sectorWidth,
      right: (col + 1) * sectorWidth,
    };
  }

  placeOutOfBoundsParticles() {
    while (this.outOfBounds.length > 0) {
      const particle = this.outOfBounds.pop()!;
      const sectorIdx = this.sectors.length - 1;
      const bounds = this.getSectorBounds(sectorIdx);
      const x = rUniform(bounds.left, bounds.right);
      const y = rUniform(bounds.top, bounds.bottom);
      particle.teleport(V(x, y));

      // Keep our sectors up to date
      this.sectors[sectorIdx].push(particle);
      // And sorted
      this.bubbleUp();
    }
    this.outOfBounds.length = 0;
  }

  bubbleUp() {
    for (
      let i = this.sectors.length - 1;
      i > 0 && this.sectors[i].length > this.sectors[i - 1].length;
      i--
    ) {
      const temp = this.sectors[i - 1];
      this.sectors[i - 1] = this.sectors[i];
      this.sectors[i] = temp;
    }
  }

  bubbleDown() {
    for (
      let i = 0;
      i < this.sectors.length - 1 &&
      this.sectors[i].length < this.sectors[i + 1].length;
      i++
    ) {
      const temp = this.sectors[i + 1];
      this.sectors[i + 1] = this.sectors[i];
      this.sectors[i] = temp;
    }
  }

  rebalanceSectors() {}
}
