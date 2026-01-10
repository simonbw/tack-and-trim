# Gameplan: GPU Water Readback for Physics

Use GPU-computed wave data for physics queries by reading back the wave texture to CPU. This eliminates duplicate Gerstner wave calculations and improves performance for physics-heavy scenes.

**Goals:**
- Read GPU wave computation results back to CPU for physics queries
- Provide seamless fallback to CPU calculation for out-of-viewport queries
- Track GPU vs CPU usage statistics for tuning
- Maintain time synchronization between GPU and CPU calculations

---

## Current Architecture

| Component | File | Purpose |
|-----------|------|---------|
| WaterInfo | `src/game/water/WaterInfo.ts` | Physics queries via `getStateAtPoint()`, CPU Gerstner calculation |
| WaveComputeGPU | `src/game/water/webgpu/WaveComputeGPU.ts` | GPU compute shader, has unused `readPixels()` methods |
| WaterComputePipelineGPU | `src/game/water/webgpu/WaterComputePipelineGPU.ts` | Orchestrates GPU compute + modifier texture |
| WaterRendererGPU | `src/game/water/webgpu/WaterRendererGPU.ts` | Kicks off compute in `onRender()` |

**Current flow:**
1. `WaterRendererGPU.onRender()` calls `computePipeline.update()`
2. GPU computes waves → texture (for rendering only)
3. Physics queries hit `WaterInfo.getStateAtPoint()` → recalculates on CPU

**Problem:** Gerstner wave math runs twice - once on GPU (rendering), once on CPU (physics).

---

## Proposed Architecture

### Data Flow

```
Frame N (tick phase):
  └── End of tick: Kick off GPU compute for viewport
        └── GPU computes waves → outputTexture
        └── Initiate async readback → stagingBuffer

Frame N+1 (tick phase):
  └── Start of tick: Complete readback, swap buffers
        └── readbackBuffer now contains Frame N data
        └── Store viewport bounds + time used for computation

  └── During tick: Physics queries via getStateAtPoint()
        ├── Point in viewport? → Sample from readbackBuffer (bilinear interpolation)
        └── Point outside viewport? → CPU fallback (using stored time)

Frame N+1 (render phase):
  └── GPU compute runs again for Frame N+1 viewport
  └── Rendering samples from GPU texture directly
```

### Double Buffering

Two CPU-side buffers to avoid blocking:
- **Buffer A**: Being read by physics this frame
- **Buffer B**: Being written by GPU readback (preparing for next frame)
- Swap at frame boundary

### File Organization

```
src/game/water/
├── WaterInfo.ts                    # MODIFY: Orchestrator, dispatches to GPU or CPU
├── WaterConstants.ts               # Existing: Shared constants
├── WaterModifier.ts                # Existing: Interface for wakes
│
├── cpu/
│   └── WaterComputeCPU.ts          # NEW: Extract CPU Gerstner logic from WaterInfo
│
└── webgpu/
    ├── WaveComputeGPU.ts           # MODIFY: Add readback scheduling
    ├── WaterShaderGPU.ts           # Existing: Render shader
    ├── WaterRendererGPU.ts         # MODIFY: Separate compute trigger from render
    ├── WaterComputePipelineGPU.ts  # MODIFY: Expose readback interface
    └── WaterReadbackBuffer.ts      # NEW: Manages double-buffered readback + sampling
```

---

## Implementation Phases

### Phase 1: Extract CPU Computation

Extract Gerstner wave calculation from `WaterInfo` into a dedicated module.

**Create `src/game/water/cpu/WaterComputeCPU.ts`**

```typescript
export interface WaveData {
  height: number;      // Surface displacement in ft
  dhdt: number;        // Rate of height change in ft/s
}

export interface WaterComputeParams {
  time: number;
  waveAmpModNoise: NoiseFunction3D;
  surfaceNoise: NoiseFunction3D;
}

/**
 * Pure CPU Gerstner wave computation.
 * Matches GPU shader output exactly.
 */
export function computeWaveDataAtPoint(
  x: number,
  y: number,
  params: WaterComputeParams
): WaveData {
  // Move getWaveDataAtPoint() logic here
  // Keep identical to GPU shader for consistency
}
```

**Modify `src/game/water/WaterInfo.ts`**
- Remove `getWaveDataAtPoint()` method
- Import and call `computeWaveDataAtPoint()` from WaterComputeCPU
- Keep current, velocity, and modifier logic in WaterInfo

### Phase 2: Create Readback Buffer Manager

**Create `src/game/water/webgpu/WaterReadbackBuffer.ts`**

```typescript
export interface ReadbackViewport {
  left: number;
  top: number;
  width: number;
  height: number;
  time: number;  // Time used for this computation
}

export interface ReadbackStats {
  gpuHits: number;
  cpuFallbacks: number;
  reset(): void;
}

/**
 * Manages async GPU readback with double buffering.
 */
export class WaterReadbackBuffer {
  private textureSize: number;

  // Double buffer
  private bufferA: Float32Array | null = null;
  private bufferB: Float32Array | null = null;
  private readBuffer: Float32Array | null = null;  // Points to A or B

  // Viewport for current read buffer
  private viewport: ReadbackViewport | null = null;

  // Pending readback promise
  private pendingReadback: Promise<void> | null = null;

  // Statistics
  readonly stats: ReadbackStats;

  constructor(textureSize: number);

  /**
   * Initiate async readback from GPU texture.
   * Call at end of tick after GPU compute is submitted.
   */
  initiateReadback(
    waveCompute: WaveComputeGPU,
    viewport: ReadbackViewport
  ): void;

  /**
   * Complete pending readback and swap buffers.
   * Call at start of next tick.
   * Returns false if readback not ready (shouldn't happen normally).
   */
  async completeReadback(): Promise<boolean>;

  /**
   * Sample wave data at world position.
   * Returns null if point is outside the computed viewport.
   */
  sampleAt(worldX: number, worldY: number): WaveData | null;

  /**
   * Get the time value used for the current buffer.
   * Use this for CPU fallback calculations to maintain consistency.
   */
  getComputedTime(): number | null;

  /**
   * Check if a point is within the computed viewport.
   */
  isInViewport(worldX: number, worldY: number): boolean;
}
```

**Sampling with bilinear interpolation:**

```typescript
sampleAt(worldX: number, worldY: number): WaveData | null {
  if (!this.readBuffer || !this.viewport) return null;

  const { left, top, width, height } = this.viewport;

  // Convert world coords to UV (0-1)
  const u = (worldX - left) / width;
  const v = (worldY - top) / height;

  // Check bounds
  if (u < 0 || u > 1 || v < 0 || v > 1) {
    this.stats.cpuFallbacks++;
    return null;
  }

  this.stats.gpuHits++;

  // Convert to texel coordinates
  const texX = u * (this.textureSize - 1);
  const texY = v * (this.textureSize - 1);

  // Bilinear interpolation
  const x0 = Math.floor(texX);
  const y0 = Math.floor(texY);
  const x1 = Math.min(x0 + 1, this.textureSize - 1);
  const y1 = Math.min(y0 + 1, this.textureSize - 1);
  const fx = texX - x0;
  const fy = texY - y0;

  // Sample 4 corners (RGBA16F: 4 floats per pixel)
  const s00 = this.sampleTexel(x0, y0);
  const s10 = this.sampleTexel(x1, y0);
  const s01 = this.sampleTexel(x0, y1);
  const s11 = this.sampleTexel(x1, y1);

  // Interpolate
  const h0 = s00.height * (1 - fx) + s10.height * fx;
  const h1 = s01.height * (1 - fx) + s11.height * fx;
  const height = h0 * (1 - fy) + h1 * fy;

  const d0 = s00.dhdt * (1 - fx) + s10.dhdt * fx;
  const d1 = s01.dhdt * (1 - fx) + s11.dhdt * fx;
  const dhdt = d0 * (1 - fy) + d1 * fy;

  // Denormalize (GPU stores as height/5.0 + 0.5)
  return {
    height: (height - 0.5) * 5.0,
    dhdt: (dhdt - 0.5) * 10.0,
  };
}
```

### Phase 3: Integrate Readback into Pipeline

**Modify `src/game/water/webgpu/WaterComputePipelineGPU.ts`**

Add readback buffer and methods:

```typescript
export class WaterComputePipelineGPU {
  private readbackBuffer: WaterReadbackBuffer;
  private lastComputeViewport: ReadbackViewport | null = null;

  // ... existing code ...

  /**
   * Run GPU compute and initiate readback.
   * Call at end of tick.
   */
  computeAndInitiateReadback(viewport: Viewport, time: number): void {
    // Run GPU compute
    this.waveCompute.compute(time, viewport.left, viewport.top, viewport.width, viewport.height);

    // Store viewport with time for readback
    this.lastComputeViewport = { ...viewport, time };

    // Initiate async readback
    this.readbackBuffer.initiateReadback(this.waveCompute, this.lastComputeViewport);
  }

  /**
   * Complete readback from previous frame.
   * Call at start of tick.
   */
  async completeReadback(): Promise<boolean> {
    return this.readbackBuffer.completeReadback();
  }

  /**
   * Get the readback buffer for sampling.
   */
  getReadbackBuffer(): WaterReadbackBuffer {
    return this.readbackBuffer;
  }
}
```

### Phase 4: Update WaterInfo to Use Readback

**Modify `src/game/water/WaterInfo.ts`**

```typescript
import { computeWaveDataAtPoint, WaterComputeParams } from "./cpu/WaterComputeCPU";
import type { WaterReadbackBuffer } from "./webgpu/WaterReadbackBuffer";

export class WaterInfo extends BaseEntity {
  // ... existing fields ...

  // Reference to readback buffer (set by WaterRendererGPU)
  private readbackBuffer: WaterReadbackBuffer | null = null;

  // Params for CPU fallback
  private cpuParams: WaterComputeParams;

  setReadbackBuffer(buffer: WaterReadbackBuffer): void {
    this.readbackBuffer = buffer;
  }

  getStateAtPoint(point: V2d): WaterState {
    const velocity = this.getCurrentVelocityAtPoint(point);

    // Try GPU readback first
    let waveData = this.readbackBuffer?.sampleAt(point[0], point[1]);

    if (!waveData) {
      // CPU fallback - use the same time as GPU computation for consistency
      const time = this.readbackBuffer?.getComputedTime()
        ?? this.game?.elapsedUnpausedTime
        ?? 0;

      waveData = computeWaveDataAtPoint(point[0], point[1], {
        ...this.cpuParams,
        time,
      });
    }

    let surfaceHeight = waveData.height;
    let surfaceHeightRate = waveData.dhdt;

    // Add modifier contributions (wakes)
    for (const modifier of this.spatialHash.queryPoint(point)) {
      const contrib = modifier.getWaterContribution(point);
      velocity.x += contrib.velocityX;
      velocity.y += contrib.velocityY;
      surfaceHeight += contrib.height;
      surfaceHeightRate += contrib.heightRate ?? 0;
    }

    return { velocity, surfaceHeight, surfaceHeightRate };
  }

  /**
   * Get readback statistics for debugging/tuning.
   */
  getReadbackStats(): { gpuHits: number; cpuFallbacks: number } | null {
    return this.readbackBuffer?.stats ?? null;
  }
}
```

### Phase 5: Update Tick/Render Timing

**Modify `src/game/water/webgpu/WaterRendererGPU.ts`**

Separate compute trigger from render:

```typescript
export class WaterRendererGPU extends BaseEntity {
  // ... existing code ...

  /**
   * Called at end of tick - kick off GPU compute for next frame's physics.
   */
  onAfterTick(): void {
    if (!this.initialized || !this.game) return;

    const viewport = this.getExpandedViewport();
    const time = this.game.elapsedUnpausedTime;

    // Run GPU compute and initiate readback
    this.computePipeline.computeAndInitiateReadback(viewport, time);
  }

  /**
   * Called at start of tick - complete readback from previous frame.
   */
  async onBeforeTick(): Promise<void> {
    if (!this.initialized) return;

    await this.computePipeline.completeReadback();
  }

  /**
   * Called during render - just render, compute already done.
   */
  onRender(): void {
    if (!this.game || !this.initialized || !this.waterShader) return;

    // Update modifier texture (wakes) - still needs to happen each frame
    const waterInfo = this.game.entities.getById("waterInfo") as WaterInfo | undefined;
    if (waterInfo) {
      this.computePipeline.updateModifierTexture(this.getExpandedViewport(), waterInfo);
    }

    // Render water using existing textures
    // ... existing render code ...
  }

  private getExpandedViewport(): Viewport {
    const camera = this.game!.camera;
    const worldViewport = camera.getWorldViewport();

    // Use larger margin for physics coverage
    const margin = 0.25; // 25% margin
    const marginX = worldViewport.width * margin;
    const marginY = worldViewport.height * margin;

    return {
      left: worldViewport.left - marginX,
      top: worldViewport.top - marginY,
      width: worldViewport.width + marginX * 2,
      height: worldViewport.height + marginY * 2,
    };
  }
}
```

**Note:** Need to add `onBeforeTick` and `onAfterTick` hooks to the entity lifecycle if they don't exist, or use existing mechanisms.

### Phase 6: Wire Up Components

**Modify initialization in `WaterRendererGPU.onAdd()`:**

```typescript
onAdd(): void {
  this.ensureInitialized().then(() => {
    // Connect readback buffer to WaterInfo
    const waterInfo = this.game?.entities.getById("waterInfo") as WaterInfo | undefined;
    if (waterInfo) {
      waterInfo.setReadbackBuffer(this.computePipeline.getReadbackBuffer());
    }
  });
}
```

---

## File Summary

### Create
| File | Purpose |
|------|---------|
| `src/game/water/cpu/WaterComputeCPU.ts` | Pure CPU Gerstner wave calculation |
| `src/game/water/webgpu/WaterReadbackBuffer.ts` | Double-buffered async readback + sampling |

### Modify
| File | Changes |
|------|---------|
| `src/game/water/WaterInfo.ts` | Use readback buffer, fallback to CPU, track stats |
| `src/game/water/webgpu/WaterComputePipelineGPU.ts` | Add readback buffer, separate compute from render |
| `src/game/water/webgpu/WaterRendererGPU.ts` | Trigger compute at end of tick, complete readback at start |
| `src/game/water/webgpu/WaveComputeGPU.ts` | Minor cleanup of readback methods |

---

## Verification

1. **Type check**: `npm run tsgo` - no errors
2. **Basic functionality**: Water renders correctly, boat physics work
3. **Readback stats**: Log GPU hits vs CPU fallbacks, should see >90% GPU hits during normal gameplay
4. **Time consistency**: No visual discontinuities between GPU-sampled and CPU-fallback regions
5. **Performance**: Profile to verify CPU Gerstner calculations reduced
6. **Edge cases**: Test with camera at world bounds, fast camera movement

---

## Debug Overlay

Add to DebugOverlay or create water-specific debug:

```typescript
// In some debug display
const stats = waterInfo.getReadbackStats();
if (stats) {
  const total = stats.gpuHits + stats.cpuFallbacks;
  const gpuPercent = total > 0 ? (stats.gpuHits / total * 100).toFixed(1) : 0;
  console.log(`Water queries: ${gpuPercent}% GPU (${stats.gpuHits}/${total})`);
  stats.reset();  // Reset each frame for per-frame stats
}
```

---

## Future Optimizations

1. **Adaptive viewport**: Expand viewport in direction of camera movement
2. **Physics-centered viewport**: Use boat position instead of camera center
3. **Partial readback**: Only read back a region around the boat, not full texture
4. **Async compute timing**: Use `device.queue.onSubmittedWorkDone()` for better timing
5. **Velocity in GPU**: Add wave orbital velocity to GPU output channels

---

## Risk Areas

1. **Async timing**: If readback isn't complete by next tick, need graceful fallback
2. **Float16 precision**: GPU uses rgba16float, readback needs proper handling
3. **Memory pressure**: Two 512x512 RGBA16F buffers = ~4MB
4. **Entity lifecycle**: Need to ensure proper init order (WaterInfo before WaterRendererGPU)
