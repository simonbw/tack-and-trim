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
  FLOATS_PER_CONTOUR,
  normalizeTerrainWinding,
} from "./LandMass";
import {
  CONTAINMENT_GRID_U32S_PER_CONTOUR,
  MAX_CHILDREN,
  MAX_CONTOURS,
  MAX_IDW_DATA,
  MAX_VERTICES,
} from "./TerrainConstants";

/** Header size for packed terrain buffer: 5 u32 offsets (vertices, contours, children, containmentGrid, idwGridData) */
const PACKED_TERRAIN_HEADER_SIZE = 5;

/** Total packed buffer size in u32 elements */
const PACKED_TERRAIN_SIZE =
  PACKED_TERRAIN_HEADER_SIZE +
  MAX_VERTICES * 2 + // vertices: 2 u32 per vertex (f32 pair bitcast)
  MAX_CONTOURS * FLOATS_PER_CONTOUR + // contours: 14 u32 per contour
  MAX_CHILDREN + // children: 1 u32 per child
  MAX_CONTOURS * CONTAINMENT_GRID_U32S_PER_CONTOUR + // containment grids: 256 u32 per contour
  MAX_IDW_DATA; // IDW grid data: 2M u32s

/**
 * Manages GPU resources for terrain data.
 *
 * Resource provider that owns GPU buffers and provides access to them.
 * Also stores the terrain definition for CPU access and tracks version changes.
 *
 * Terrain data is packed into a single `array<u32>` storage buffer with layout:
 * ```
 * [verticesOffset, contoursOffset, childrenOffset, containmentGridOffset, idwGridDataOffset,
 *  ...vertices (f32 pairs as u32)...,
 *  ...contours (14 mixed fields as u32)...,
 *  ...children (u32)...,
 *  ...containment grids (256 u32 per contour, 2-bit packed flags)...,
 *  ...IDW grid data (variable, prefix-sum cell_starts + packed entries)...]
 * ```
 */
export class TerrainResources extends BaseEntity {
  id = "terrainResources";

  // Single packed GPU buffer for all terrain data
  packedTerrainBuffer!: GPUBuffer;

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
  onAdd({ game }: GameEventMap["add"]): void {
    // Create single packed GPU buffer
    this.packedTerrainBuffer = game.getWebGPUDevice().createBuffer({
      size: PACKED_TERRAIN_SIZE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Packed Terrain Buffer",
    });

    // Upload initial terrain data
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
   * [5..] vertex data (f32 pairs stored as u32 via bitcast)
   * [...] contour data (14 fields per contour, mixed u32/f32 via bitcast)
   * [...] children data (u32 indices)
   * [...] containment grid data (256 u32 per contour, 2-bit packed flags)
   * [...] IDW grid data (variable, prefix-sum + packed entries)
   *
   * @internal
   */
  private uploadTerrainData(definition: TerrainDefinition): void {
    const device = this.game.getWebGPUDevice();
    const gpuData = buildTerrainGPUData(definition);
    const {
      vertexData,
      contourData,
      childrenData,
      containmentGridData,
      idwGridData,
      contourCount,
    } = gpuData;

    const packed = new Uint32Array(PACKED_TERRAIN_SIZE);
    const packedFloat = new Float32Array(packed.buffer);

    // Compute section offsets (element indices into packed array)
    const verticesOffset = PACKED_TERRAIN_HEADER_SIZE;
    const vertexCount = vertexData.length; // number of f32s (2 per vertex)
    const contoursOffset = verticesOffset + MAX_VERTICES * 2;
    const contourFloatCount = contourCount * FLOATS_PER_CONTOUR;
    const childrenOffset = contoursOffset + MAX_CONTOURS * FLOATS_PER_CONTOUR;
    const containmentGridOffset = childrenOffset + MAX_CHILDREN;
    const idwGridDataOffset =
      containmentGridOffset + MAX_CONTOURS * CONTAINMENT_GRID_U32S_PER_CONTOUR;

    // Write header
    packed[0] = verticesOffset;
    packed[1] = contoursOffset;
    packed[2] = childrenOffset;
    packed[3] = containmentGridOffset;
    packed[4] = idwGridDataOffset;

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

    device.queue.writeBuffer(this.packedTerrainBuffer, 0, packed.buffer);

    this.contourCount = contourCount;
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
