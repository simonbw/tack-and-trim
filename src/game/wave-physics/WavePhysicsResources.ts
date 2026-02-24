/**
 * Wave Physics Resources
 *
 * Singleton entity that owns and manages the WavePhysicsManager for analytical
 * wave-terrain interaction via wavefront meshes.
 *
 * Responsibilities:
 * - Initialize WavePhysicsManager with terrain data
 * - Provide access to packed mesh buffer for GPU shaders
 */

import { BaseEntity } from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type {
  MeshBuilderType,
  WavefrontMeshData,
} from "../../pipeline/mesh-building/MeshBuildTypes";
import { DEFAULT_WAVE_CONFIG, WaveConfig } from "../world/water/WaveSource";
import { WavePhysicsManager } from "./WavePhysicsManager";
import type { WavefrontMesh } from "./WavefrontMesh";
import type { WavefrontRasterizer } from "./WavefrontRasterizer";

/**
 * Viewport bounds for rendering.
 */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Singleton entity that owns and manages WavePhysicsManager.
 */
export class WavePhysicsResources extends BaseEntity {
  id = "wavePhysicsResources";

  private waveConfig: WaveConfig;
  private prebuiltMeshData: WavefrontMeshData[] | undefined;
  private wavePhysicsManager: WavePhysicsManager | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(waveConfig?: WaveConfig, prebuiltMeshData?: WavefrontMeshData[]) {
    super();
    this.waveConfig = waveConfig ?? DEFAULT_WAVE_CONFIG;
    this.prebuiltMeshData = prebuiltMeshData;
  }

  @on("afterAdded")
  onAfterAdded() {
    const device = this.game.getWebGPUDevice();
    this.wavePhysicsManager = new WavePhysicsManager(
      device,
      this.waveConfig.sources,
    );

    this.initPromise = this.wavePhysicsManager.initialize(
      this.prebuiltMeshData,
    );
  }

  /**
   * Returns a promise that resolves when wave mesh building is complete.
   */
  whenReady(): Promise<void> {
    return this.initPromise ?? Promise.resolve();
  }

  /**
   * Get the WavePhysicsManager instance.
   */
  getWavePhysicsManager(): WavePhysicsManager | null {
    return this.wavePhysicsManager;
  }

  /**
   * Get the packed mesh buffer for binding in query shaders.
   */
  getPackedMeshBuffer(): GPUBuffer | null {
    return this.wavePhysicsManager?.getPackedMeshBuffer() ?? null;
  }

  /**
   * Get the rasterizer for rendering meshes to screen-space texture.
   */
  getRasterizer(): WavefrontRasterizer | null {
    return this.wavePhysicsManager?.getRasterizer() ?? null;
  }

  /**
   * Get the active meshes (for the currently selected builder type).
   */
  getActiveMeshes(): readonly WavefrontMesh[] {
    return this.wavePhysicsManager?.getActiveMeshes() ?? [];
  }

  /**
   * Get the currently active builder type.
   */
  getActiveBuilderType(): MeshBuilderType {
    return this.wavePhysicsManager?.getActiveBuilderType() ?? "marching";
  }

  /**
   * Switch the active builder type and rebuild resources.
   */
  switchBuilderType(type: MeshBuilderType): void {
    this.wavePhysicsManager?.setActiveBuilderType(type);
  }

  /**
   * Check if wave physics is initialized and ready.
   */
  isInitialized(): boolean {
    return this.wavePhysicsManager?.isInitialized() ?? false;
  }

  @on("destroy")
  onDestroy(): void {
    this.wavePhysicsManager?.destroy();
  }
}
