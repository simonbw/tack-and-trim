# Terrain System Implementation Gameplan

## Current State

The codebase has two established spatial data systems that serve as templates:

### Wind System (`src/game/wind/`)
- `WindInfo.ts` - Orchestrator entity with hybrid GPU/CPU queries
- `WindConstants.ts` - Shared constants for TypeScript + WGSL
- `webgpu/WindStateCompute.ts` - Compute shader wrapper (shared pipeline)
- `webgpu/WindTileCompute.ts` - Per-tile compute implementation
- Uses `rg32float` texture format for velocity (x, y)

### Water System (`src/game/water/`)
- `WaterInfo.ts` - Orchestrator with spatial hash for modifiers
- `WaterConstants.ts` - Wave definitions and constants
- `webgpu/WaterStateCompute.ts` - Compute shader wrapper
- `webgpu/WaterDataTileCompute.ts` - Per-tile compute
- `webgpu/WaterComputeBuffers.ts` - Shared GPU buffers
- `cpu/WaterComputeCPU.ts` - CPU fallback
- `rendering/WaterShader.ts` - Fragment shader for rendering
- `rendering/WaterRenderPipeline.ts` - Render texture compute
- Uses `rgba32float` texture format for (height, dhdt, velX, velY)

### Data Tile Infrastructure (`src/game/datatiles/`)
- `DataTileComputePipeline.ts` - Generic GPU tile pipeline
- `DataTileManager.ts` - Tile scoring and selection
- `DataTileReadbackBuffer.ts` - Async GPU→CPU transfer
- `DataTileTypes.ts` - Shared interfaces (`DataTileGridConfig`, `QueryForecast`, etc.)

### Boat Components (`src/game/boat/`)
- `Boat.ts` - Composes hull, keel, rudder, rig, etc. via `addChild()`
- `Hull.ts` - Main physics body, applies skin friction
- `Keel.ts` - Underwater foil, applies lift/drag forces
- `Rudder.ts` - Steerable foil, has position and length
- `BoatConfig.ts` - Configuration interfaces (no draft values currently)

## Desired Changes

Implement a terrain system that:

1. **Defines landmasses** using Catmull-Rom splines with smooth height profiles
2. **Computes terrain height** via GPU (data tiles) with CPU fallback
3. **Integrates with water rendering** - depth-based sand/water blending
4. **Provides physics interaction** - soft grounding friction when boat components touch bottom

The system should follow the established Wind/Water architecture patterns exactly.

## Files to Modify

### Existing Files

- `src/game/datatiles/DataTileTypes.ts` - Add `TerrainQuerier` interface
- `src/game/water/rendering/WaterShader.ts` - Add terrain texture input, depth-based rendering
- `src/game/water/rendering/WaterRenderPipeline.ts` - Coordinate terrain + water compute
- `src/game/water/rendering/WaterRenderer.ts` - Pass terrain texture to shader
- `src/game/boat/BoatConfig.ts` - Add draft values to configs
- `src/game/boat/configs/StarterDinghy.ts` - Add draft values
- `src/game/boat/Boat.ts` - Add BoatGrounding child entity

### New Files to Create

```
src/game/terrain/
├── TerrainInfo.ts              # Main orchestrator entity
├── TerrainConstants.ts         # Constants for TS + WGSL
├── LandMass.ts                 # Land mass data structures
│
├── webgpu/
│   ├── TerrainStateCompute.ts  # Compute shader wrapper
│   ├── TerrainDataTileCompute.ts # Per-tile compute
│   └── TerrainComputeBuffers.ts  # Shared GPU buffers
│
├── cpu/
│   └── TerrainComputeCPU.ts    # CPU fallback
│
└── rendering/
    └── TerrainRenderPipeline.ts # Render texture compute

src/game/boat/
└── BoatGrounding.ts            # Grounding physics entity
```

## Detailed File Specifications

### 1. `src/game/terrain/TerrainConstants.ts`

```typescript
// Tile configuration (match water/wind)
export const TERRAIN_TILE_SIZE = 64;         // ft per tile
export const TERRAIN_TILE_RESOLUTION = 128;  // pixels per tile
export const TERRAIN_TEXTURE_SIZE = 512;     // For rendering

// Height normalization
export const MAX_TERRAIN_HEIGHT = 20;        // ft (for GPU normalization)

// Catmull-Rom subdivision
export const SPLINE_SUBDIVISIONS = 16;       // Segments per control point pair

// Default land mass parameters
export const DEFAULT_PEAK_HEIGHT = 5;        // ft
export const DEFAULT_BEACH_WIDTH = 20;       // ft
export const DEFAULT_HILL_FREQUENCY = 0.02;  // noise spatial scale
export const DEFAULT_HILL_AMPLITUDE = 0.3;   // fraction of peak height

// WGSL constants snippet
export const TERRAIN_CONSTANTS_WGSL = /*wgsl*/ `
const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT}.0;
const SPLINE_SUBDIVISIONS: u32 = ${SPLINE_SUBDIVISIONS}u;
`;
```

### 2. `src/game/terrain/LandMass.ts`

```typescript
import { V2d } from "../../core/Vector";

export interface LandMass {
  /** Catmull-Rom control points defining coastline (closed loop) */
  controlPoints: V2d[];

  /** Height profile */
  peakHeight: number;      // Max height above water (ft)
  beachWidth: number;      // Distance from shore where terrain rises (ft)

  /** Rolling hills parameters */
  hillFrequency: number;   // Noise spatial scale
  hillAmplitude: number;   // Height variation as fraction of peakHeight
}

export interface TerrainDefinition {
  landMasses: LandMass[];
}

/** GPU buffer layout for a single land mass */
export interface LandMassGPUData {
  startIndex: number;      // Index into control points buffer
  pointCount: number;      // Number of control points
  peakHeight: number;
  beachWidth: number;
  hillFrequency: number;
  hillAmplitude: number;
}

export const FLOATS_PER_LANDMASS = 8;  // 6 values + 2 padding

/** Build GPU data arrays from terrain definition */
export function buildTerrainGPUData(definition: TerrainDefinition): {
  controlPointsData: Float32Array;
  landMassData: Float32Array;
} {
  // Count total control points
  let totalPoints = 0;
  for (const lm of definition.landMasses) {
    totalPoints += lm.controlPoints.length;
  }

  const controlPointsData = new Float32Array(totalPoints * 2);
  const landMassData = new Float32Array(definition.landMasses.length * FLOATS_PER_LANDMASS);

  let pointIndex = 0;
  for (let i = 0; i < definition.landMasses.length; i++) {
    const lm = definition.landMasses[i];

    // Store land mass metadata
    const base = i * FLOATS_PER_LANDMASS;
    landMassData[base + 0] = pointIndex;
    landMassData[base + 1] = lm.controlPoints.length;
    landMassData[base + 2] = lm.peakHeight;
    landMassData[base + 3] = lm.beachWidth;
    landMassData[base + 4] = lm.hillFrequency;
    landMassData[base + 5] = lm.hillAmplitude;
    // [6], [7] = padding

    // Store control points
    for (const pt of lm.controlPoints) {
      controlPointsData[pointIndex * 2 + 0] = pt.x;
      controlPointsData[pointIndex * 2 + 1] = pt.y;
      pointIndex++;
    }
  }

  return { controlPointsData, landMassData };
}
```

### 3. `src/game/terrain/cpu/TerrainComputeCPU.ts`

```typescript
import { createNoise2D, NoiseFunction2D } from "simplex-noise";
import { V2d } from "../../../core/Vector";
import { LandMass, TerrainDefinition } from "../LandMass";
import { SPLINE_SUBDIVISIONS } from "../TerrainConstants";

export interface TerrainSample {
  height: number;  // ft above water level (0 = water level)
}

export class TerrainComputeCPU {
  private hillNoise: NoiseFunction2D;

  constructor() {
    this.hillNoise = createNoise2D();
  }

  computeHeightAtPoint(point: V2d, definition: TerrainDefinition): number {
    let maxHeight = 0;

    for (const landMass of definition.landMasses) {
      const signedDist = this.computeSignedDistance(point, landMass);

      if (signedDist < 0) {
        // Inside land mass
        const height = this.computeHeightProfile(point, signedDist, landMass);
        maxHeight = Math.max(maxHeight, height);
      }
    }

    return maxHeight;
  }

  private computeSignedDistance(point: V2d, landMass: LandMass): number {
    const segments = this.subdivideSpline(landMass.controlPoints);
    return this.signedDistanceToPolyline(point, segments);
  }

  private computeHeightProfile(point: V2d, signedDist: number, landMass: LandMass): number {
    // signedDist is negative inside (distance from shore inward)
    const distInland = -signedDist;

    // Beach profile: smoothstep from 0 at shore to 1 at beachWidth
    const beachFactor = smoothstep(0, landMass.beachWidth, distInland);
    const baseHeight = beachFactor * landMass.peakHeight;

    // Rolling hills via noise
    const hillNoise = this.hillNoise(
      point.x * landMass.hillFrequency,
      point.y * landMass.hillFrequency
    );
    const hillVariation = 1 + hillNoise * landMass.hillAmplitude;

    return baseHeight * hillVariation;
  }

  /** Subdivide Catmull-Rom spline into line segments */
  private subdivideSpline(controlPoints: V2d[]): V2d[] {
    const n = controlPoints.length;
    if (n < 2) return [...controlPoints];

    const segments: V2d[] = [];

    for (let i = 0; i < n; i++) {
      // For closed loop: wrap indices
      const p0 = controlPoints[(i - 1 + n) % n];
      const p1 = controlPoints[i];
      const p2 = controlPoints[(i + 1) % n];
      const p3 = controlPoints[(i + 2) % n];

      for (let j = 0; j < SPLINE_SUBDIVISIONS; j++) {
        const t = j / SPLINE_SUBDIVISIONS;
        segments.push(catmullRomPoint(p0, p1, p2, p3, t));
      }
    }

    return segments;
  }

  /** Compute signed distance to closed polyline (negative = inside) */
  private signedDistanceToPolyline(point: V2d, vertices: V2d[]): number {
    let minDist = Infinity;
    let windingNumber = 0;

    const n = vertices.length;
    for (let i = 0; i < n; i++) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];

      // Distance to segment
      const dist = pointToSegmentDistance(point, a, b);
      minDist = Math.min(minDist, dist);

      // Winding number contribution
      windingNumber += windingContribution(point, a, b);
    }

    // Inside if winding number is non-zero
    const inside = windingNumber !== 0;
    return inside ? -minDist : minDist;
  }
}

// Helper functions
function catmullRomPoint(p0: V2d, p1: V2d, p2: V2d, p3: V2d, t: number): V2d {
  const t2 = t * t;
  const t3 = t2 * t;

  const x = 0.5 * (
    2 * p1.x +
    (-p0.x + p2.x) * t +
    (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
    (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
  );

  const y = 0.5 * (
    2 * p1.y +
    (-p0.y + p2.y) * t +
    (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
    (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
  );

  return { x, y } as V2d;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function pointToSegmentDistance(p: V2d, a: V2d, b: V2d): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.hypot(p.x - a.x, p.y - a.y);
  }

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const nearestX = a.x + t * dx;
  const nearestY = a.y + t * dy;

  return Math.hypot(p.x - nearestX, p.y - nearestY);
}

function windingContribution(p: V2d, a: V2d, b: V2d): number {
  if (a.y <= p.y) {
    if (b.y > p.y) {
      // Upward crossing
      if (isLeft(a, b, p) > 0) return 1;
    }
  } else {
    if (b.y <= p.y) {
      // Downward crossing
      if (isLeft(a, b, p) < 0) return -1;
    }
  }
  return 0;
}

function isLeft(a: V2d, b: V2d, p: V2d): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}
```

### 4. `src/game/terrain/webgpu/TerrainStateCompute.ts`

```typescript
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { TERRAIN_CONSTANTS_WGSL, SPLINE_SUBDIVISIONS } from "../TerrainConstants";

// Include simplex noise WGSL (can be shared from wind system)
const TERRAIN_STATE_SHADER = /*wgsl*/ `
${TERRAIN_CONSTANTS_WGSL}

struct Params {
  time: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  textureSizeX: f32,
  textureSizeY: f32,
  landMassCount: u32,
}

struct LandMassData {
  startIndex: u32,
  pointCount: u32,
  peakHeight: f32,
  beachWidth: f32,
  hillFrequency: f32,
  hillAmplitude: f32,
  _padding1: f32,
  _padding2: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> landMasses: array<LandMassData>;
@group(0) @binding(3) var outputTexture: texture_storage_2d<r32float, write>;

// Simplex 2D noise for hills
fn simplex2D(p: vec2<f32>) -> f32 {
  // ... (standard simplex noise implementation)
}

fn catmullRomPoint(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return 0.5 * (
    2.0 * p1 +
    (-p0 + p2) * t +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
  );
}

fn pointToSegmentDistance(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let lengthSq = dot(ab, ab);
  if (lengthSq == 0.0) {
    return length(p - a);
  }
  let t = clamp(dot(p - a, ab) / lengthSq, 0.0, 1.0);
  let nearest = a + t * ab;
  return length(p - nearest);
}

fn isLeft(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
}

fn computeSignedDistance(worldPos: vec2<f32>, lmIndex: u32) -> f32 {
  let lm = landMasses[lmIndex];
  let n = lm.pointCount;
  let start = lm.startIndex;

  var minDist: f32 = 1e10;
  var windingNumber: i32 = 0;

  // For each control point pair, subdivide and check distance
  for (var i: u32 = 0u; i < n; i++) {
    let i0 = (i + n - 1u) % n;
    let i1 = i;
    let i2 = (i + 1u) % n;
    let i3 = (i + 2u) % n;

    let p0 = controlPoints[start + i0];
    let p1 = controlPoints[start + i1];
    let p2 = controlPoints[start + i2];
    let p3 = controlPoints[start + i3];

    for (var j: u32 = 0u; j < SPLINE_SUBDIVISIONS; j++) {
      let t0 = f32(j) / f32(SPLINE_SUBDIVISIONS);
      let t1 = f32(j + 1u) / f32(SPLINE_SUBDIVISIONS);

      let a = catmullRomPoint(p0, p1, p2, p3, t0);
      let b = catmullRomPoint(p0, p1, p2, p3, t1);

      // Distance to segment
      let dist = pointToSegmentDistance(worldPos, a, b);
      minDist = min(minDist, dist);

      // Winding contribution
      if (a.y <= worldPos.y) {
        if (b.y > worldPos.y && isLeft(a, b, worldPos) > 0.0) {
          windingNumber += 1;
        }
      } else {
        if (b.y <= worldPos.y && isLeft(a, b, worldPos) < 0.0) {
          windingNumber -= 1;
        }
      }
    }
  }

  let inside = windingNumber != 0;
  return select(minDist, -minDist, inside);
}

fn computeHeightProfile(worldPos: vec2<f32>, signedDist: f32, lmIndex: u32) -> f32 {
  let lm = landMasses[lmIndex];
  let distInland = -signedDist;

  // Beach smoothstep
  let beachFactor = smoothstep(0.0, lm.beachWidth, distInland);
  let baseHeight = beachFactor * lm.peakHeight;

  // Rolling hills
  let hillNoise = simplex2D(worldPos * lm.hillFrequency);
  let hillVariation = 1.0 + hillNoise * lm.hillAmplitude;

  return baseHeight * hillVariation;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  let texSize = vec2<f32>(params.textureSizeX, params.textureSizeY);
  if (f32(globalId.x) >= texSize.x || f32(globalId.y) >= texSize.y) {
    return;
  }

  // Convert pixel to world position
  let uv = (vec2<f32>(globalId.xy) + 0.5) / texSize;
  let worldPos = vec2<f32>(
    params.viewportLeft + uv.x * params.viewportWidth,
    params.viewportTop + uv.y * params.viewportHeight
  );

  var maxHeight: f32 = 0.0;

  for (var i: u32 = 0u; i < params.landMassCount; i++) {
    let signedDist = computeSignedDistance(worldPos, i);
    if (signedDist < 0.0) {
      let height = computeHeightProfile(worldPos, signedDist, i);
      maxHeight = max(maxHeight, height);
    }
  }

  // Normalize to 0-1
  let normalized = maxHeight / MAX_TERRAIN_HEIGHT;
  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(normalized, 0.0, 0.0, 1.0));
}
`;

export class TerrainStateCompute {
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  async init(): Promise<void> {
    const device = getWebGPU().device;

    const shaderModule = device.createShaderModule({
      code: TERRAIN_STATE_SHADER,
      label: "Terrain State Compute Shader",
    });

    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { format: "r32float", access: "write-only" } },
      ],
      label: "Terrain State Bind Group Layout",
    });

    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Terrain State Pipeline Layout",
    });

    this.pipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "main" },
      label: "Terrain State Compute Pipeline",
    });
  }

  getBindGroupLayout(): GPUBindGroupLayout {
    if (!this.bindGroupLayout) throw new Error("TerrainStateCompute not initialized");
    return this.bindGroupLayout;
  }

  getPipeline(): GPUComputePipeline {
    if (!this.pipeline) throw new Error("TerrainStateCompute not initialized");
    return this.pipeline;
  }

  dispatch(computePass: GPUComputePassEncoder, bindGroup: GPUBindGroup, textureSize: number): void {
    if (!this.pipeline) return;
    computePass.setPipeline(this.pipeline);
    computePass.setBindGroup(0, bindGroup);
    const workgroups = Math.ceil(textureSize / 8);
    computePass.dispatchWorkgroups(workgroups, workgroups);
  }

  destroy(): void {
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}
```

### 5. `src/game/terrain/webgpu/TerrainComputeBuffers.ts`

```typescript
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { TerrainDefinition, buildTerrainGPUData, FLOATS_PER_LANDMASS } from "../LandMass";

export const MAX_CONTROL_POINTS = 1024;
export const MAX_LANDMASSES = 32;

export interface TerrainComputeParams {
  time: number;
  viewportLeft: number;
  viewportTop: number;
  viewportWidth: number;
  viewportHeight: number;
  textureSize: number;
  landMassCount: number;
}

export class TerrainComputeBuffers {
  readonly paramsBuffer: GPUBuffer;
  readonly controlPointsBuffer: GPUBuffer;
  readonly landMassBuffer: GPUBuffer;

  private landMassCount: number = 0;

  constructor() {
    const device = getWebGPU().device;

    // Params uniform buffer (32 bytes)
    this.paramsBuffer = device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Terrain Params Buffer",
    });

    // Control points storage buffer
    this.controlPointsBuffer = device.createBuffer({
      size: MAX_CONTROL_POINTS * 2 * 4,  // vec2<f32> per point
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Control Points Buffer",
    });

    // Land mass metadata storage buffer
    this.landMassBuffer = device.createBuffer({
      size: MAX_LANDMASSES * FLOATS_PER_LANDMASS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: "Terrain Land Mass Buffer",
    });
  }

  updateTerrainData(definition: TerrainDefinition): void {
    const device = getWebGPU().device;
    const { controlPointsData, landMassData } = buildTerrainGPUData(definition);

    device.queue.writeBuffer(this.controlPointsBuffer, 0, controlPointsData.buffer);
    device.queue.writeBuffer(this.landMassBuffer, 0, landMassData.buffer);
    this.landMassCount = definition.landMasses.length;
  }

  updateParams(params: TerrainComputeParams): void {
    const device = getWebGPU().device;

    const paramsData = new ArrayBuffer(32);
    const floats = new Float32Array(paramsData, 0, 7);
    const uints = new Uint32Array(paramsData, 28, 1);

    floats[0] = params.time;
    floats[1] = params.viewportLeft;
    floats[2] = params.viewportTop;
    floats[3] = params.viewportWidth;
    floats[4] = params.viewportHeight;
    floats[5] = params.textureSize;
    floats[6] = params.textureSize;
    uints[0] = params.landMassCount;

    device.queue.writeBuffer(this.paramsBuffer, 0, paramsData);
  }

  getLandMassCount(): number {
    return this.landMassCount;
  }

  destroy(): void {
    this.paramsBuffer.destroy();
    this.controlPointsBuffer.destroy();
    this.landMassBuffer.destroy();
  }
}
```

### 6. `src/game/terrain/webgpu/TerrainDataTileCompute.ts`

```typescript
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { DataTileCompute } from "../../datatiles/DataTileComputePipeline";
import { TERRAIN_TILE_RESOLUTION } from "../TerrainConstants";
import { TerrainComputeBuffers } from "./TerrainComputeBuffers";
import { TerrainStateCompute } from "./TerrainStateCompute";

export class TerrainDataTileCompute implements DataTileCompute {
  private stateCompute: TerrainStateCompute;
  private buffers: TerrainComputeBuffers;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private textureSize: number;

  constructor(
    buffers: TerrainComputeBuffers,
    textureSize: number = TERRAIN_TILE_RESOLUTION,
  ) {
    this.buffers = buffers;
    this.textureSize = textureSize;
    this.stateCompute = new TerrainStateCompute();
  }

  async init(): Promise<void> {
    const device = getWebGPU().device;

    await this.stateCompute.init();

    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING |
             GPUTextureUsage.TEXTURE_BINDING |
             GPUTextureUsage.COPY_SRC,
      label: "Terrain Data Tile Output Texture",
    });

    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.controlPointsBuffer } },
        { binding: 2, resource: { buffer: this.buffers.landMassBuffer } },
        { binding: 3, resource: this.outputTexture.createView() },
      ],
      label: "Terrain Data Tile Bind Group",
    });
  }

  runCompute(time: number, left: number, top: number, width: number, height: number): void {
    if (!this.bindGroup) return;

    const device = getWebGPU().device;

    this.buffers.updateParams({
      time,
      viewportLeft: left,
      viewportTop: top,
      viewportWidth: width,
      viewportHeight: height,
      textureSize: this.textureSize,
      landMassCount: this.buffers.getLandMassCount(),
    });

    const commandEncoder = device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  getOutputTexture(): GPUTexture | null {
    return this.outputTexture;
  }

  destroy(): void {
    this.outputTexture?.destroy();
    this.stateCompute.destroy();
    this.bindGroup = null;
    this.outputTexture = null;
  }
}
```

### 7. `src/game/terrain/TerrainInfo.ts`

```typescript
import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import type Game from "../../core/Game";
import { V2d } from "../../core/Vector";
import { DataTileComputePipeline } from "../datatiles/DataTileComputePipeline";
import { DataTileGridConfig, DataTileReadbackConfig, isTerrainQuerier } from "../datatiles/DataTileTypes";
import { TerrainComputeCPU } from "./cpu/TerrainComputeCPU";
import { LandMass, TerrainDefinition } from "./LandMass";
import { TERRAIN_TILE_RESOLUTION, TERRAIN_TILE_SIZE, MAX_TERRAIN_HEIGHT } from "./TerrainConstants";
import { TerrainComputeBuffers } from "./webgpu/TerrainComputeBuffers";
import { TerrainDataTileCompute } from "./webgpu/TerrainDataTileCompute";

export interface TerrainSample {
  height: number;
}

const TERRAIN_TILE_CONFIG: DataTileGridConfig = {
  tileSize: TERRAIN_TILE_SIZE,
  tileResolution: TERRAIN_TILE_RESOLUTION,
  maxTilesPerFrame: 64,
  minScoreThreshold: 1,
};

const TERRAIN_READBACK_CONFIG: DataTileReadbackConfig<TerrainSample> = {
  channelCount: 1,
  bytesPerPixel: 4,  // r32float
  label: "Terrain",
  texelToSample: (channels) => ({
    height: channels[0],
  }),
  denormalize: (sample) => ({
    height: sample.height * MAX_TERRAIN_HEIGHT,
  }),
};

export class TerrainInfo extends BaseEntity {
  id = "terrainInfo";
  tickLayer = "environment" as const;

  private tilePipeline: DataTileComputePipeline<TerrainSample, TerrainDataTileCompute> | null = null;
  private sharedBuffers: TerrainComputeBuffers | null = null;
  private cpuFallback: TerrainComputeCPU;
  private terrainDefinition: TerrainDefinition;

  constructor(landMasses: LandMass[] = []) {
    super();
    this.terrainDefinition = { landMasses };
    this.cpuFallback = new TerrainComputeCPU();
  }

  // Access via game.entities.getSingleton(TerrainInfo)
  // or game.entities.tryGetSingleton(TerrainInfo) for optional access

  @on("afterAdded")
  async initGPU(): Promise<void> {
    this.sharedBuffers = new TerrainComputeBuffers();
    this.sharedBuffers.updateTerrainData(this.terrainDefinition);

    this.tilePipeline = new DataTileComputePipeline<TerrainSample, TerrainDataTileCompute>(
      TERRAIN_TILE_CONFIG,
      TERRAIN_READBACK_CONFIG,
      (resolution) => new TerrainDataTileCompute(this.sharedBuffers!, resolution),
    );
    await this.tilePipeline.init();
  }

  @on("tick")
  onTick(): void {
    this.tilePipeline?.completeReadbacks();
  }

  @on("afterPhysics")
  onAfterPhysics(): void {
    if (!this.tilePipeline) return;

    // Collect query forecasts from terrain queriers
    for (const entity of this.game!.entities.getTagged("terrainQuerier")) {
      if (isTerrainQuerier(entity)) {
        const forecast = entity.getTerrainQueryForecast();
        if (forecast) {
          this.tilePipeline.addQueryForecast(forecast);
        }
      }
    }

    // Compute tiles
    this.tilePipeline.computeTiles(this.game!.time);
  }

  @on("destroy")
  onDestroy(): void {
    this.tilePipeline?.destroy();
    this.sharedBuffers?.destroy();
  }

  /** Get terrain height at a world point */
  getHeightAtPoint(point: V2d): number {
    // Try GPU first
    if (this.tilePipeline) {
      const sample = this.tilePipeline.sampleAtWorldPoint(point.x, point.y);
      if (sample) {
        return sample.height;
      }
    }

    // CPU fallback
    return this.cpuFallback.computeHeightAtPoint(point, this.terrainDefinition);
  }

  /** Update terrain definition (e.g., for level loading) */
  setTerrainDefinition(definition: TerrainDefinition): void {
    this.terrainDefinition = definition;
    this.sharedBuffers?.updateTerrainData(definition);
  }

  /** Add a land mass to the terrain */
  addLandMass(landMass: LandMass): void {
    this.terrainDefinition.landMasses.push(landMass);
    this.sharedBuffers?.updateTerrainData(this.terrainDefinition);
  }
}
```

### 8. `src/game/datatiles/DataTileTypes.ts` - Add TerrainQuerier

Add to existing file:

```typescript
/**
 * Interface for entities that query terrain data.
 * Entities with the "terrainQuerier" tag should implement this interface.
 */
export interface TerrainQuerier {
  getTerrainQueryForecast(): QueryForecast | null;
}

/** Type guard for TerrainQuerier interface. */
export function isTerrainQuerier(value: unknown): value is TerrainQuerier {
  return (
    typeof value === "object" &&
    value !== null &&
    "getTerrainQueryForecast" in value
  );
}
```

### 9. `src/game/water/rendering/WaterShader.ts` - Add Terrain Integration

Key changes to the fragment shader:

```wgsl
// Add binding for terrain texture
@group(0) @binding(3) var terrainDataTexture: texture_2d<f32>;

// Add uniform for terrain parameters
struct Uniforms {
  // ... existing fields ...
  hasTerrainData: i32,
  shallowThreshold: f32,  // Depth for sand/water blending (e.g., 1.0 ft)
}

// Sand rendering function
fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>) -> vec4<f32> {
  let wetSand = vec3<f32>(0.76, 0.70, 0.50);
  let drySand = vec3<f32>(0.96, 0.91, 0.76);

  let heightFactor = smoothstep(0.0, 3.0, height);
  var baseColor = mix(wetSand, drySand, heightFactor);

  // Sand texture noise
  let sandNoise = hash21(worldPos * 5.0) * 0.05;
  baseColor = baseColor + sandNoise;

  // Diffuse lighting
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));
  let diffuse = max(dot(normal, sunDir), 0.0);

  return vec4<f32>(baseColor * (0.7 + 0.3 * diffuse), 1.0);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // ... existing world position calculation ...

  // Sample water and terrain data
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let waterHeight = (waterData.r - 0.5) * 5.0;  // Denormalize

  var terrainHeight: f32 = 0.0;
  if (uniforms.hasTerrainData != 0) {
    let terrainData = textureSample(terrainDataTexture, waterSampler, dataUV);
    terrainHeight = terrainData.r * 20.0;  // Denormalize (MAX_TERRAIN_HEIGHT)
  }

  // Calculate water depth
  let waterDepth = waterHeight - terrainHeight;

  // Compute normal (combine water and terrain)
  let normal = computeNormal(dataUV, waterDepth, terrainHeight);

  if (waterDepth < 0.0) {
    // Above water - render sand
    return renderSand(terrainHeight, normal, worldPos);
  } else if (waterDepth < uniforms.shallowThreshold) {
    // Shallow water - blend sand and water
    let blendFactor = smoothstep(0.0, uniforms.shallowThreshold, waterDepth);
    let sandColor = renderSand(terrainHeight, normal, worldPos);
    let waterColor = renderWater(waterData, normal, worldPos, waterDepth);
    return mix(sandColor, waterColor, blendFactor);
  } else {
    // Deep water - existing water rendering with depth-based color
    return renderWater(waterData, normal, worldPos, waterDepth);
  }
}

fn renderWater(waterData: vec4<f32>, normal: vec3<f32>, worldPos: vec2<f32>, depth: f32) -> vec4<f32> {
  // Modify existing water rendering to use depth for color
  let depthFactor = smoothstep(0.0, 10.0, depth);  // 0-10 ft range
  let shallowColor = vec3<f32>(0.15, 0.55, 0.65);  // Light blue-green
  let deepColor = vec3<f32>(0.08, 0.32, 0.52);     // Darker blue
  let baseColor = mix(shallowColor, deepColor, depthFactor);

  // ... rest of existing water lighting code using baseColor ...
}
```

### 10. `src/game/boat/BoatConfig.ts` - Add Draft Values

Add to existing interfaces:

```typescript
export interface HullConfig {
  // ... existing fields ...
  readonly draft: number;  // ft below waterline
}

export interface KeelConfig {
  // ... existing fields ...
  readonly draft: number;  // ft below waterline (tip of keel)
}

export interface RudderConfig {
  // ... existing fields ...
  readonly draft: number;  // ft below waterline (tip of rudder)
}

export interface GroundingConfig {
  readonly keelFriction: number;    // lbf per ft penetration per ft/s
  readonly rudderFriction: number;
  readonly hullFriction: number;
}

export interface BoatConfig {
  // ... existing fields ...
  readonly grounding: GroundingConfig;
}
```

### 11. `src/game/boat/configs/StarterDinghy.ts` - Add Draft Values

```typescript
export const StarterDinghy: BoatConfig = {
  hull: {
    // ... existing ...
    draft: 0.5,  // Hull bottom 0.5 ft below waterline
  },
  keel: {
    // ... existing ...
    draft: 2.5,  // Centerboard extends 2.5 ft below waterline
  },
  rudder: {
    // ... existing ...
    draft: 1.5,  // Rudder extends 1.5 ft below waterline
  },
  // ... existing fields ...
  grounding: {
    keelFriction: 50,     // Moderate friction - keel scraping
    rudderFriction: 30,   // Less friction - rudder is smaller
    hullFriction: 200,    // High friction - hull grounding is severe
  },
};
```

### 12. `src/game/boat/BoatGrounding.ts` - New File

```typescript
import BaseEntity from "../../core/entity/BaseEntity";
import { on } from "../../core/entity/handler";
import { V, V2d } from "../../core/Vector";
import { TerrainInfo } from "../terrain/TerrainInfo";
import { WaterInfo } from "../water/WaterInfo";
import { GroundingConfig } from "./BoatConfig";
import { Hull } from "./Hull";
import { Keel } from "./Keel";
import { Rudder } from "./Rudder";

/**
 * Applies soft grounding friction when boat components contact the seabed.
 * Uses terrain height and water height to determine water depth,
 * then applies friction if component draft exceeds depth.
 */
export class BoatGrounding extends BaseEntity {
  constructor(
    private hull: Hull,
    private keel: Keel,
    private rudder: Rudder,
    private keelVertices: V2d[],
    private config: {
      hullDraft: number;
      keelDraft: number;
      rudderDraft: number;
      grounding: GroundingConfig;
    },
  ) {
    super();
  }

  @on("tick")
  onTick(dt: number): void {
    const terrain = this.game!.entities.tryGetSingleton(TerrainInfo);
    if (!terrain) return;  // No terrain system, skip grounding

    const water = this.game!.entities.getSingleton(WaterInfo);

    // Check keel grounding (most likely to ground first)
    const keelTip = this.getKeelTipPosition();
    this.applyGroundingForce(
      keelTip,
      this.config.keelDraft,
      this.config.grounding.keelFriction,
      terrain,
      water,
    );

    // Check rudder grounding
    const rudderTip = this.getRudderTipPosition();
    this.applyGroundingForce(
      rudderTip,
      this.config.rudderDraft,
      this.config.grounding.rudderFriction,
      terrain,
      water,
    );

    // Check hull grounding at multiple points
    for (const localPoint of this.getHullSamplePoints()) {
      const worldPoint = this.hull.body.toWorldFrame(localPoint);
      this.applyGroundingForce(
        worldPoint,
        this.config.hullDraft,
        this.config.grounding.hullFriction,
        terrain,
        water,
      );
    }
  }

  private applyGroundingForce(
    worldPoint: V2d,
    draft: number,
    frictionCoeff: number,
    terrain: TerrainInfo,
    water: WaterInfo,
  ): void {
    const waterState = water.getStateAtPoint(worldPoint);
    const terrainHeight = terrain.getHeightAtPoint(worldPoint);

    // Water depth at this point
    const waterDepth = waterState.surfaceHeight - terrainHeight;

    // How much is this component penetrating the seabed?
    const penetration = draft - waterDepth;

    if (penetration > 0) {
      // Component is touching bottom
      const velocity = this.hull.body.getVelocityAtPoint(worldPoint);
      const speed = velocity.magnitude;

      if (speed > 0.01) {
        // Friction increases with penetration depth
        const frictionMagnitude = penetration * frictionCoeff * speed;
        const frictionForce = velocity.normalized().imul(-frictionMagnitude);

        this.hull.body.applyForce(frictionForce, worldPoint);
      }
    }
  }

  private getKeelTipPosition(): V2d {
    // Get the deepest point of the keel (lowest Y in local coords)
    let deepestPoint = this.keelVertices[0];
    for (const v of this.keelVertices) {
      // In boat coords, more negative Y = deeper
      // But actually keel vertices define the shape, find the one furthest from hull
      if (v.magnitude > deepestPoint.magnitude) {
        deepestPoint = v;
      }
    }
    return this.hull.body.toWorldFrame(deepestPoint);
  }

  private getRudderTipPosition(): V2d {
    // Rudder tip is at rudder position offset by rudder length
    const rudderPos = this.rudder.getPosition();
    const rudderAngle = this.hull.body.angle + this.rudder.getTillerAngleOffset();
    const tipOffset = V(-this.config.rudderDraft, 0).irotate(rudderAngle - this.hull.body.angle);
    return this.hull.body.toWorldFrame(rudderPos.add(tipOffset));
  }

  private getHullSamplePoints(): V2d[] {
    // Sample a few points along the hull bottom
    // These are in local coordinates
    return [
      V(0, 0),      // Center
      V(4, 0),      // Forward
      V(-4, 0),     // Aft
      V(0, 2),      // Port
      V(0, -2),     // Starboard
    ];
  }
}
```

### 13. `src/game/boat/Boat.ts` - Add BoatGrounding

Add to imports and constructor:

```typescript
import { BoatGrounding } from "./BoatGrounding";

// In constructor, after creating other components:
this.addChild(
  new BoatGrounding(this.hull, this.keel, this.rudder, config.keel.vertices, {
    hullDraft: config.hull.draft,
    keelDraft: config.keel.draft,
    rudderDraft: config.rudder.draft,
    grounding: config.grounding,
  }),
);
```

### 14. `src/game/terrain/rendering/TerrainRenderPipeline.ts`

```typescript
import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { TERRAIN_TEXTURE_SIZE } from "../TerrainConstants";
import { TerrainComputeBuffers } from "../webgpu/TerrainComputeBuffers";
import { TerrainStateCompute } from "../webgpu/TerrainStateCompute";

/**
 * Computes terrain height texture for rendering.
 * Similar to WaterRenderPipeline but for terrain.
 */
export class TerrainRenderPipeline {
  private stateCompute: TerrainStateCompute;
  private buffers: TerrainComputeBuffers;
  private bindGroup: GPUBindGroup | null = null;
  private outputTexture: GPUTexture | null = null;
  private textureView: GPUTextureView | null = null;
  private textureSize: number;

  constructor(buffers: TerrainComputeBuffers, textureSize: number = TERRAIN_TEXTURE_SIZE) {
    this.buffers = buffers;
    this.textureSize = textureSize;
    this.stateCompute = new TerrainStateCompute();
  }

  async init(): Promise<void> {
    const device = getWebGPU().device;

    await this.stateCompute.init();

    this.outputTexture = device.createTexture({
      size: { width: this.textureSize, height: this.textureSize },
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      label: "Terrain Render Output Texture",
    });

    this.textureView = this.outputTexture.createView();

    this.bindGroup = device.createBindGroup({
      layout: this.stateCompute.getBindGroupLayout(),
      entries: [
        { binding: 0, resource: { buffer: this.buffers.paramsBuffer } },
        { binding: 1, resource: { buffer: this.buffers.controlPointsBuffer } },
        { binding: 2, resource: { buffer: this.buffers.landMassBuffer } },
        { binding: 3, resource: this.textureView },
      ],
      label: "Terrain Render Bind Group",
    });
  }

  update(
    time: number,
    viewportLeft: number,
    viewportTop: number,
    viewportWidth: number,
    viewportHeight: number,
  ): void {
    if (!this.bindGroup) return;

    const device = getWebGPU().device;

    this.buffers.updateParams({
      time,
      viewportLeft,
      viewportTop,
      viewportWidth,
      viewportHeight,
      textureSize: this.textureSize,
      landMassCount: this.buffers.getLandMassCount(),
    });

    const commandEncoder = device.createCommandEncoder();
    const computePass = commandEncoder.beginComputePass();
    this.stateCompute.dispatch(computePass, this.bindGroup, this.textureSize);
    computePass.end();
    device.queue.submit([commandEncoder.finish()]);
  }

  getOutputTextureView(): GPUTextureView | null {
    return this.textureView;
  }

  destroy(): void {
    this.outputTexture?.destroy();
    this.stateCompute.destroy();
    this.bindGroup = null;
    this.textureView = null;
  }
}
```

## Execution Order

### Parallel Work (no dependencies)

These can be implemented independently and in parallel:

- `TerrainConstants.ts`
- `LandMass.ts`
- `TerrainComputeCPU.ts`
- Add `TerrainQuerier` to `DataTileTypes.ts`

### Sequential Work (has dependencies)

**Phase 1: Core Terrain System**
1. First: Create `TerrainConstants.ts`, `LandMass.ts`
2. Then: Create `TerrainComputeCPU.ts` (depends on LandMass types)
3. Then: Create `TerrainComputeBuffers.ts` (depends on LandMass)
4. Then: Create `TerrainStateCompute.ts` (depends on Constants)
5. Then: Create `TerrainDataTileCompute.ts` (depends on StateCompute, Buffers)
6. Then: Create `TerrainInfo.ts` (depends on all above)
7. Finally: Add `TerrainQuerier` to `DataTileTypes.ts`

**Phase 2: Rendering Integration**
1. First: Create `TerrainRenderPipeline.ts`
2. Then: Modify `WaterShader.ts` (add terrain texture binding and rendering)
3. Then: Modify `WaterRenderPipeline.ts` (create TerrainRenderPipeline, pass texture)
4. Finally: Modify `WaterRenderer.ts` (coordinate pipeline updates)

**Phase 3: Physics Integration**
1. First: Add draft fields to `BoatConfig.ts` interfaces
2. Then: Update `StarterDinghy.ts` with draft values
3. Then: Create `BoatGrounding.ts`
4. Finally: Add `BoatGrounding` to `Boat.ts`

**Phase 4: Testing**
1. Create a test island definition in game initialization
2. Verify terrain renders correctly (sand visible above water)
3. Verify water depth blending at shoreline
4. Verify boat grounding friction when sailing into shallow water

## Test Island Definition

For initial testing, add to game initialization:

```typescript
import { TerrainInfo } from "./terrain/TerrainInfo";
import { V } from "../core/Vector";

// Create a simple test island
const testIsland = {
  controlPoints: [
    V(100, 100),
    V(150, 80),
    V(200, 100),
    V(220, 150),
    V(200, 200),
    V(150, 220),
    V(100, 200),
    V(80, 150),
  ],
  peakHeight: 5,
  beachWidth: 20,
  hillFrequency: 0.02,
  hillAmplitude: 0.3,
};

// Add terrain entity to game
game.addEntity(new TerrainInfo([testIsland]));
```
