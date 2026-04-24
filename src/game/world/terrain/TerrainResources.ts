/**
 * Terrain GPU resource manager.
 *
 * Owns and manages GPU buffers for terrain contour data.
 * Provides read-only access to buffers for query shaders and render pipelines.
 * Also stores the terrain definition and tracks version changes.
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { GameEventMap } from "../../../core/entity/Entity";
import { on } from "../../../core/entity/handler";

import {
  type TerrainContour,
  type TerrainDefinition,
  buildTerrainGPUData,
  buildTerrainGPUDataFromPrecomputed,
  FLOATS_PER_CONTOUR,
  normalizeTerrainWinding,
} from "./LandMass";
/** Header size for packed terrain buffer: 6 u32 offsets (vertices, contours, children, containmentGrid, idwGridData, lookupGrid) */
const PACKED_TERRAIN_HEADER_SIZE = 6;

/**
 * Pack terrain data into a single Uint32Array for GPU upload.
 * Pure function — no GPU device needed.
 */
export function packTerrainBuffer(gpuData: {
  vertexData: Float32Array;
  contourData: ArrayBuffer;
  childrenData: Uint32Array;
  containmentGridData: Uint32Array;
  idwGridData: Uint32Array;
  lookupGridData: Uint32Array;
  contourCount: number;
}): Uint32Array {
  const {
    vertexData,
    contourData,
    childrenData,
    containmentGridData,
    idwGridData,
    lookupGridData,
    contourCount,
  } = gpuData;

  // Compute section offsets from actual data sizes (tightly packed)
  const verticesOffset = PACKED_TERRAIN_HEADER_SIZE;
  const vertexCount = vertexData.length; // number of f32s (2 per vertex)
  const contoursOffset = verticesOffset + vertexCount;
  const contourFloatCount = contourCount * FLOATS_PER_CONTOUR;
  const childrenOffset = contoursOffset + contourFloatCount;
  const containmentGridOffset = childrenOffset + childrenData.length;
  const idwGridDataOffset = containmentGridOffset + containmentGridData.length;
  const lookupGridOffset =
    lookupGridData.length > 0 ? idwGridDataOffset + idwGridData.length : 0;
  const packedSize =
    idwGridDataOffset + idwGridData.length + lookupGridData.length;

  // Back with SharedArrayBuffer so the CPU query worker pool can share
  // the packed data across workers without per-worker copies.
  const sab = new SharedArrayBuffer(packedSize * Uint32Array.BYTES_PER_ELEMENT);
  const packed = new Uint32Array(sab);
  const packedFloat = new Float32Array(sab);

  // Write header
  packed[0] = verticesOffset;
  packed[1] = contoursOffset;
  packed[2] = childrenOffset;
  packed[3] = containmentGridOffset;
  packed[4] = idwGridDataOffset;
  packed[5] = lookupGridOffset;

  // Write vertex data (f32 pairs → stored as u32 via shared buffer)
  for (let i = 0; i < vertexCount; i++) {
    packedFloat[verticesOffset + i] = vertexData[i];
  }

  // Write contour data (mixed u32/f32 - contourData is already an ArrayBuffer)
  // Contour field 13 (idwGridDataOffset) stores (relative offset + 1) where
  // 0 means "no grid". Convert to absolute offset in packed buffer.
  const contourSrc = new Uint32Array(contourData);
  for (let i = 0; i < contourFloatCount; i++) {
    packed[contoursOffset + i] = contourSrc[i];
  }
  for (let ci = 0; ci < contourCount; ci++) {
    const fieldOffset = contoursOffset + ci * FLOATS_PER_CONTOUR + 13;
    const encoded = packed[fieldOffset];
    if (encoded !== 0) {
      packed[fieldOffset] = idwGridDataOffset + (encoded - 1);
    }
  }

  // Write children data
  for (let i = 0; i < childrenData.length; i++) {
    packed[childrenOffset + i] = childrenData[i];
  }

  // Write containment grid data
  for (let i = 0; i < containmentGridData.length; i++) {
    packed[containmentGridOffset + i] = containmentGridData[i];
  }

  // Write IDW grid data
  for (let i = 0; i < idwGridData.length; i++) {
    packed[idwGridDataOffset + i] = idwGridData[i];
  }

  // Write lookup grid data
  if (lookupGridOffset > 0) {
    for (let i = 0; i < lookupGridData.length; i++) {
      packed[lookupGridOffset + i] = lookupGridData[i];
    }
  }

  return packed;
}

/**
 * Manages GPU resources for terrain data.
 *
 * Resource provider that owns GPU buffers and provides access to them.
 * Also stores the terrain definition for CPU access and tracks version changes.
 *
 * Terrain data is packed into a single `array<u32>` storage buffer with layout:
 * ```
 * [verticesOffset, contoursOffset, childrenOffset, containmentGridOffset, idwGridDataOffset, lookupGridOffset,
 *  ...vertices (f32 pairs as u32)...,
 *  ...contours (14 mixed fields as u32)...,
 *  ...children (u32)...,
 *  ...containment grids (256 u32 per contour, 2-bit packed flags)...,
 *  ...IDW grid data (variable, prefix-sum cell_starts + packed entries)...,
 *  ...lookup grid data (level-wide 256×256 contour lookup grid)...]
 * ```
 */
export class TerrainResources extends BaseEntity {
  id = "terrainResources";

  // Single packed GPU buffer for all terrain data
  packedTerrainBuffer!: GPUBuffer;

  /**
   * Raw CPU-side view of the packed terrain data — identical bytes to
   * what's uploaded to `packedTerrainBuffer`. Used by the CPU query
   * backend. Updated on each upload.
   */
  private packedTerrainRaw: Uint32Array | null = null;

  // Terrain definition (normalized to CCW winding)
  private terrainDefinition: TerrainDefinition;

  // Version number - increments when terrain changes
  private version: number = 0;

  private contourCount: number = 0;

  constructor(terrainDefinition: TerrainDefinition) {
    super();

    // Normalize contour winding to CCW for consistent wave physics
    this.terrainDefinition = normalizeTerrainWinding(terrainDefinition);
  }

  @on("add")
  onAdd(): void {
    // Upload initial terrain data (creates buffer sized to actual data)
    this.uploadTerrainData(this.terrainDefinition);
  }

  @on("destroy")
  onDestroy(): void {
    this.packedTerrainBuffer.destroy();
  }

  /**
   * Upload terrain data to packed GPU buffer.
   *
   * Packed layout (all u32):
   * [0] verticesOffset - element index where vertex data starts
   * [1] contoursOffset - element index where contour data starts
   * [2] childrenOffset - element index where children data starts
   * [3] containmentGridOffset - element index where containment grid data starts
   * [4] idwGridDataOffset - element index where IDW grid data starts
   * [5] lookupGridOffset - element index where lookup grid data starts (0 = no grid)
   * [6..] vertex data (f32 pairs stored as u32 via bitcast)
   * [...] contour data (14 fields per contour, mixed u32/f32 via bitcast)
   * [...] children data (u32 indices)
   * [...] containment grid data (256 u32 per contour, 2-bit packed flags)
   * [...] IDW grid data (variable, prefix-sum + packed entries)
   * [...] lookup grid data (level-wide 256×256 contour lookup grid)
   *
   * @internal
   */
  private uploadTerrainData(definition: TerrainDefinition): void {
    const device = this.game.getWebGPUDevice();
    const gpuData = definition.precomputedGPUData
      ? buildTerrainGPUDataFromPrecomputed(definition.precomputedGPUData)
      : buildTerrainGPUData(definition);

    const packed = packTerrainBuffer(gpuData);

    // Recreate GPU buffer sized to actual data
    this.packedTerrainBuffer?.destroy();
    this.packedTerrainBuffer = device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Packed Terrain Buffer",
    });
    device.queue.writeBuffer(
      this.packedTerrainBuffer,
      0,
      packed.buffer,
      packed.byteOffset,
      packed.byteLength,
    );
    this.packedTerrainRaw = packed;

    this.contourCount = gpuData.contourCount;
  }

  /**
   * Raw CPU-side Uint32Array view of the packed terrain data. Used by
   * the CPU query backend (copied into each worker at init).
   */
  getPackedTerrainRaw(): Uint32Array {
    return this.packedTerrainRaw!;
  }

  /**
   * Get the number of contours.
   */
  getContourCount(): number {
    return this.contourCount;
  }

  /**
   * Get all contours (read-only).
   */
  getContours(): readonly TerrainContour[] {
    return this.terrainDefinition.contours;
  }

  /**
   * Get the full terrain definition.
   */
  getTerrainDefinition(): TerrainDefinition {
    return this.terrainDefinition;
  }

  /**
   * Update the terrain definition (e.g., for level loading or editor changes).
   * Normalizes contour winding to CCW for consistent wave physics.
   */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.terrainDefinition = normalizeTerrainWinding(definition);
    this.uploadTerrainData(this.terrainDefinition);
    this.version++;
  }

  /**
   * Get the terrain definition version.
   * Increments whenever terrain data changes.
   */
  getVersion(): number {
    return this.version;
  }
}
