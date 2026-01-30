/**
 * TerrainSystem: Main terrain entity orchestrating CPU and GPU terrain queries.
 *
 * Manages:
 * - ContainmentTree for CPU-side height queries
 * - VirtualTexture for GPU tile streaming
 * - Shared GPU buffers for tile and query shaders
 */

import { Game } from "../../../core/Game";
import type { V2d } from "../../../core/Vector";
import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import type { BindGroupResources } from "../../../core/graphics/webgpu/ShaderBindings";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { VirtualTexture } from "../../../core/graphics/webgpu/virtual-texture/VirtualTexture";
import type { AABB } from "../../../core/physics/collision/AABB";
import { ContainmentTree, type ContourNode } from "./ContainmentTree";
import {
  TerrainQueryBindings,
  TerrainQueryCompute,
} from "./TerrainQueryCompute";
import { TerrainTileBindings, TerrainTileCompute } from "./TerrainTileCompute";
import type { TerrainContour, TerrainDefinition } from "./TerrainTypes";

/**
 * GPU-friendly representation of a contour node.
 */
interface ContourGPU {
  controlPointStart: number;
  controlPointCount: number;
  height: number;
  childrenStart: number; // -1 if no children
  childrenCount: number;
}

/**
 * Main terrain system entity.
 *
 * Provides both CPU-side queries (via ContainmentTree) and GPU-side
 * tile generation and batch queries (via compute shaders).
 */
export class TerrainSystem extends BaseEntity {
  /** Retrieve the TerrainSystem instance from the game */
  static fromGame(game: Game): TerrainSystem {
    const maybeTerrainSystem = game.entities.getById("terrainSystem");
    if (!(maybeTerrainSystem instanceof TerrainSystem)) {
      throw new Error("TerrainSystem not found");
    }
    return maybeTerrainSystem;
  }

  readonly id = "terrainSystem";
  readonly tickLayer = "environment";

  /** Current terrain definition */
  private definition: TerrainDefinition;

  /** CPU-side containment tree for immediate queries */
  private containmentTree: ContainmentTree | null = null;

  // GPU components
  private virtualTexture: VirtualTexture<typeof TerrainTileBindings> | null =
    null;
  private tileCompute: TerrainTileCompute | null = null;
  private queryCompute: TerrainQueryCompute | null = null;

  // Shared GPU buffers
  private contourBuffer: GPUBuffer | null = null;
  private controlPointBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer | null = null;
  private tileParamsBuffer: GPUBuffer | null = null;

  // Cached bind groups (one per tile, created lazily)
  private bindGroupCache = new Map<string, GPUBindGroup>();

  // Number of root contours (for GPU shader)
  private rootCount = 0;

  /**
   * Create a terrain system with the given definition.
   *
   * @param definition - Terrain contours and default depth
   */
  constructor(definition: TerrainDefinition) {
    super();
    this.definition = definition;
  }

  /**
   * Initialize the terrain system.
   * Builds the CPU-side containment tree and prepares GPU resources.
   */
  @on("add")
  async onAdd(): Promise<void> {
    // Build CPU-side containment tree
    this.containmentTree = new ContainmentTree(
      this.definition.contours,
      this.definition.defaultDepth,
    );

    console.log(
      `TerrainSystem: Built containment tree with ${this.definition.contours.length} contours`,
    );
    console.log(
      `TerrainSystem: Found ${this.getCoastlines().length} coastline contours`,
    );

    // Initialize GPU resources
    await this.initializeGPU();
  }

  /**
   * Update terrain system each tick.
   * Updates the virtual texture to process pending tile requests.
   */
  @on("tick")
  onTick(_dt: number): void {
    this.virtualTexture?.update(_dt);
  }

  /**
   * Clean up GPU resources when destroyed.
   */
  @on("destroy")
  onDestroy(): void {
    this.virtualTexture?.destroy();
    this.tileCompute?.destroy();

    this.contourBuffer?.destroy();
    this.controlPointBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.tileParamsBuffer?.destroy();

    this.contourBuffer = null;
    this.controlPointBuffer = null;
    this.paramsBuffer = null;
    this.tileParamsBuffer = null;
    this.virtualTexture = null;
    this.tileCompute = null;
    this.queryCompute = null;
    this.bindGroupCache.clear();
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Get the terrain height/depth at a specific world position.
   * Uses the CPU-side containment tree for immediate results.
   *
   * @param point - World position to query
   * @returns Height/depth value at the point
   */
  getHeightAt(point: V2d): number {
    if (!this.containmentTree) {
      return this.definition.defaultDepth;
    }
    return this.containmentTree.getHeightAt(point);
  }

  /**
   * Get all coastline contours (height ≈ 0).
   *
   * @returns Array of coastline contours
   */
  getCoastlines(): readonly TerrainContour[] {
    if (!this.containmentTree) {
      return [];
    }
    return this.containmentTree.getCoastlines();
  }

  /**
   * Request tiles for a rectangular region at a specific LOD.
   * Tiles will be generated asynchronously by the virtual texture system.
   *
   * @param rect - World-space bounding box to cover
   * @param lod - Level of detail (0 = highest detail)
   */
  requestTilesForRect(rect: AABB, lod: number): void {
    this.virtualTexture?.requestTilesForRect(rect, lod);
  }

  /**
   * Get the GPU texture containing terrain height tiles.
   *
   * @returns The terrain height texture, or null if not initialized
   */
  getTerrainTexture(): GPUTexture | null {
    return this.virtualTexture?.getTextureArray() || null;
  }

  /**
   * Update the terrain definition and rebuild the tree.
   * Used by the editor or when loading new levels.
   *
   * @param definition - New terrain definition
   */
  async setDefinition(definition: TerrainDefinition): Promise<void> {
    this.definition = definition;

    // Rebuild containment tree
    this.containmentTree = new ContainmentTree(
      definition.contours,
      definition.defaultDepth,
    );

    // Re-upload to GPU and invalidate tiles
    await this.uploadContoursToGPU();
    this.virtualTexture?.invalidate();
  }

  /**
   * Compute query results for a batch of points.
   * Called by TerrainQueryManager to run GPU compute.
   *
   * @param pointBuffer - GPU buffer containing query points (vec2f array)
   * @param resultBuffer - GPU buffer to write results (f32 array: stride=4 per point)
   * @param pointCount - Number of points to query
   */
  computeQueryResults(
    pointBuffer: GPUBuffer,
    resultBuffer: GPUBuffer,
    pointCount: number,
  ): void {
    if (!this.queryCompute) {
      console.warn(
        "TerrainSystem: Query compute shader not initialized, skipping query",
      );
      return;
    }

    // Skip if no points to query (avoids WebGPU warning)
    if (pointCount === 0) {
      return;
    }

    const device = getWebGPU().device;

    // Create bind group for this query
    const bindGroupResources: BindGroupResources<typeof TerrainQueryBindings> =
      {
        queryPoints: { buffer: pointBuffer },
        results: { buffer: resultBuffer },
        contours: { buffer: this.contourBuffer! },
        controlPoints: { buffer: this.controlPointBuffer! },
        params: { buffer: this.paramsBuffer! },
      };

    const bindGroup = this.queryCompute.createBindGroup(bindGroupResources);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: "Terrain Query Compute",
    });

    // Dispatch compute shader
    const computePass = commandEncoder.beginComputePass({
      label: "Terrain Query Compute Pass",
    });

    this.queryCompute.dispatch(computePass, bindGroup, pointCount, 1);

    computePass.end();

    // Submit to GPU
    device.queue.submit([commandEncoder.finish()]);
  }

  // ========================================================================
  // Private GPU Methods
  // ========================================================================

  /**
   * Initialize GPU resources.
   */
  private async initializeGPU(): Promise<void> {
    if (!this.containmentTree) {
      throw new Error("ContainmentTree not initialized");
    }

    // Upload contours to GPU
    await this.uploadContoursToGPU();

    // Initialize tile compute shader
    this.tileCompute = new TerrainTileCompute();
    await this.tileCompute.init();

    // Initialize query compute shader
    this.queryCompute = new TerrainQueryCompute();
    await this.queryCompute.init();

    // Create virtual texture with custom tile compute callback
    this.virtualTexture = new VirtualTexture({
      tileSize: 128,
      maxTiles: 256, // WebGPU max texture array layers
      tileCompute: this.tileCompute,
      format: "r32float",
      label: "Terrain Heights",
    });

    // Patch VirtualTexture to use our custom bind group creation
    // This is needed because VirtualTexture doesn't know about our tile-specific uniforms
    (this.virtualTexture as any).computeTile = (
      lod: number,
      tileX: number,
      tileY: number,
    ) => {
      this.computeTileWithBindings(lod, tileX, tileY);
    };

    console.log("TerrainSystem: GPU resources initialized");
  }

  /**
   * Upload contours to GPU buffers.
   * Flattens the containment tree to GPU-friendly arrays.
   */
  private async uploadContoursToGPU(): Promise<void> {
    if (!this.containmentTree) {
      return;
    }

    const device = getWebGPU().device;

    // Flatten the tree to GPU-friendly arrays
    const { contours, controlPoints } = this.flattenTreeToGPUArrays();
    this.rootCount = this.containmentTree.getRoots().length;

    // Create contour buffer (array of ContourGPU structs)
    // struct ContourGPU { u32, u32, f32, i32, u32, vec3u } = 32 bytes
    const contourData = new ArrayBuffer(contours.length * 32);
    const contourView = new DataView(contourData);

    for (let i = 0; i < contours.length; i++) {
      const c = contours[i];
      const offset = i * 32;
      contourView.setUint32(offset + 0, c.controlPointStart, true);
      contourView.setUint32(offset + 4, c.controlPointCount, true);
      contourView.setFloat32(offset + 8, c.height, true);
      contourView.setInt32(offset + 12, c.childrenStart, true);
      contourView.setUint32(offset + 16, c.childrenCount, true);
      // padding: 12 bytes
    }

    this.contourBuffer?.destroy();
    this.contourBuffer = device.createBuffer({
      label: "Terrain Contours",
      size: contourData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.contourBuffer, 0, contourData);

    // Create control point buffer (array of vec2f)
    const controlPointData = new Float32Array(controlPoints.length * 2);
    for (let i = 0; i < controlPoints.length; i++) {
      controlPointData[i * 2 + 0] = controlPoints[i].x;
      controlPointData[i * 2 + 1] = controlPoints[i].y;
    }

    this.controlPointBuffer?.destroy();
    this.controlPointBuffer = device.createBuffer({
      label: "Terrain Control Points",
      size: controlPointData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.controlPointBuffer, 0, controlPointData);

    // Create params buffer (uniform: defaultDepth, rootCount, padding)
    const paramsData = new Float32Array(4); // vec4 for alignment
    paramsData[0] = this.definition.defaultDepth;
    paramsData[1] = this.rootCount; // Will be cast to u32 in shader
    // padding at [2], [3]

    this.paramsBuffer?.destroy();
    this.paramsBuffer = device.createBuffer({
      label: "Terrain Params",
      size: paramsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Create tile params buffer (uniform, updated per tile)
    // struct TileParams { u32 lod, i32 tileX, i32 tileY, u32 tileSize, f32 worldTileSize, vec3u padding }
    this.tileParamsBuffer?.destroy();
    this.tileParamsBuffer = device.createBuffer({
      label: "Terrain Tile Params",
      size: 32, // 8 fields × 4 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    console.log(
      `TerrainSystem: Uploaded ${contours.length} contours with ${controlPoints.length} control points`,
    );
  }

  /**
   * Flatten the containment tree to GPU-friendly arrays.
   *
   * Performs a depth-first traversal to assign contiguous array indices
   * to parent and child nodes.
   */
  private flattenTreeToGPUArrays(): {
    contours: ContourGPU[];
    controlPoints: V2d[];
  } {
    if (!this.containmentTree) {
      return { contours: [], controlPoints: [] };
    }

    const contours: ContourGPU[] = [];
    const controlPoints: V2d[] = [];
    const roots = this.containmentTree.getRoots();

    // Recursive depth-first traversal
    const traverse = (node: ContourNode): number => {
      const myIndex = contours.length;

      // Add control points for this contour
      const controlPointStart = controlPoints.length;
      const controlPointCount = node.contour.controlPoints.length;
      controlPoints.push(...node.contour.controlPoints);

      // Reserve space for this contour (will fill in children info later)
      contours.push({
        controlPointStart,
        controlPointCount,
        height: node.contour.height,
        childrenStart: -1,
        childrenCount: 0,
      });

      // Process children
      if (node.children.length > 0) {
        const childrenStart = contours.length;
        for (const child of node.children) {
          traverse(child);
        }

        // Update parent with children info
        contours[myIndex].childrenStart = childrenStart;
        contours[myIndex].childrenCount = node.children.length;
      }

      return myIndex;
    };

    // Traverse all roots
    for (const root of roots) {
      traverse(root);
    }

    return { contours, controlPoints };
  }

  /**
   * Compute a single tile with proper bind group.
   * Called by VirtualTexture's patched computeTile method.
   */
  private computeTileWithBindings(
    lod: number,
    tileX: number,
    tileY: number,
  ): void {
    if (!this.virtualTexture || !this.tileCompute) {
      return;
    }

    const device = getWebGPU().device;
    const tileSize = 128;
    const scale = Math.pow(2, lod);
    const worldTileSize = tileSize * scale;

    // Update tile params buffer
    const tileParamsData = new ArrayBuffer(32);
    const tileParamsView = new DataView(tileParamsData);
    tileParamsView.setUint32(0, lod, true);
    tileParamsView.setInt32(4, tileX, true);
    tileParamsView.setInt32(8, tileY, true);
    tileParamsView.setUint32(12, tileSize, true);
    tileParamsView.setFloat32(16, worldTileSize, true);
    // padding: 12 bytes

    device.queue.writeBuffer(this.tileParamsBuffer!, 0, tileParamsData);

    // Allocate cache entry
    const cache = (this.virtualTexture as any).cache;
    const tile = cache.allocate(lod, tileX, tileY, {
      computed: true,
      timestamp: Date.now(),
    });

    // Get texture view for this layer
    const textureArray = this.virtualTexture.getTextureArray();
    const textureView = textureArray.createView({
      dimension: "2d",
      baseArrayLayer: tile.textureIndex,
      arrayLayerCount: 1,
    });

    // Create bind group
    const bindGroupResources: BindGroupResources<typeof TerrainTileBindings> = {
      contours: { buffer: this.contourBuffer! },
      controlPoints: { buffer: this.controlPointBuffer! },
      params: { buffer: this.paramsBuffer! },
      tileParams: { buffer: this.tileParamsBuffer! },
      output: textureView,
    };

    const bindGroup = this.tileCompute.createBindGroup(bindGroupResources);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: `Terrain Compute Tile ${lod},${tileX},${tileY}`,
    });

    // Dispatch compute shader
    this.tileCompute.computeTile(commandEncoder, bindGroup, tileSize);

    // Submit to GPU
    device.queue.submit([commandEncoder.finish()]);
  }
}
