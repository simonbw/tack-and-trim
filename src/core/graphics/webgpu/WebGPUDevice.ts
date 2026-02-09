/**
 * Singleton manager for WebGPU device initialization and access.
 * Provides app-wide access to the GPU adapter and device.
 */

import { setUniformDevice } from "../UniformStruct";

let instance: WebGPUDeviceManager | null = null;

export class WebGPUDeviceManager {
  private _adapter: GPUAdapter | null = null;
  private _device: GPUDevice | null = null;
  private _initialized = false;

  /** Preferred texture format for the current adapter */
  private _preferredFormat: GPUTextureFormat = "bgra8unorm";

  /** Feature support flags */
  private _features = {
    float32Filterable: false,
    timestampQuery: false,
    shaderF16: false,
  };

  private constructor() {}

  /** Get the singleton instance */
  static getInstance(): WebGPUDeviceManager {
    if (!instance) {
      instance = new WebGPUDeviceManager();
    }
    return instance;
  }

  /** Check if WebGPU is available in this browser */
  static isAvailable(): boolean {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  }

  /**
   * Initialize the WebGPU adapter and device.
   * Must be called before using any WebGPU features.
   * @throws Error if WebGPU is not available
   */
  async init(): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (!WebGPUDeviceManager.isAvailable()) {
      throw new Error(
        "WebGPU is not available in this browser. " +
          "Please use Chrome 113+, Edge 113+, or Firefox Nightly with WebGPU enabled.",
      );
    }

    // Request adapter with high-performance preference
    this._adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });

    if (!this._adapter) {
      throw new Error(
        "Failed to get WebGPU adapter. Your GPU may not support WebGPU.",
      );
    }

    // Check for optional features
    const wantedFeatures: GPUFeatureName[] = [];

    if (this._adapter.features.has("float32-filterable")) {
      wantedFeatures.push("float32-filterable");
      this._features.float32Filterable = true;
    }

    if (this._adapter.features.has("timestamp-query")) {
      wantedFeatures.push("timestamp-query");
      this._features.timestampQuery = true;
    }

    if (this._adapter.features.has("shader-f16")) {
      wantedFeatures.push("shader-f16");
      this._features.shaderF16 = true;
    }

    // Request device with optional features and higher limits
    this._device = await this._adapter.requestDevice({
      requiredFeatures: wantedFeatures,
      requiredLimits: {
        maxStorageBufferBindingSize:
          this._adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: this._adapter.limits.maxBufferSize,
      },
    });

    if (!this._device) {
      throw new Error("Failed to create WebGPU device.");
    }

    // Set up device lost handler
    this._device.lost.then((info) => {
      console.error(`WebGPU device lost: ${info.message}`);
      if (info.reason !== "destroyed") {
        // Attempt to reinitialize on unexpected loss
        this._initialized = false;
        this._device = null;
        this._adapter = null;
      }
    });

    // Get preferred canvas format
    this._preferredFormat = navigator.gpu.getPreferredCanvasFormat();

    // Initialize uniform struct system with device reference
    setUniformDevice(this._device);

    this._initialized = true;
  }

  /** Get the WebGPU adapter */
  get adapter(): GPUAdapter {
    if (!this._adapter) {
      throw new Error("WebGPU not initialized. Call init() first.");
    }
    return this._adapter;
  }

  /** Get the WebGPU device */
  get device(): GPUDevice {
    if (!this._device) {
      throw new Error("WebGPU not initialized. Call init() first.");
    }
    return this._device;
  }

  /** Get the preferred texture format for canvases */
  get preferredFormat(): GPUTextureFormat {
    return this._preferredFormat;
  }

  /** Check if the device has been initialized */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /** Get feature support info */
  get features(): Readonly<typeof this._features> {
    return this._features;
  }

  /** Get adapter limits */
  get limits(): GPUSupportedLimits | null {
    return this._adapter?.limits ?? null;
  }

  /**
   * Create a shader module from WGSL source.
   * @param code - WGSL shader source code
   * @param label - Optional debug label
   */
  createShaderModule(code: string, label?: string): GPUShaderModule {
    return this.device.createShaderModule({
      code,
      label,
    });
  }

  /**
   * Create a buffer with optional initial data.
   */
  createBuffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    return this.device.createBuffer(descriptor);
  }

  /**
   * Create a buffer initialized with data.
   */
  createBufferWithData(
    data: ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string,
  ): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage,
      label,
      mappedAtCreation: true,
    });

    const mappedRange = buffer.getMappedRange();
    if (data instanceof Float32Array) {
      new Float32Array(mappedRange).set(data);
    } else if (data instanceof Uint16Array) {
      new Uint16Array(mappedRange).set(data);
    } else if (data instanceof Uint32Array) {
      new Uint32Array(mappedRange).set(data);
    } else if (data instanceof Uint8Array) {
      new Uint8Array(mappedRange).set(data);
    } else {
      new Uint8Array(mappedRange).set(new Uint8Array(data.buffer));
    }
    buffer.unmap();

    return buffer;
  }

  /** Clean up resources */
  destroy(): void {
    if (this._device) {
      this._device.destroy();
      this._device = null;
    }
    this._adapter = null;
    this._initialized = false;
    instance = null;
  }
}

/** Convenience function to get the WebGPU device manager */
export function getWebGPU(): WebGPUDeviceManager {
  return WebGPUDeviceManager.getInstance();
}
