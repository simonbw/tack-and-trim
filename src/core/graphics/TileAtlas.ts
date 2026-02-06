/**
 * Tile Atlas - GPU texture atlas for storing cached tiles.
 *
 * Manages a large GPU texture divided into fixed-size slots.
 * Tiles can be rendered to individual slots and sampled from the atlas.
 */

import { getWebGPU } from "./webgpu/WebGPUDevice";

/**
 * Configuration for the tile atlas.
 */
export interface TileAtlasConfig {
  /** Size of each tile in pixels */
  tileSize: number;
  /** Number of tiles in X direction */
  tilesX: number;
  /** Number of tiles in Y direction */
  tilesY: number;
  /** Texture format */
  format: GPUTextureFormat;
  /** Debug label */
  label?: string;
}

/**
 * UV coordinates for a tile slot in the atlas.
 */
export interface TileUV {
  /** U coordinate of tile's top-left corner (0-1) */
  u: number;
  /** V coordinate of tile's top-left corner (0-1) */
  v: number;
  /** Size of tile in UV space (0-1) */
  size: number;
}

/**
 * GPU texture atlas for cached tiles.
 *
 * The atlas is a single large texture divided into a grid of tile slots.
 * Each slot can hold one rendered tile.
 */
export class TileAtlas {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly tilesX: number;
  readonly tilesY: number;
  readonly maxTiles: number;

  constructor(config: TileAtlasConfig) {
    const device = getWebGPU().device;

    this.tileSize = config.tileSize;
    this.tilesX = config.tilesX;
    this.tilesY = config.tilesY;
    this.maxTiles = config.tilesX * config.tilesY;

    this.width = config.tileSize * config.tilesX;
    this.height = config.tileSize * config.tilesY;

    // Create the atlas texture
    // Needs STORAGE_BINDING for compute shader output
    // Needs TEXTURE_BINDING for sampling in fragment shader
    this.texture = device.createTexture({
      size: { width: this.width, height: this.height },
      format: config.format,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST,
      label: config.label ?? "TileAtlas",
    });

    this.view = this.texture.createView();
  }

  /**
   * Get the pixel coordinates of a tile slot.
   */
  getSlotPixelCoords(slot: number): { x: number; y: number } {
    const tileX = slot % this.tilesX;
    const tileY = Math.floor(slot / this.tilesX);
    return {
      x: tileX * this.tileSize,
      y: tileY * this.tileSize,
    };
  }

  /**
   * Get UV coordinates for a tile slot.
   */
  getSlotUV(slot: number): TileUV {
    const tileX = slot % this.tilesX;
    const tileY = Math.floor(slot / this.tilesX);
    return {
      u: tileX / this.tilesX,
      v: tileY / this.tilesY,
      size: 1.0 / this.tilesX, // Assumes square UV mapping
    };
  }

  /**
   * Get atlas dimensions for shader uniforms.
   */
  getAtlasInfo(): {
    atlasWidth: number;
    atlasHeight: number;
    tileSize: number;
    tilesX: number;
    tilesY: number;
  } {
    return {
      atlasWidth: this.width,
      atlasHeight: this.height,
      tileSize: this.tileSize,
      tilesX: this.tilesX,
      tilesY: this.tilesY,
    };
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.texture.destroy();
  }
}

/**
 * Calculate optimal atlas dimensions for a given tile count.
 *
 * @param tileCount - Number of tiles to fit
 * @param tileSize - Size of each tile in pixels
 * @returns Configuration for the atlas
 */
export function calculateAtlasDimensions(
  tileCount: number,
  _tileSize?: number,
): { tilesX: number; tilesY: number } {
  // Try to make it roughly square
  const tilesPerSide = Math.ceil(Math.sqrt(tileCount));

  // Calculate rows needed
  const tilesX = tilesPerSide;
  const tilesY = Math.ceil(tileCount / tilesX);

  return { tilesX, tilesY };
}
