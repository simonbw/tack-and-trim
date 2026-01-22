/**
 * GPU orchestration for swell propagation computation.
 *
 * Processes ALL 32 direction/wavelength combinations in a single 3D dispatch.
 * This is much faster than the previous approach of 32 separate dispatches.
 *
 * Buffer layout: [cellsX × cellsY × 32] where Z encodes:
 * - sliceIndex 0-15: long swell (directions 0-15)
 * - sliceIndex 16-31: short chop (directions 0-15)
 *
 * Usage:
 * ```typescript
 * const compute = new SwellPropagationCompute();
 * await compute.init(gridConfig, waterMask);
 * await compute.computeAll(longConfig, shortConfig, 200);
 * const { energy, arrivalDirection } = await compute.readback();
 * compute.destroy();
 * ```
 */

import { getWebGPU } from "../../../../../core/graphics/webgpu/WebGPUDevice";
import type { PropagationConfig } from "../../PropagationConfig";
import {
  SwellPropagationShader,
  PARAMS_BUFFER_SIZE,
} from "./SwellPropagationShader";

/**
 * Serializable grid configuration (no class instances).
 */
export interface GPUGridConfig {
  cellsX: number;
  cellsY: number;
  directionCount: number;
}

/**
 * Result from readback after computing all directions.
 * Arrays are sized [cellCount * 32] for all 32 slices.
 */
export interface PropagationReadbackResult {
  energy: Float32Array;
  arrivalDirection: Float32Array;
}

/** Total number of slices: 16 directions × 2 wavelength types */
const TOTAL_SLICES = 32;

/**
 * Timing data from GPU swell computation.
 */
export interface GPUSwellTiming {
  setupMs: number;
  initPassMs: number;
  encodeIterationsMs: number;
  submitMs: number;
  gpuWaitMs: number;
  readbackCopyMs: number;
  readbackMapMs: number;
  readbackReadMs: number;
  totalComputeMs: number;
  totalReadbackMs: number;
}

/**
 * GPU-based swell propagation computation.
 *
 * Computes energy propagation for all directions and wavelength types
 * simultaneously using WebGPU compute shaders with 3D dispatch.
 *
 * Key optimization: single dispatch processes all 32 slices in parallel,
 * reducing GPU overhead from ~6400 dispatches to ~200 dispatches.
 */
export class SwellPropagationCompute {
  private shader: SwellPropagationShader | null = null;

  // Grid dimensions
  private cellsX = 0;
  private cellsY = 0;
  private cellCount = 0;
  private directionCount = 16;

  // Whether using f16 for energy storage (halves memory bandwidth)
  private useF16 = false;

  // GPU buffers (sized for all 32 slices)
  private paramsBuffer: GPUBuffer | null = null;
  private waterMaskBuffer: GPUBuffer | null = null;
  private energyBufferA: GPUBuffer | null = null; // Ping buffer
  private energyBufferB: GPUBuffer | null = null; // Pong buffer
  private arrivalDirBuffer: GPUBuffer | null = null;
  private readbackEnergyBuffer: GPUBuffer | null = null;
  private readbackArrivalBuffer: GPUBuffer | null = null;

  // Bind groups for ping-pong
  private bindGroupAtoB: GPUBindGroup | null = null;
  private bindGroupBtoA: GPUBindGroup | null = null;

  // Track which buffer has final result
  private lastResultInBufferA = true;

  private initialized = false;

  /**
   * Initialize the compute system with grid configuration and water mask.
   *
   * @param gridConfig - Grid dimensions including directionCount
   * @param waterMask - Uint8Array where 0=land, 1=water
   */
  async init(gridConfig: GPUGridConfig, waterMask: Uint8Array): Promise<void> {
    if (this.initialized) {
      this.destroy();
    }

    const webgpu = getWebGPU();
    const device = webgpu.device;

    this.cellsX = gridConfig.cellsX;
    this.cellsY = gridConfig.cellsY;
    this.cellCount = this.cellsX * this.cellsY;
    this.directionCount = gridConfig.directionCount;

    // Initialize shader (shader checks f16 support internally)
    this.shader = new SwellPropagationShader();
    this.useF16 = this.shader.useF16;
    await this.shader.init();

    console.log(
      `[SwellPropagationCompute] Using ${this.useF16 ? "f16" : "f32"} for energy storage`,
    );

    // Create params buffer (uniform)
    this.paramsBuffer = device.createBuffer({
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Swell Propagation Params",
    });

    // Create water mask buffer (storage, read-only) - use u32 for alignment
    const waterMaskU32 = new Uint32Array(this.cellCount);
    for (let i = 0; i < this.cellCount; i++) {
      waterMaskU32[i] = waterMask[i];
    }
    this.waterMaskBuffer = webgpu.createBufferWithData(
      waterMaskU32,
      GPUBufferUsage.STORAGE,
      "Swell Water Mask",
    );

    // Create energy ping-pong buffers (storage) - sized for ALL 32 slices
    // f16 uses 2 bytes per element, f32 uses 4 bytes
    const bytesPerElement = this.useF16 ? 2 : 4;
    const energyBufferSize = this.cellCount * TOTAL_SLICES * bytesPerElement;
    this.energyBufferA = device.createBuffer({
      size: energyBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      label: `Swell Energy A (32 slices, ${this.useF16 ? "f16" : "f32"})`,
    });
    this.energyBufferB = device.createBuffer({
      size: energyBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      label: `Swell Energy B (32 slices, ${this.useF16 ? "f16" : "f32"})`,
    });

    // Create arrival direction buffer (storage) - sized for ALL 32 slices
    // Arrival direction is always f32 for precision
    const arrivalBufferSize = this.cellCount * TOTAL_SLICES * 4; // Always f32
    this.arrivalDirBuffer = device.createBuffer({
      size: arrivalBufferSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      label: "Swell Arrival Direction (32 slices)",
    });

    // Create readback buffers for GPU->CPU transfer
    this.readbackEnergyBuffer = device.createBuffer({
      size: energyBufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: `Swell Energy Readback (${this.useF16 ? "f16" : "f32"})`,
    });
    this.readbackArrivalBuffer = device.createBuffer({
      size: arrivalBufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Swell Arrival Readback",
    });

    // Create bind groups for both ping-pong directions
    // A->B: read from A, write to B
    this.bindGroupAtoB = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      waterMask: { buffer: this.waterMaskBuffer },
      energyIn: { buffer: this.energyBufferA },
      energyOut: { buffer: this.energyBufferB },
      arrivalDirOut: { buffer: this.arrivalDirBuffer },
    });

    // B->A: read from B, write to A
    this.bindGroupBtoA = this.shader.createBindGroup({
      params: { buffer: this.paramsBuffer },
      waterMask: { buffer: this.waterMaskBuffer },
      energyIn: { buffer: this.energyBufferB },
      energyOut: { buffer: this.energyBufferA },
      arrivalDirOut: { buffer: this.arrivalDirBuffer },
    });

    this.initialized = true;
  }

  // Store timing data for external access
  private lastTiming: GPUSwellTiming | null = null;

  /**
   * Compute propagation for ALL directions and wavelength types.
   *
   * Runs init pass then fixed iterations for all 32 slices simultaneously.
   * Does not readback - call readback() separately after this completes.
   *
   * @param longConfig - Configuration for long swell wavelengths
   * @param shortConfig - Configuration for short chop wavelengths
   * @param maxIterations - Number of propagation iterations
   */
  async computeAll(
    longConfig: PropagationConfig,
    shortConfig: PropagationConfig,
    maxIterations: number,
  ): Promise<void> {
    if (!this.initialized || !this.shader || !this.paramsBuffer) {
      throw new Error("SwellPropagationCompute not initialized");
    }

    const timing: GPUSwellTiming = {
      setupMs: 0,
      initPassMs: 0,
      encodeIterationsMs: 0,
      submitMs: 0,
      gpuWaitMs: 0,
      readbackCopyMs: 0,
      readbackMapMs: 0,
      readbackReadMs: 0,
      totalComputeMs: 0,
      totalReadbackMs: 0,
    };
    const computeStart = performance.now();

    let t0 = performance.now();
    const device = getWebGPU().device;
    const workgroupsX = Math.ceil(this.cellsX / 8);
    const workgroupsY = Math.ceil(this.cellsY / 8);
    const workgroupsZ = TOTAL_SLICES; // 32 slices, 1 per workgroup in Z

    // Create params data buffer (12 values = 48 bytes)
    const paramsData = new ArrayBuffer(PARAMS_BUFFER_SIZE);
    const paramsView = new DataView(paramsData);
    timing.setupMs = performance.now() - t0;

    // === INIT PASS ===
    t0 = performance.now();
    // Write params for init pass and submit separately
    this.writeParams(paramsView, longConfig, shortConfig, true);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    {
      const initEncoder = device.createCommandEncoder({
        label: "Swell Init Pass",
      });
      const pass = initEncoder.beginComputePass({ label: "Swell Init Pass" });
      pass.setPipeline(this.shader.getPipeline());
      pass.setBindGroup(0, this.bindGroupBtoA!);
      pass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
      pass.end();
      device.queue.submit([initEncoder.finish()]);
    }
    timing.initPassMs = performance.now() - t0;

    // === ITERATION PASSES ===
    t0 = performance.now();
    // Update params for iteration passes (isInitPass = 0)
    this.writeParams(paramsView, longConfig, shortConfig, false);
    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);

    // Create command encoder for iteration passes
    const iterEncoder = device.createCommandEncoder({
      label: "Swell Iteration Passes",
    });

    // Run iteration passes with ping-pong
    // Start reading from A (just initialized), writing to B
    let readFromA = true;
    for (let i = 0; i < maxIterations; i++) {
      const pass = iterEncoder.beginComputePass({
        label: `Swell Iteration ${i}`,
      });
      pass.setPipeline(this.shader.getPipeline());
      pass.setBindGroup(
        0,
        readFromA ? this.bindGroupAtoB! : this.bindGroupBtoA!,
      );
      pass.dispatchWorkgroups(workgroupsX, workgroupsY, workgroupsZ);
      pass.end();

      readFromA = !readFromA;
    }
    timing.encodeIterationsMs = performance.now() - t0;

    // Submit iteration work
    t0 = performance.now();
    device.queue.submit([iterEncoder.finish()]);
    timing.submitMs = performance.now() - t0;

    // Note: We don't call onSubmittedWorkDone() here - mapAsync in readback()
    // will wait for GPU completion anyway. Benchmarking showed this is redundant.
    timing.gpuWaitMs = 0;

    // Track which buffer has the final result
    // After the loop, readFromA has been flipped one extra time.
    // The last iteration wrote to A if readFromA was false (used BtoA),
    // or to B if readFromA was true (used AtoB).
    // Since we flip AFTER each iteration, the current readFromA tells us
    // where the result is: true means last write was to A, false means B.
    this.lastResultInBufferA = readFromA;

    timing.totalComputeMs = performance.now() - computeStart;
    this.lastTiming = timing;
  }

  /**
   * Write params to the DataView buffer.
   */
  private writeParams(
    view: DataView,
    longConfig: PropagationConfig,
    shortConfig: PropagationConfig,
    isInitPass: boolean,
  ): void {
    let offset = 0;

    // Grid config
    view.setUint32(offset, this.cellsX, true);
    offset += 4;
    view.setUint32(offset, this.cellsY, true);
    offset += 4;
    view.setUint32(offset, this.directionCount, true);
    offset += 4;
    view.setUint32(offset, isInitPass ? 1 : 0, true);
    offset += 4;

    // Long swell config
    view.setFloat32(offset, longConfig.directFlowFactor, true);
    offset += 4;
    view.setFloat32(offset, longConfig.lateralSpreadFactor, true);
    offset += 4;
    view.setFloat32(offset, longConfig.decayFactor, true);
    offset += 4;
    view.setUint32(offset, 0, true); // padding
    offset += 4;

    // Short chop config
    view.setFloat32(offset, shortConfig.directFlowFactor, true);
    offset += 4;
    view.setFloat32(offset, shortConfig.lateralSpreadFactor, true);
    offset += 4;
    view.setFloat32(offset, shortConfig.decayFactor, true);
    offset += 4;
    view.setUint32(offset, 0, true); // padding
    offset += 4;

    // Precomputed direction cosines (16 directions)
    for (let dir = 0; dir < 16; dir++) {
      const angle = (dir / 16) * Math.PI * 2;
      view.setFloat32(offset, Math.cos(angle), true);
      offset += 4;
    }

    // Precomputed direction sines (16 directions)
    for (let dir = 0; dir < 16; dir++) {
      const angle = (dir / 16) * Math.PI * 2;
      view.setFloat32(offset, Math.sin(angle), true);
      offset += 4;
    }
  }

  /**
   * Read back the results from GPU to CPU.
   *
   * Returns energy and arrival direction for all 32 slices.
   * Layout: [slice0_cell0, slice0_cell1, ..., slice0_cellN, slice1_cell0, ...]
   *
   * @returns Energy and arrival direction arrays (each cellCount * 32 floats)
   */
  async readback(): Promise<PropagationReadbackResult> {
    if (
      !this.initialized ||
      !this.readbackEnergyBuffer ||
      !this.readbackArrivalBuffer
    ) {
      throw new Error("SwellPropagationCompute not initialized");
    }

    const readbackStart = performance.now();
    const device = getWebGPU().device;

    // Calculate buffer sizes (energy may be f16 or f32, arrival is always f32)
    const energyBytesPerElement = this.useF16 ? 2 : 4;
    const energyBufferSize =
      this.cellCount * TOTAL_SLICES * energyBytesPerElement;
    const arrivalBufferSize = this.cellCount * TOTAL_SLICES * 4; // Always f32

    // Copy final energy buffer to readback buffer
    let t0 = performance.now();
    const sourceBuffer = this.lastResultInBufferA
      ? this.energyBufferA!
      : this.energyBufferB!;

    const encoder = device.createCommandEncoder({
      label: "Swell Readback Copy",
    });
    encoder.copyBufferToBuffer(
      sourceBuffer,
      0,
      this.readbackEnergyBuffer,
      0,
      energyBufferSize,
    );
    encoder.copyBufferToBuffer(
      this.arrivalDirBuffer!,
      0,
      this.readbackArrivalBuffer,
      0,
      arrivalBufferSize,
    );
    device.queue.submit([encoder.finish()]);
    if (this.lastTiming) {
      this.lastTiming.readbackCopyMs = performance.now() - t0;
    }

    // Map both buffers in parallel
    t0 = performance.now();
    await Promise.all([
      this.readbackEnergyBuffer.mapAsync(GPUMapMode.READ),
      this.readbackArrivalBuffer.mapAsync(GPUMapMode.READ),
    ]);
    if (this.lastTiming) {
      this.lastTiming.readbackMapMs = performance.now() - t0;
    }

    // Read data from mapped buffers
    t0 = performance.now();
    let energyData: Float32Array;
    if (this.useF16) {
      // Read as Float16Array then convert to Float32Array
      // Float16Array is available in browsers that support shader-f16
      const f16Data = new Float16Array(
        this.readbackEnergyBuffer.getMappedRange().slice(0),
      );
      energyData = Float32Array.from(f16Data);
    } else {
      energyData = new Float32Array(
        this.readbackEnergyBuffer.getMappedRange().slice(0),
      );
    }
    this.readbackEnergyBuffer.unmap();

    const arrivalData = new Float32Array(
      this.readbackArrivalBuffer.getMappedRange().slice(0),
    );
    this.readbackArrivalBuffer.unmap();

    if (this.lastTiming) {
      this.lastTiming.readbackReadMs = performance.now() - t0;
      this.lastTiming.totalReadbackMs = performance.now() - readbackStart;
    }

    return {
      energy: energyData,
      arrivalDirection: arrivalData,
    };
  }

  /**
   * Get timing data from the last compute/readback operation.
   * Returns null if no operation has been performed yet.
   */
  getTiming(): GPUSwellTiming | null {
    return this.lastTiming;
  }

  /**
   * Check if the compute system is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the cell count for buffer sizing calculations.
   */
  getCellCount(): number {
    return this.cellCount;
  }

  /**
   * Clean up GPU resources.
   */
  destroy(): void {
    this.paramsBuffer?.destroy();
    this.waterMaskBuffer?.destroy();
    this.energyBufferA?.destroy();
    this.energyBufferB?.destroy();
    this.arrivalDirBuffer?.destroy();
    this.readbackEnergyBuffer?.destroy();
    this.readbackArrivalBuffer?.destroy();

    this.shader?.destroy();

    this.paramsBuffer = null;
    this.waterMaskBuffer = null;
    this.energyBufferA = null;
    this.energyBufferB = null;
    this.arrivalDirBuffer = null;
    this.readbackEnergyBuffer = null;
    this.readbackArrivalBuffer = null;
    this.bindGroupAtoB = null;
    this.bindGroupBtoA = null;
    this.shader = null;
    this.initialized = false;
  }
}
