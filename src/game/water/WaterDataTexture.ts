import { profiler } from "../../core/util/Profiler";
import { ModifierDataTexture } from "./ModifierDataTexture";
import { WATER_TEXTURE_SIZE } from "./WaterConstants";
import { WaterInfo } from "./WaterInfo";
import { WaveComputeShader } from "./WaveComputeShader";
import { WaveTexture } from "./WaveTexture";

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Creates and maintains a data texture containing water state information.
 *
 * Uses GPU-based wave computation via WaveComputeShader, then applies
 * water modifiers (wakes, etc.) sparsely on CPU for affected texels only.
 *
 * Each texel contains (packed as RGBA):
 * - R: surface height (0-1 maps to roughly ±2.5 units)
 * - G: velocity X (reserved, currently 0.5)
 * - B: velocity Y (reserved, currently 0.5)
 * - A: reserved (currently 1.0)
 */
export class WaterDataTexture {
  private gl: WebGL2RenderingContext | null = null;
  private waveComputeShader: WaveComputeShader | null = null;
  private waveTexture: WaveTexture | null = null;
  private modifierTexture: ModifierDataTexture | null = null;
  private savedViewport: [number, number, number, number] = [0, 0, 0, 0];

  constructor() {
    // Resources created in initGL
  }

  /** Initialize WebGL resources. Must be called with the GL context. */
  initGL(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.waveComputeShader = new WaveComputeShader(gl);
    this.waveTexture = new WaveTexture(
      gl,
      WATER_TEXTURE_SIZE,
      WATER_TEXTURE_SIZE,
    );
    this.modifierTexture = new ModifierDataTexture();
    this.modifierTexture.initGL(gl);
  }

  /**
   * Update the wave texture with current water state for the given viewport.
   * Uses GPU shader for wave computation, then applies modifiers sparsely.
   */
  update(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.gl || !this.waveComputeShader || !this.waveTexture) return;

    const gl = this.gl;
    const { left, top, width, height } = viewport;

    profiler.start("water-data-texture");

    // Save current viewport
    this.savedViewport[0] = gl.getParameter(gl.VIEWPORT)[0];
    this.savedViewport[1] = gl.getParameter(gl.VIEWPORT)[1];
    this.savedViewport[2] = gl.getParameter(gl.VIEWPORT)[2];
    this.savedViewport[3] = gl.getParameter(gl.VIEWPORT)[3];

    // Render waves to texture using GPU shader
    profiler.start("wave-gpu-compute");
    this.waveTexture.bind();

    // Get elapsed time from waterInfo's game reference
    const time = waterInfo["game"]?.elapsedUnpausedTime ?? 0;

    this.waveComputeShader.setTime(time);
    this.waveComputeShader.setViewportBounds(left, top, width, height);
    this.waveComputeShader.setTextureSize(
      WATER_TEXTURE_SIZE,
      WATER_TEXTURE_SIZE,
    );
    this.waveComputeShader.compute();

    this.waveTexture.unbind();
    profiler.end("wave-gpu-compute");

    // Restore viewport
    gl.viewport(
      this.savedViewport[0],
      this.savedViewport[1],
      this.savedViewport[2],
      this.savedViewport[3],
    );

    // Update modifier texture (wakes, etc.) on CPU
    if (this.modifierTexture) {
      this.modifierTexture.update(viewport, waterInfo);
    }

    profiler.end("water-data-texture");
  }

  getGLTexture(): WebGLTexture | null {
    return this.waveTexture?.getTexture() ?? null;
  }

  getModifierGLTexture(): WebGLTexture | null {
    return this.modifierTexture?.getTexture() ?? null;
  }

  getTextureSize(): number {
    return WATER_TEXTURE_SIZE;
  }

  getModifierTextureSize(): number {
    return this.modifierTexture?.getTextureSize() ?? 128;
  }

  destroy(): void {
    if (this.waveComputeShader) {
      this.waveComputeShader.destroy();
      this.waveComputeShader = null;
    }
    if (this.waveTexture) {
      this.waveTexture.destroy();
      this.waveTexture = null;
    }
    if (this.modifierTexture) {
      this.modifierTexture.destroy();
      this.modifierTexture = null;
    }
  }
}
