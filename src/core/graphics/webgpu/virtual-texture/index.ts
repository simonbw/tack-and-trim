/**
 * Virtual texture system for GPU-accelerated tile streaming.
 *
 * Provides tile-based caching with LOD support for efficiently streaming
 * large texture data to the GPU. Can be used for terrain, procedural textures,
 * or any large texture data that doesn't fit in VRAM.
 */
export { TileCache, type CachedTile } from "./TileCache";
export { TileCompute } from "./TileCompute";
export { VirtualTexture, type VirtualTextureConfig } from "./VirtualTexture";
