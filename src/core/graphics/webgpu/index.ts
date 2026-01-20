/**
 * WebGPU Graphics Module
 *
 * Provides WebGPU-based rendering infrastructure including:
 * - Device management (WebGPUDevice)
 * - Texture management (WebGPUTextureManager)
 * - 2D batched renderer (WebGPURenderer)
 * - Fullscreen effects (WebGPUFullscreenQuad, WebGPURenderTarget)
 */

export { WebGPUDeviceManager, getWebGPU } from "./WebGPUDevice";

export {
  WebGPUTextureManager,
  type WebGPUTexture,
  type TextureOptions,
} from "./WebGPUTextureManager";

export { WebGPURenderer, type SpriteOptions } from "./WebGPURenderer";

export { WebGPUFullscreenQuad } from "./WebGPUFullscreenQuad";

export {
  WebGPURenderTarget,
  type RenderTargetOptions,
} from "./WebGPURenderTarget";
