/**
 * Wave Physics Manager
 *
 * Manages analytical wave physics computation:
 * - Computes terrain bounds for mesh building domain
 * - Coordinates worker-based wavefront mesh building
 * - Provides packed mesh data buffer for GPU shaders
 */

import type { WaveSource } from "../world/water/WaveSource";
import {
  buildPackedMeshBuffer,
  createPlaceholderPackedMeshBuffer,
} from "./MeshPacking";
import { WavefrontMesh } from "./WavefrontMesh";
import { WavefrontRasterizer } from "./WavefrontRasterizer";
import type {
  MeshBuilderType,
  WavefrontMeshData,
} from "../../pipeline/mesh-building/MeshBuildTypes";

/** Maximum number of wave sources for mesh computation */
export const MAX_WAVE_SOURCES = 8;

/**
 * Manages analytical wave physics for terrain-wave interaction.
 * Builds wavefront meshes for per-wave energy, direction, and phase correction.
 */
export class WavePhysicsManager {
  /** Wavefront meshes organized by builder type */
  private meshSets = new Map<MeshBuilderType, WavefrontMesh[]>();

  /** Currently selected builder type for rendering/queries */
  private activeBuilderType: MeshBuilderType = "marching";

  /** Packed mesh buffer for query shader lookup */
  private packedMeshBuffer: GPUBuffer | null = null;

  /** Rasterizer for rendering meshes to screen-space texture */
  private rasterizer: WavefrontRasterizer;

  /** Whether the manager has been initialized with terrain */
  private initialized = false;

  private device: GPUDevice;
  private waveSources: WaveSource[];

  /**
   * Create a WavePhysicsManager.
   * @param device - GPU device for creating GPU resources
   * @param waveSources - Wave source configurations
   */
  constructor(device: GPUDevice, waveSources: WaveSource[] = []) {
    this.device = device;
    this.waveSources = waveSources;
    this.rasterizer = new WavefrontRasterizer(this.device);
  }

  /**
   * Initialize the wave physics manager with prebuilt mesh data.
   *
   * @param prebuiltMeshData - Prebuilt mesh data from .wavemesh file (one per wave source)
   */
  async initialize(prebuiltMeshData?: WavefrontMeshData[]): Promise<void> {
    // Initialize rasterizer
    await this.rasterizer.init();

    if (prebuiltMeshData) {
      const meshes = prebuiltMeshData.map((data, i) =>
        WavefrontMesh.fromMeshData(
          data,
          this.waveSources[i],
          "marching",
          0,
          this.device,
        ),
      );
      this.meshSets.set("marching", meshes);
      console.log(
        `[WavePhysics] Loaded prebuilt mesh data (${meshes.length} meshes)`,
      );
    } else {
      console.warn(
        "[WavePhysics] No prebuilt mesh data provided — wave physics will be inactive",
      );
    }

    // Build packed mesh buffer for query shader
    this.rebuildPackedMeshBuffer();

    this.initialized = true;
  }

  /**
   * Check if the manager is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get meshes for a specific builder type, or the first available type.
   */
  getMeshes(builderType?: MeshBuilderType): readonly WavefrontMesh[] {
    if (builderType) {
      return this.meshSets.get(builderType) ?? [];
    }
    // Return first available
    for (const meshes of this.meshSets.values()) {
      if (meshes.length > 0) return meshes;
    }
    return [];
  }

  /**
   * Get all mesh sets organized by builder type.
   */
  getMeshSets(): ReadonlyMap<MeshBuilderType, WavefrontMesh[]> {
    return this.meshSets;
  }

  /**
   * Get list of builder types that have meshes.
   */
  getActiveBuilderTypes(): MeshBuilderType[] {
    return [...this.meshSets.keys()].filter(
      (type) => (this.meshSets.get(type)?.length ?? 0) > 0,
    );
  }

  /**
   * Get wavefront mesh for a specific wave source index.
   */
  getMeshForWave(
    index: number,
    builderType?: MeshBuilderType,
  ): WavefrontMesh | undefined {
    return this.getMeshes(builderType)[index];
  }

  /**
   * Get the packed mesh buffer for query shader binding.
   */
  getPackedMeshBuffer(): GPUBuffer | null {
    return this.packedMeshBuffer;
  }

  /**
   * Get the rasterizer for rendering meshes to screen-space texture.
   */
  getRasterizer(): WavefrontRasterizer {
    return this.rasterizer;
  }

  /**
   * Get the currently active builder type.
   */
  getActiveBuilderType(): MeshBuilderType {
    return this.activeBuilderType;
  }

  /**
   * Set the active builder type and rebuild packed mesh buffer.
   */
  setActiveBuilderType(type: MeshBuilderType): void {
    if (this.activeBuilderType === type) return;
    this.activeBuilderType = type;
    this.rebuildPackedMeshBuffer();
  }

  /**
   * Get meshes for the currently active builder type.
   */
  getActiveMeshes(): readonly WavefrontMesh[] {
    return this.getMeshes(this.activeBuilderType);
  }

  /**
   * Rebuild the packed mesh buffer from the active builder type's meshes.
   */
  private rebuildPackedMeshBuffer(): void {
    this.packedMeshBuffer?.destroy();
    const meshes = this.getActiveMeshes();
    if (meshes.length > 0) {
      this.packedMeshBuffer = buildPackedMeshBuffer(this.device, meshes);
    } else {
      this.packedMeshBuffer = createPlaceholderPackedMeshBuffer(this.device);
    }
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.destroyResources();
    this.rasterizer.destroy();
  }

  private destroyResources(): void {
    this.packedMeshBuffer?.destroy();
    this.packedMeshBuffer = null;
    for (const meshes of this.meshSets.values()) {
      for (const mesh of meshes) {
        mesh.destroy();
      }
    }
    this.meshSets = new Map();
    this.initialized = false;
  }
}
