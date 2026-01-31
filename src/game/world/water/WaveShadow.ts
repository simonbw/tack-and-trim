/**
 * WaveShadow: Computes and manages shadow geometry for a single wave direction.
 *
 * Each wave source casts shadows behind islands and coastlines. This entity:
 * - Computes shadow polygons from coastline splines
 * - Manages a VirtualTexture for rasterized shadow tiles
 * - Uploads shadow geometry to GPU buffers for tile compute shader
 */

import { BaseEntity } from "../../../core/entity/BaseEntity";
import { on } from "../../../core/entity/handler";
import { V, V2d } from "../../../core/Vector";
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { VirtualTexture } from "../../../core/graphics/webgpu/virtual-texture/VirtualTexture";
import type { BindGroupResources } from "../../../core/graphics/webgpu/ShaderBindings";
import { WorkerPool } from "../../../core/workers/WorkerPool";
import { TerrainSystem } from "../terrain/TerrainSystem";
import type { TerrainContour } from "../terrain/TerrainTypes";
import type { WaveSource } from "./WaveSource";
import { ShadowTileCompute, ShadowTileBindings } from "./ShadowTileCompute";
import type { AABB } from "../../../core/physics/collision/AABB";
import type { ShadowComputeRequest, ShadowComputeResult } from "./ShadowWorker";

/**
 * A shadow polygon extending from a coastline
 */
interface ShadowPolygon {
  /** Vertex positions in world space */
  vertices: V2d[];
}

/**
 * WaveShadow entity - computes and manages shadow geometry for one wave direction.
 */
export class WaveShadow extends BaseEntity {
  readonly tickLayer = "environment";

  private readonly waveSource: WaveSource;
  private readonly waveIndex: number;
  private shadowPolygons: ShadowPolygon[] = [];
  private virtualTexture: VirtualTexture<typeof ShadowTileBindings> | null =
    null;
  private tileCompute: ShadowTileCompute | null = null;

  // GPU buffers
  private polygonMetadataBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private sharedParamsBuffer: GPUBuffer | null = null;

  // Shared worker pool for all WaveShadow instances
  private static workerPool: WorkerPool<
    ShadowComputeRequest,
    ShadowComputeResult
  > | null = null;

  // Shadow constants (kept for reference, but computation now happens in worker)
  private static readonly SHADOW_EXTENSION = 1000; // meters

  constructor(waveSource: WaveSource, waveIndex: number) {
    super();
    this.waveSource = waveSource;
    this.waveIndex = waveIndex;
  }

  /**
   * Initialize shadow system - computation happens async in worker
   */
  @on("add")
  async onAdd(): Promise<void> {
    try {
      // Check if TerrainSystem exists first
      const terrainSystem = this.game.entities.tryGetSingleton(TerrainSystem);
      if (!terrainSystem) {
        this.shadowPolygons = [];
        return;
      }

      // Get coastlines from terrain system
      const coastlines = terrainSystem.getCoastlines();

      // Skip shadow computation if no coastlines
      if (coastlines.length === 0) {
        this.shadowPolygons = [];
        // Dispatch event even with no shadows
        this.game.dispatch("shadowsComputed", {
          waveIndex: this.waveIndex,
          polygonCount: 0,
        });
        return;
      }

      // Initialize worker pool if not already done
      if (!WaveShadow.workerPool) {
        WaveShadow.workerPool = new WorkerPool({
          workerUrl: new URL("./ShadowWorker.ts", import.meta.url),
          label: "ShadowWorker",
          workerCount: 1, // Single worker is fine for this task
        });
      }

      // Ensure worker pool is initialized
      await WaveShadow.workerPool.initialize();

      // Dispatch computation to worker (non-blocking!)
      // Note: We do this async so the main thread continues immediately
      this.computeShadowsAsync(coastlines);
    } catch (error) {
      console.warn(
        `[WaveShadow ${this.waveIndex}] Failed to initialize worker:`,
        error,
      );
      // Continue without shadows - WaterSystem will use dummy texture
      this.shadowPolygons = [];
    }
  }

  /**
   * Compute shadows asynchronously using the worker pool.
   * This doesn't block the main thread.
   */
  private async computeShadowsAsync(coastlines: readonly TerrainContour[]) {
    try {
      console.log(
        `[WaveShadow ${this.waveIndex}] Starting shadow computation for ${coastlines.length} coastline(s)...`,
      );
      const startTime = performance.now();

      // Create worker requests (one per coastline)
      const requests: ShadowComputeRequest[] = coastlines.map((coastline) => ({
        type: "compute",
        batchId: 0, // Will be set by WorkerPool
        coastlinePoints: coastline.controlPoints.map((p) => ({
          x: p.x,
          y: p.y,
        })),
        waveDirection: {
          x: this.waveSource.directionVec.x,
          y: this.waveSource.directionVec.y,
        },
      }));

      // Build shadow polygons array to be populated by combineResults
      const shadowPolygons: ShadowPolygon[] = [];

      // Run computation in worker
      const task = WaveShadow.workerPool!.run({
        batches: requests,
        combineResults: (results) => {
          // Build shadow polygons from all worker results
          for (const result of results) {
            if (result.shadowPolygons) {
              // Each result can contain multiple shadow polygons
              for (const polygon of result.shadowPolygons) {
                shadowPolygons.push({
                  vertices: polygon.map((v: { x: number; y: number }) =>
                    V(v.x, v.y),
                  ),
                });
              }
            }
          }

          // Return first result (doesn't matter, we populated shadowPolygons)
          return (
            results[0] || { type: "result", batchId: 0, shadowPolygons: null }
          );
        },
      });

      // Wait for worker to finish
      await task.promise;

      // Assign the populated array
      this.shadowPolygons = shadowPolygons;

      const elapsedMs = performance.now() - startTime;
      console.log(
        `[WaveShadow ${this.waveIndex}] ✓ Shadow computation complete! Generated ${this.shadowPolygons.length} shadow polygon(s) in ${elapsedMs.toFixed(1)}ms`,
      );

      // Only initialize GPU resources if we have shadow polygons
      if (this.shadowPolygons.length > 0) {
        // Initialize GPU resources now that we have shadow data
        await this.initializeGPU();

        // Upload shadow data to GPU
        this.uploadShadowData();
      }

      // Dispatch event that shadows are ready
      this.game.dispatch("shadowsComputed", {
        waveIndex: this.waveIndex,
        polygonCount: this.shadowPolygons.length,
      });
    } catch (error) {
      console.error(
        `[WaveShadow ${this.waveIndex}] Shadow computation failed:`,
        error,
      );
      this.shadowPolygons = [];
    }
  }

  /**
   * Update VirtualTexture each tick
   */
  @on("tick")
  onTick(dt: number): void {
    this.virtualTexture?.update(dt);
  }

  /**
   * Clean up GPU resources
   */
  @on("destroy")
  onDestroy(): void {
    this.virtualTexture?.destroy();
    this.tileCompute?.destroy();
    this.polygonMetadataBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.sharedParamsBuffer?.destroy();

    this.virtualTexture = null;
    this.tileCompute = null;
    this.polygonMetadataBuffer = null;
    this.vertexBuffer = null;
    this.sharedParamsBuffer = null;
  }

  /**
   * Initialize GPU resources (VirtualTexture, compute shader, buffers)
   */
  private async initializeGPU(): Promise<void> {
    const device = getWebGPU().device;

    // Create tile compute shader
    this.tileCompute = new ShadowTileCompute();
    await this.tileCompute.init();

    // Calculate buffer sizes
    const totalVertices = this.shadowPolygons.reduce(
      (sum, poly) => sum + poly.vertices.length,
      0,
    );
    const polygonCount = this.shadowPolygons.length;

    // Create polygon metadata buffer
    const metadataSize = polygonCount * 4 * Uint32Array.BYTES_PER_ELEMENT; // 4 u32s per polygon
    this.polygonMetadataBuffer = device.createBuffer({
      label: `WaveShadow ${this.waveIndex} Metadata`,
      size: Math.max(metadataSize, 16), // Minimum size
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create vertex buffer
    const vertexSize = totalVertices * 2 * Float32Array.BYTES_PER_ELEMENT; // vec2f per vertex
    this.vertexBuffer = device.createBuffer({
      label: `WaveShadow ${this.waveIndex} Vertices`,
      size: Math.max(vertexSize, 16), // Minimum size
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create shared params buffer (polygonCount)
    this.sharedParamsBuffer = device.createBuffer({
      label: `WaveShadow ${this.waveIndex} Params`,
      size: 4 * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create VirtualTexture for shadow tiles
    // IMPORTANT: Must create AFTER buffers, since VirtualTexture may immediately request tiles
    this.virtualTexture = new VirtualTexture({
      tileSize: 128,
      maxTiles: 256, // Smaller cache since we have multiple shadow textures
      tileCompute: this.tileCompute,
      format: "rg32float",
      label: `WaveShadow ${this.waveIndex}`,
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
  }

  /**
   * Upload shadow polygon data to GPU buffers
   */
  private uploadShadowData(): void {
    if (
      !this.polygonMetadataBuffer ||
      !this.vertexBuffer ||
      !this.sharedParamsBuffer
    ) {
      return;
    }

    const device = getWebGPU().device;

    // Pack metadata
    const metadataArray = new Uint32Array(this.shadowPolygons.length * 4);
    let vertexOffset = 0;

    for (let i = 0; i < this.shadowPolygons.length; i++) {
      const poly = this.shadowPolygons[i];
      metadataArray[i * 4 + 0] = vertexOffset;
      metadataArray[i * 4 + 1] = poly.vertices.length;
      metadataArray[i * 4 + 2] = 0; // padding
      metadataArray[i * 4 + 3] = 0; // padding
      vertexOffset += poly.vertices.length;
    }

    // Pack vertices
    const totalVertices = this.shadowPolygons.reduce(
      (sum, poly) => sum + poly.vertices.length,
      0,
    );
    const vertexArray = new Float32Array(totalVertices * 2);
    let vertexIndex = 0;

    for (const poly of this.shadowPolygons) {
      for (const vertex of poly.vertices) {
        vertexArray[vertexIndex++] = vertex.x;
        vertexArray[vertexIndex++] = vertex.y;
      }
    }

    // Upload to GPU
    device.queue.writeBuffer(this.polygonMetadataBuffer, 0, metadataArray);
    device.queue.writeBuffer(this.vertexBuffer, 0, vertexArray);

    // Upload params (polygon count)
    const paramsArray = new Uint32Array([
      this.shadowPolygons.length,
      0, // padding
      0, // padding
      0, // padding
    ]);
    device.queue.writeBuffer(this.sharedParamsBuffer, 0, paramsArray);
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
    if (
      !this.virtualTexture ||
      !this.tileCompute ||
      !this.polygonMetadataBuffer ||
      !this.vertexBuffer ||
      !this.sharedParamsBuffer
    ) {
      return;
    }

    const device = getWebGPU().device;
    const tileSize = 128;
    const scale = Math.pow(2, lod);
    const worldTileSize = tileSize * scale;

    // Create tile params buffer for this specific tile
    const tileParamsData = new Float32Array([lod, tileX, tileY, worldTileSize]);

    const tileParamsBuffer = device.createBuffer({
      label: `WaveShadow ${this.waveIndex} Tile Params ${lod},${tileX},${tileY}`,
      size: tileParamsData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(tileParamsBuffer, 0, tileParamsData);

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
    const bindGroupResources: BindGroupResources<typeof ShadowTileBindings> = {
      polygonMetadata: { buffer: this.polygonMetadataBuffer },
      vertices: { buffer: this.vertexBuffer },
      params: { buffer: this.sharedParamsBuffer },
      tileParams: { buffer: tileParamsBuffer },
      output: textureView,
    };

    const bindGroup = this.tileCompute.createBindGroup(bindGroupResources);

    // Create command encoder
    const commandEncoder = device.createCommandEncoder({
      label: `WaveShadow ${this.waveIndex} Compute Tile ${lod},${tileX},${tileY}`,
    });

    // Dispatch compute shader
    const computePass = commandEncoder.beginComputePass({
      label: `WaveShadow ${this.waveIndex} Compute Pass`,
    });

    this.tileCompute.dispatch(computePass, bindGroup, tileSize, 1);

    computePass.end();

    // Submit to GPU
    device.queue.submit([commandEncoder.finish()]);

    // Clean up temporary buffer
    tileParamsBuffer.destroy();
  }

  /**
   * Request shadow tiles for a region
   */
  requestTilesForRect(rect: AABB, lod: number): void {
    this.virtualTexture?.requestTilesForRect(rect, lod);
  }

  /**
   * Get the shadow texture (for binding in water compute shader)
   */
  getShadowTexture(): GPUTexture | null {
    return this.virtualTexture?.getTextureArray() || null;
  }

  /**
   * Get GPU buffers for binding in tile compute shader
   */
  getBuffers(): {
    metadata: GPUBuffer | null;
    vertices: GPUBuffer | null;
    params: GPUBuffer | null;
  } {
    return {
      metadata: this.polygonMetadataBuffer,
      vertices: this.vertexBuffer,
      params: this.sharedParamsBuffer,
    };
  }
}
