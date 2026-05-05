/**
 * Owns the screen-sized GPU textures used by the surface rendering pipeline.
 *
 * All surface textures are sized (screenWidth + 2*margin) × (screenHeight +
 * 2*margin) so that screen pixel (i, j) lines up with texel (i + margin,
 * j + margin) exactly. See SurfaceConstants.ts.
 *
 * Resolution scaling:
 *  • The base surface resolution is logical-pixel × the user's Render
 *    Resolution setting (`getRenderScaleFactor`).
 *  • Water height adds a further multiplier from `getWaterQualityScale`.
 *  • Modifier texture is half of the surface resolution (wakes are
 *    low-frequency).
 *  • Wind field is half of the surface resolution.
 *  • Boat air stays at logical resolution because the filter shader reads
 *    it via `textureLoad` at logical pixel coords.
 */

import { MAX_WAVE_SOURCES } from "../wave-physics/WavePhysicsManager";
import { SURFACE_TEXTURE_MARGIN } from "./SurfaceConstants";
import { getRenderScaleFactor } from "../../core/graphics/RenderScaleState";
import { getWaterQualityScale } from "./WaterQualityState";

// Modifier texture resolution scale (fraction of surface texture resolution)
const MODIFIER_RESOLUTION_SCALE = 1.0 / 2.0;

export interface SurfaceTextureSizes {
  /** Logical (CSS-pixel) coverage including margin. */
  texW: number;
  texH: number;
  /** Surface texture resolution after Render Resolution scale. */
  surfTexW: number;
  surfTexH: number;
  /** Water height texture resolution (surface × WaterQuality scale). */
  waterTexW: number;
  waterTexH: number;
  /** Wind field texture resolution (half of surface). */
  windTexW: number;
  windTexH: number;
}

/**
 * Compute the current surface texture sizes for the given screen size.
 * Pure function — does not touch GPU state.
 */
export function computeSurfaceTextureSizes(
  width: number,
  height: number,
): SurfaceTextureSizes {
  const texW = width + 2 * SURFACE_TEXTURE_MARGIN;
  const texH = height + 2 * SURFACE_TEXTURE_MARGIN;
  const surfScale = getRenderScaleFactor();
  const surfTexW = Math.max(1, Math.round(texW * surfScale));
  const surfTexH = Math.max(1, Math.round(texH * surfScale));
  const waterScale = getWaterQualityScale();
  const waterTexW = Math.max(1, Math.round(surfTexW * waterScale));
  const waterTexH = Math.max(1, Math.round(surfTexH * waterScale));
  const windTexW = Math.ceil(surfTexW / 2);
  const windTexH = Math.ceil(surfTexH / 2);
  return {
    texW,
    texH,
    surfTexW,
    surfTexH,
    waterTexW,
    waterTexH,
    windTexW,
    windTexH,
  };
}

/**
 * Owns the screen-sized GPU textures that the SurfaceRenderer pipeline reads
 * and writes. Recreates them whenever the screen size or quality settings
 * change.
 */
export class SurfaceTextures {
  private terrainHeightTexture: GPUTexture | null = null;
  private terrainHeightView_: GPUTextureView | null = null;
  private waterHeightTexture: GPUTexture | null = null;
  private waterHeightView_: GPUTextureView | null = null;
  private boatAirTexture_: GPUTexture | null = null;
  private boatAirTextureView_: GPUTextureView | null = null;
  private waveFieldTexture_: GPUTexture | null = null;
  private waveFieldTextureView_: GPUTextureView | null = null;
  private modifierTexture_: GPUTexture | null = null;
  private modifierTextureView_: GPUTextureView | null = null;
  private windFieldTexture: GPUTexture | null = null;
  private windFieldTextureView_: GPUTextureView | null = null;

  private lastTextureWidth = 0;
  private lastTextureHeight = 0;

  constructor(private readonly device: GPUDevice) {}

  /**
   * Force a rebuild on the next ensure() call. Used when the Render
   * Resolution or Water Quality setting changes — the screen size hasn't
   * moved but the texture resolution has.
   */
  invalidate(): void {
    this.lastTextureWidth = 0;
    this.lastTextureHeight = 0;
  }

  /**
   * Create or recreate textures to match the given screen size. Returns
   * `true` if textures were rebuilt (so callers can refresh dependent bind
   * groups), `false` if the existing textures were already the right size.
   */
  ensure(width: number, height: number): boolean {
    if (this.lastTextureWidth === width && this.lastTextureHeight === height) {
      return false;
    }

    const { texW, texH, surfTexW, surfTexH, waterTexW, waterTexH } =
      computeSurfaceTextureSizes(width, height);

    // Destroy old textures
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture_?.destroy();
    this.modifierTexture_?.destroy();
    this.boatAirTexture_?.destroy();
    this.windFieldTexture?.destroy();

    const device = this.device;

    // Terrain height texture (screen-space, sampled from tile atlas)
    this.terrainHeightTexture = device.createTexture({
      size: { width: surfTexW, height: surfTexH },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Height Texture",
    });
    this.terrainHeightView_ = this.terrainHeightTexture.createView();

    // Water height texture at reduced resolution. rgba16float packs 4
    // channels: R=height, G=turbulence, B=dh/dx, A=dh/dy. The gradient is
    // computed analytically inside calculateGerstnerWaves so the filter
    // shader can bilinear-sample a smooth normal field — no finite-diff
    // facets even at half-res. WaterQuality scales further on top of
    // surfScale.
    this.waterHeightTexture = device.createTexture({
      size: { width: waterTexW, height: waterTexH },
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Water Height Texture",
    });
    this.waterHeightView_ = this.waterHeightTexture.createView();

    // Boat air texture: per-pixel air gap published by BoatAirShader and
    // consumed by WaterFilterShader. R = bilge surface Z, G = deck cap Z,
    // B = bilge turbulence. Cleared each frame to a low sentinel. Kept at
    // logical (unscaled) resolution because the filter reads it with
    // textureLoad at logical pixel coords.
    this.boatAirTexture_ = device.createTexture({
      size: { width: texW, height: texH },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Boat Air Texture",
    });
    this.boatAirTextureView_ = this.boatAirTexture_.createView();

    // Wave field texture array (one layer per wave source)
    this.waveFieldTexture_ = device.createTexture({
      size: {
        width: surfTexW,
        height: surfTexH,
        depthOrArrayLayers: MAX_WAVE_SOURCES,
      },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Wave Field Texture",
    });
    this.waveFieldTextureView_ = this.waveFieldTexture_.createView({
      dimension: "2d-array",
      label: "Wave Field Texture View",
    });

    // Modifier texture at reduced resolution (wakes are low-frequency)
    const modW = Math.max(1, Math.round(surfTexW * MODIFIER_RESOLUTION_SCALE));
    const modH = Math.max(1, Math.round(surfTexH * MODIFIER_RESOLUTION_SCALE));
    this.modifierTexture_ = device.createTexture({
      size: { width: modW, height: modH },
      format: "rgba16float",
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: "Modifier Texture",
    });
    this.modifierTextureView_ = this.modifierTexture_.createView({
      label: "Modifier Texture View",
    });

    // Wind field texture at half-res (wind varies slowly enough that
    // half-resolution sampling is visually indistinguishable but cheaper).
    const windW = Math.ceil(surfTexW / 2);
    const windH = Math.ceil(surfTexH / 2);
    this.windFieldTexture = device.createTexture({
      size: { width: windW, height: windH },
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Wind Field Texture",
    });
    this.windFieldTextureView_ = this.windFieldTexture.createView({
      label: "Wind Field Texture View",
    });

    this.lastTextureWidth = width;
    this.lastTextureHeight = height;

    return true;
  }

  // Read-only accessors. Each is null until the first ensure() succeeds.

  get terrainHeightView(): GPUTextureView | null {
    return this.terrainHeightView_;
  }

  get waterHeightView(): GPUTextureView | null {
    return this.waterHeightView_;
  }

  get boatAirTexture(): GPUTexture | null {
    return this.boatAirTexture_;
  }

  get boatAirTextureView(): GPUTextureView | null {
    return this.boatAirTextureView_;
  }

  get waveFieldTexture(): GPUTexture | null {
    return this.waveFieldTexture_;
  }

  get waveFieldTextureView(): GPUTextureView | null {
    return this.waveFieldTextureView_;
  }

  get modifierTexture(): GPUTexture | null {
    return this.modifierTexture_;
  }

  get modifierTextureView(): GPUTextureView | null {
    return this.modifierTextureView_;
  }

  get windFieldTextureView(): GPUTextureView | null {
    return this.windFieldTextureView_;
  }

  destroy(): void {
    this.terrainHeightTexture?.destroy();
    this.waterHeightTexture?.destroy();
    this.waveFieldTexture_?.destroy();
    this.modifierTexture_?.destroy();
    this.boatAirTexture_?.destroy();
    this.windFieldTexture?.destroy();
  }
}
