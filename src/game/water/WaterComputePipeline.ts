import { RenderTargetTexture } from "../../core/graphics/texture/RenderTargetTexture";
import { profiler } from "../../core/util/Profiler";
import { ModifierDataTexture } from "./ModifierDataTexture";
import { WATER_TEXTURE_SIZE } from "./WaterConstants";
import { WaterInfo } from "./WaterInfo";
import { WaveComputeShader } from "./WaveComputeShader";

export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Orchestrates the water computation pipeline each frame:
 * 1. GPU: Runs WaveComputeShader to compute Gerstner waves → WaveTexture
 * 2. CPU: Samples WaterModifiers (wakes) → ModifierDataTexture
 *
 * Produces two textures consumed by WaterShader for rendering.
 *
 * Note: Physics queries use WaterInfo which duplicates wave calculations
 * on the CPU. Future optimization could sample from GPU textures instead.
 */
export class WaterComputePipeline {
  private gl: WebGL2RenderingContext | null = null;
  private waveComputeShader: WaveComputeShader | null = null;
  private waveTexture: RenderTargetTexture | null = null;
  private modifierTexture: ModifierDataTexture | null = null;
  private savedViewport: [number, number, number, number] = [0, 0, 0, 0];

  /** Initialize WebGL resources. Must be called with the GL context. */
  initGL(gl: WebGL2RenderingContext): void {
    this.gl = gl;
    this.waveComputeShader = new WaveComputeShader(gl);
    // Wave texture: RGBA16F preferred for height precision (R=height, G=dh/dt)
    this.waveTexture = new RenderTargetTexture(
      gl,
      WATER_TEXTURE_SIZE,
      WATER_TEXTURE_SIZE,
      true
    );
    this.modifierTexture = new ModifierDataTexture();
    this.modifierTexture.initGL(gl);
  }

  /**
   * Update water textures with current state for the given viewport.
   * Runs GPU wave computation, then applies modifiers on CPU.
   */
  update(viewport: Viewport, waterInfo: WaterInfo): void {
    if (!this.gl || !this.waveComputeShader || !this.waveTexture) return;

    const gl = this.gl;
    const { left, top, width, height } = viewport;

    profiler.start("water-compute-pipeline");

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
      WATER_TEXTURE_SIZE
    );
    this.waveComputeShader.compute();

    this.waveTexture.unbind();
    profiler.end("wave-gpu-compute");

    // Restore viewport
    gl.viewport(
      this.savedViewport[0],
      this.savedViewport[1],
      this.savedViewport[2],
      this.savedViewport[3]
    );

    // Update modifier texture (wakes, etc.) on CPU
    if (this.modifierTexture) {
      this.modifierTexture.update(viewport, waterInfo);
    }

    profiler.end("water-compute-pipeline");
  }

  getWaveTexture(): WebGLTexture | null {
    return this.waveTexture?.getTexture() ?? null;
  }

  getModifierTexture(): WebGLTexture | null {
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
