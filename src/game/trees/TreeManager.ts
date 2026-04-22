import { LayerName } from "../../config/layers";
import { BaseEntity } from "../../core/entity/BaseEntity";
import { GameEventMap } from "../../core/entity/Entity";
import { on } from "../../core/entity/handler";
import type { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import type { TreeFileData } from "../../pipeline/mesh-building/TreeFile";
import { TimeOfDay } from "../time/TimeOfDay";
import { WindResources } from "../world/wind/WindResources";
import { createTreeCompositeShader } from "./TreeCompositeShader";
import { TreeRasterizer } from "./TreeRasterizer";

// Spatial tile size in world feet
const TILE_SIZE = 500;

// Tree dimensions (used for visibility culling — must cover largest trees)
const OUTER_RADIUS = 16;

interface Tile {
  startIndex: number; // Index into treeData (multiply by 3 for float offset)
  count: number;
  centerX: number;
  centerY: number;
}

function tileKey(col: number, row: number): number {
  return ((col + 0x8000) << 16) | ((row + 0x8000) & 0xffff);
}

/**
 * Deterministic phase offset from tree position.
 */
function phaseFromPosition(x: number, y: number): number {
  const ix = (x * 73856093) | 0;
  const iy = (y * 19349663) | 0;
  const h = ((ix ^ iy) & 0x7fffffff) % 10000;
  return (h / 10000) * Math.PI * 2;
}

/**
 * Manages rendering of bulk trees using GPU instanced rendering.
 * CPU does visibility culling via a tile grid, then uploads visible
 * tree data to a GPU storage buffer for instanced rendering with
 * wind sway computed entirely on GPU.
 *
 * Trees render to an offscreen texture via a separate command encoder
 * (like SurfaceRenderer), then composite into the main render pass.
 * This avoids expensive render pass restarts on tile-based GPUs and
 * gives GPU profiling for free.
 */
export class TreeManager extends BaseEntity {
  layer: LayerName = "trees";

  /** Flat array, stride 3: [x, y, phaseOffset, ...] */
  private readonly treeData: Float32Array;
  private readonly tiles: Map<number, Tile>;

  // GPU rendering
  private rasterizer: TreeRasterizer | null = null;
  private compositeShader: FullscreenShader | null = null;
  private compositeBindGroup: GPUBindGroup | null = null;
  private lastTextureView: GPUTextureView | null = null;
  private gpuTreeData: Float32Array; // staging buffer, stride 4: [x, y, phase, 0]
  private gpuTreeCapacity: number;

  constructor(data: TreeFileData) {
    super();

    const { positions } = data;
    const n = positions.length;

    // Bucket positions by tile key
    const buckets = new Map<
      number,
      { x: number; y: number; phase: number }[]
    >();
    for (let i = 0; i < n; i++) {
      const [x, y] = positions[i];
      const col = Math.floor(x / TILE_SIZE);
      const row = Math.floor(y / TILE_SIZE);
      const key = tileKey(col, row);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push({ x, y, phase: phaseFromPosition(x, y) });
    }

    // Flatten into contiguous Float32Array sorted by tile
    this.treeData = new Float32Array(n * 3);
    this.tiles = new Map();
    let offset = 0;
    for (const [key, bucket] of buckets) {
      const startIndex = offset;
      for (const { x, y, phase } of bucket) {
        this.treeData[offset * 3] = x;
        this.treeData[offset * 3 + 1] = y;
        this.treeData[offset * 3 + 2] = phase;
        offset++;
      }
      const col = ((key >> 16) & 0xffff) - 0x8000;
      const row = (key & 0xffff) - 0x8000;
      this.tiles.set(key, {
        startIndex,
        count: bucket.length,
        centerX: (col + 0.5) * TILE_SIZE,
        centerY: (row + 0.5) * TILE_SIZE,
      });
    }

    // Pre-allocate GPU staging buffer
    this.gpuTreeCapacity = Math.max(n, 256);
    this.gpuTreeData = new Float32Array(this.gpuTreeCapacity * 4);
  }

  @on("add")
  async onAdd(): Promise<void> {
    const device = this.game.getWebGPUDevice();
    this.rasterizer = new TreeRasterizer(device);
    await this.rasterizer.init();

    this.compositeShader = createTreeCompositeShader();
    await this.compositeShader.init();
  }

  @on("destroy")
  onDestroy(): void {
    this.rasterizer?.destroy();
    this.rasterizer = null;
    this.compositeShader?.destroy();
    this.compositeShader = null;
    this.compositeBindGroup = null;
    this.lastTextureView = null;
  }

  @on("render")
  onRender({ draw, camera }: GameEventMap["render"]) {
    if (!this.rasterizer || !this.compositeShader) return;

    const viewport = camera.getWorldViewport();
    const minCol = Math.floor((viewport.left - OUTER_RADIUS) / TILE_SIZE);
    const maxCol = Math.floor((viewport.right + OUTER_RADIUS) / TILE_SIZE);
    const minRow = Math.floor((viewport.top - OUTER_RADIUS) / TILE_SIZE);
    const maxRow = Math.floor((viewport.bottom + OUTER_RADIUS) / TILE_SIZE);

    // Collect visible trees into GPU staging buffer
    let visibleCount = 0;
    const data = this.treeData;

    for (let col = minCol; col <= maxCol; col++) {
      for (let row = minRow; row <= maxRow; row++) {
        const key = tileKey(col, row);
        const tile = this.tiles.get(key);
        if (!tile) continue;

        const end = tile.startIndex + tile.count;
        for (let i = tile.startIndex; i < end; i++) {
          const fi = i * 3;
          const x = data[fi];
          const y = data[fi + 1];

          // Per-tree visibility check
          if (
            x + OUTER_RADIUS < viewport.left ||
            x - OUTER_RADIUS > viewport.right ||
            y + OUTER_RADIUS < viewport.top ||
            y - OUTER_RADIUS > viewport.bottom
          ) {
            continue;
          }

          // Grow staging buffer if needed
          if (visibleCount >= this.gpuTreeCapacity) {
            this.gpuTreeCapacity *= 2;
            const newData = new Float32Array(this.gpuTreeCapacity * 4);
            newData.set(this.gpuTreeData);
            this.gpuTreeData = newData;
          }

          const gi = visibleCount * 4;
          this.gpuTreeData[gi] = x;
          this.gpuTreeData[gi + 1] = y;
          this.gpuTreeData[gi + 2] = data[fi + 2]; // phase
          this.gpuTreeData[gi + 3] = 0;
          visibleCount++;
        }
      }
    }

    if (visibleCount === 0) return;

    // Upload visible tree data to GPU
    this.rasterizer.updateTreeBuffer(this.gpuTreeData, visibleCount);

    const renderer = draw.renderer;
    const gpuProfiler = renderer.getGpuProfiler();
    const camMatrix = camera.getMatrix();
    // Use logical (CSS) pixels for camera transform — matches camera.getMatrix()
    const screenWidth = renderer.getWidth();
    const screenHeight = renderer.getHeight();
    // Use physical pixels for the offscreen texture — matches the main render target
    const physicalWidth = renderer.canvas.width;
    const physicalHeight = renderer.canvas.height;

    const windResources = this.game.entities.tryGetSingleton(WindResources);
    const baseWindX = windResources ? windResources.getBaseVelocity().x : 11;
    const baseWindY = windResources ? windResources.getBaseVelocity().y : 11;

    const timeOfDay = this.game.entities.tryGetSingleton(TimeOfDay);
    const todSeconds = timeOfDay ? timeOfDay.getTimeInSeconds() : 43200;
    const ambientLight = timeOfDay
      ? timeOfDay.getAmbientLight()
      : ([1, 1, 1] as const);

    // Render trees to offscreen texture (separate command encoder, like SurfaceRenderer).
    // This avoids interrupting the main render pass — expensive on tile-based GPUs.
    // GPU profiler timestamps are attached to this pass for free.
    this.rasterizer.renderToTexture(
      visibleCount,
      camMatrix.a,
      camMatrix.b,
      camMatrix.c,
      camMatrix.d,
      camMatrix.tx,
      camMatrix.ty,
      screenWidth,
      screenHeight,
      physicalWidth,
      physicalHeight,
      performance.now() / 1000,
      baseWindX,
      baseWindY,
      todSeconds,
      camera.z,
      ambientLight,
      gpuProfiler,
    );

    // Composite tree texture into the main render pass
    renderer.flush();
    const mainPass = renderer.getCurrentRenderPass();
    if (!mainPass) return;

    // Rebuild bind group if texture changed (e.g., resize)
    const textureView = this.rasterizer.getTextureView();
    if (textureView && textureView !== this.lastTextureView) {
      this.compositeBindGroup = this.compositeShader.createBindGroup({
        treeTexture: textureView,
      });
      this.lastTextureView = textureView;
    }

    if (this.compositeBindGroup) {
      this.compositeShader.render(mainPass, this.compositeBindGroup);
    }
  }
}
