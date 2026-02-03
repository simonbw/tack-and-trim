# Terrain System Design

## Overview

A terrain system for defining landmasses with smooth coastlines, rolling hills, and physics interaction for boat grounding. Follows the established patterns from Wind and Water systems.

## Architecture

```
src/game/terrain/
├── TerrainInfo.ts              # Main entity orchestrator (like WaterInfo/WindInfo)
├── TerrainConstants.ts         # Shared constants (TypeScript + WGSL)
├── LandMass.ts                 # Land mass definition types
│
├── webgpu/
│   ├── TerrainStateCompute.ts  # Shared compute shader pipeline
│   ├── TerrainDataTileCompute.ts # Per-tile compute implementation
│   └── TerrainComputeBuffers.ts  # Shared GPU buffers for land mass data
│
├── cpu/
│   └── TerrainComputeCPU.ts    # CPU fallback (matches GPU exactly)
│
└── rendering/
    └── (integrated into WaterShader.ts) # Terrain texture passed to water shader
```

## Land Mass Definition

### Data Structure

```typescript
// src/game/terrain/LandMass.ts

interface LandMass {
  /** Catmull-Rom control points defining the coastline (closed loop) */
  controlPoints: V2d[];

  /** Height profile */
  peakHeight: number;      // Max height above water (ft), e.g., 3-8 ft for sandy islands
  beachWidth: number;      // Distance from shore where terrain starts rising (ft), e.g., 15-30 ft

  /** Rolling hills parameters */
  hillFrequency: number;   // Noise frequency for undulating surface
  hillAmplitude: number;   // Height variation as fraction of peakHeight
}

interface TerrainDefinition {
  landMasses: LandMass[];
}
```

### Height Calculation Algorithm

1. **Catmull-Rom to Polyline**: Subdivide spline into dense line segments
2. **Signed Distance Field**: Calculate distance from query point to nearest coastline segment
   - Negative = inside land mass
   - Positive = in water
3. **Height Profile**:
   ```
   distance < 0 (inside):
     beachFactor = smoothstep(0, -beachWidth, distance)  // 0 at shore, 1 at beachWidth inland
     baseHeight = beachFactor * peakHeight
     hillNoise = simplex3D(x * hillFrequency, y * hillFrequency, 0) * hillAmplitude
     height = baseHeight * (1 + hillNoise)

   distance >= 0 (in water):
     height = 0  // Below water, let water system handle depth
   ```

### GPU Data Layout

```typescript
// TerrainComputeBuffers.ts

// Control points buffer - all land masses concatenated
// Format: [x, y, x, y, ...] for each land mass
controlPointsBuffer: GPUBuffer;  // storage<read>

// Land mass metadata buffer
// Format per land mass: [startIndex, pointCount, peakHeight, beachWidth, hillFreq, hillAmp, padding, padding]
landMassBuffer: GPUBuffer;  // storage<read>

// Params buffer (per-tile)
paramsBuffer: GPUBuffer;  // uniform
```

## Compute Shader

### TerrainStateCompute.ts

```wgsl
// Output: r32float (terrain height)
// Could expand to rg32float if we need terrain normal or type later

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let worldPos = pixelToWorld(id.xy);

  var maxHeight: f32 = 0.0;

  // For each land mass
  for (var i = 0u; i < landMassCount; i++) {
    let signedDist = computeSignedDistance(worldPos, i);

    if (signedDist < 0.0) {
      // Inside this land mass
      let height = computeHeightProfile(signedDist, i, worldPos);
      maxHeight = max(maxHeight, height);
    }
  }

  // Normalize and output
  let normalizedHeight = maxHeight / MAX_TERRAIN_HEIGHT;
  textureStore(outputTexture, id.xy, vec4<f32>(normalizedHeight, 0, 0, 1));
}
```

### Catmull-Rom in WGSL

```wgsl
fn catmullRomPoint(p0: vec2<f32>, p1: vec2<f32>, p2: vec2<f32>, p3: vec2<f32>, t: f32) -> vec2<f32> {
  let t2 = t * t;
  let t3 = t2 * t;

  return 0.5 * (
    (2.0 * p1) +
    (-p0 + p2) * t +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
  );
}

// For SDF: subdivide curve into line segments, find closest point
fn signedDistanceToCurve(point: vec2<f32>, landMassIndex: u32) -> f32 {
  // Subdivide Catmull-Rom into ~20 segments per control point pair
  // Compute signed distance to polyline
  // Sign determined by winding (cross product)
}
```

## Data Tile Pipeline

Follows the established pattern exactly:

```typescript
// TerrainInfo.ts

class TerrainInfo extends BaseEntity {
  private tilePipeline: DataTileComputePipeline<TerrainData, TerrainDataTileCompute>;
  private cpuFallback: TerrainComputeCPU;
  private terrainDefinition: TerrainDefinition;

  getHeightAtPoint(point: V2d): number {
    // Try GPU tile first
    const result = this.tilePipeline.sampleAtWorldPoint(point.x, point.y);
    if (result) {
      return result.height;
    }

    // CPU fallback
    return this.cpuFallback.computeHeightAtPoint(point, this.terrainDefinition);
  }

  /** For water depth calculation */
  getWaterDepthAtPoint(point: V2d, waterHeight: number): number {
    const terrainHeight = this.getHeightAtPoint(point);
    return waterHeight - terrainHeight;
  }
}
```

### Tile Configuration

```typescript
// TerrainConstants.ts

export const TERRAIN_TILE_SIZE = 64;        // ft per tile (match water/wind)
export const TERRAIN_TILE_RESOLUTION = 128; // pixels per tile
export const MAX_TERRAIN_HEIGHT = 20;       // ft (for normalization)
export const TERRAIN_TEXTURE_SIZE = 512;    // For rendering
```

## Rendering Integration

### Option A: Pass Terrain Texture to WaterShader

Modify `WaterShader.ts` to accept a terrain height texture:

```wgsl
// In WaterShader.ts

@group(0) @binding(3) var terrainDataTexture: texture_2d<f32>;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // ... existing world position calculation ...

  // Sample terrain height
  let terrainData = textureSample(terrainDataTexture, waterSampler, dataUV);
  let terrainHeight = terrainData.r * MAX_TERRAIN_HEIGHT;

  // Sample water height
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let waterHeight = (waterData.r - 0.5) * WATER_HEIGHT_RANGE;  // denormalize

  // Calculate water depth
  let waterDepth = waterHeight - terrainHeight;

  if (waterDepth < 0.0) {
    // Render terrain (sand)
    return renderSand(terrainHeight, normal, worldPos);
  } else if (waterDepth < SHALLOW_THRESHOLD) {
    // Shallow water - blend between sand and water
    let blendFactor = smoothstep(0.0, SHALLOW_THRESHOLD, waterDepth);
    let sandColor = renderSand(terrainHeight, normal, worldPos);
    let waterColor = renderWater(waterData, normal, worldPos);
    return mix(sandColor, waterColor, blendFactor);
  } else {
    // Deep water - existing water rendering
    return renderWater(waterData, normal, worldPos);
  }
}

fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>) -> vec4<f32> {
  // Sandy colors based on height/slope
  let wetSand = vec3<f32>(0.76, 0.70, 0.50);   // Near water
  let drySand = vec3<f32>(0.96, 0.91, 0.76);   // Higher up

  let heightFactor = smoothstep(0.0, 3.0, height);
  var baseColor = mix(wetSand, drySand, heightFactor);

  // Add noise for texture
  let sandNoise = hash21(worldPos * 5.0) * 0.05;
  baseColor = baseColor + sandNoise;

  // Basic diffuse lighting
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));
  let diffuse = max(dot(normal, sunDir), 0.0);

  return vec4<f32>(baseColor * (0.7 + 0.3 * diffuse), 1.0);
}
```

### WaterRenderPipeline Changes

```typescript
// WaterRenderPipeline.ts - modified

class WaterRenderPipeline {
  private terrainPipeline: TerrainRenderPipeline;  // New

  update(viewport: Viewport, waterInfo: WaterInfo, terrainInfo: TerrainInfo) {
    // Update terrain texture first
    this.terrainPipeline.update(viewport, terrainInfo);

    // Existing water compute...
  }

  getTerrainTextureView(): GPUTextureView | null {
    return this.terrainPipeline.getOutputTextureView();
  }
}
```

## Physics: Grounding Friction

### Boat Draft Configuration

Add draft depths to boat components:

```typescript
// BoatConfig.ts - additions

export interface KeelConfig {
  // ... existing ...
  readonly draft: number;  // ft below waterline (e.g., 2.5 ft)
}

export interface RudderConfig {
  // ... existing ...
  readonly draft: number;  // ft below waterline (e.g., 1.5 ft)
}

export interface HullConfig {
  // ... existing ...
  readonly draft: number;  // ft below waterline for hull bottom (e.g., 0.5 ft)
}
```

### Grounding Force Application

```typescript
// New file: src/game/boat/BoatGrounding.ts

/**
 * Applies soft grounding forces when boat components contact the seabed.
 * Not a hard collision - just increasing friction as things scrape bottom.
 */
export class BoatGrounding extends BaseEntity {
  constructor(
    private hull: Hull,
    private keel: Keel,
    private rudder: Rudder,
    private config: GroundingConfig,
  ) {
    super();
  }

  @on("tick")
  onTick(dt: number) {
    const terrain = this.game!.entities.getSingleton(TerrainInfo);
    const water = this.game!.entities.getSingleton(WaterInfo);

    // Check keel grounding (most common)
    this.applyGroundingForce(
      this.getKeelTipPosition(),
      this.config.keelDraft,
      this.config.keelFriction,
    );

    // Check rudder grounding
    this.applyGroundingForce(
      this.getRudderTipPosition(),
      this.config.rudderDraft,
      this.config.rudderFriction,
    );

    // Check hull grounding (severe - boat is really stuck)
    for (const samplePoint of this.getHullSamplePoints()) {
      this.applyGroundingForce(
        samplePoint,
        this.config.hullDraft,
        this.config.hullFriction,
      );
    }
  }

  private applyGroundingForce(
    worldPoint: V2d,
    draft: number,
    frictionCoeff: number,
  ) {
    const terrain = this.game!.entities.getSingleton(TerrainInfo);
    const water = this.game!.entities.getSingleton(WaterInfo);

    const waterState = water.getStateAtPoint(worldPoint);
    const terrainHeight = terrain.getHeightAtPoint(worldPoint);

    // How deep is the water here?
    const waterDepth = waterState.height - terrainHeight;

    // How deep does this component extend?
    const penetration = draft - waterDepth;

    if (penetration > 0) {
      // Component is touching bottom!
      // Apply friction force opposing velocity

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
}
```

### Grounding Configuration

```typescript
// BoatConfig.ts - additions

export interface GroundingConfig {
  readonly keelDraft: number;      // ft below waterline
  readonly rudderDraft: number;    // ft below waterline
  readonly hullDraft: number;      // ft below waterline
  readonly keelFriction: number;   // lbf per ft penetration per ft/s
  readonly rudderFriction: number;
  readonly hullFriction: number;   // Higher - hull grounding is bad
}
```

## Implementation Order

### Phase 1: Core Terrain System
1. `TerrainConstants.ts` - Constants and WGSL snippets
2. `LandMass.ts` - Data structures
3. `TerrainComputeCPU.ts` - CPU implementation (testable without GPU)
4. `TerrainStateCompute.ts` - GPU compute shader
5. `TerrainComputeBuffers.ts` - Shared buffers
6. `TerrainDataTileCompute.ts` - Per-tile compute
7. `TerrainInfo.ts` - Main entity with hybrid GPU/CPU queries

### Phase 2: Rendering Integration
1. `TerrainRenderPipeline.ts` - Render texture compute
2. Modify `WaterShader.ts` - Add terrain texture input, depth-based rendering
3. Modify `WaterRenderPipeline.ts` - Coordinate terrain + water compute
4. Modify `WaterRenderer.ts` - Pass terrain data through

### Phase 3: Physics Integration
1. Add draft values to `BoatConfig.ts`
2. Create `BoatGrounding.ts` entity
3. Add to `Boat.ts` entity composition

### Phase 4: Content
1. Create test island definitions
2. Tune visual parameters (sand colors, water depth blending)
3. Tune physics parameters (friction coefficients)

## Open Questions Resolved

1. **Primitive type**: Catmull-Rom splines for smooth coastlines
2. **Height profile**: Rolling hills via simplex noise modulation
3. **Shore blending**: Soft blend based on water depth (wet sand zone)
4. **Level authoring**: Start with hardcoded arrays, could add JSON later

## Performance Considerations

- **Tile resolution**: 128x128 should be sufficient (terrain changes slowly)
- **SDF computation**: O(segments) per pixel - keep control point count reasonable
- **CPU fallback**: Cache recent queries in spatial hash if needed
- **Catmull-Rom subdivision**: 10-20 segments per curve span should suffice

## Visual Reference

```
                    Water Surface
   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                     |
          Shallow    |    Deep Water
          (blended)  |    (full water color)
   ------------------+-------------------------------------
        /            |
       /  Beach      |  Depth = waterHeight - terrainHeight
      /   Zone       |
     /               |
    /~~~~~~~~~~~~~~~~+~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
   /      Sand       |     Seafloor (not visible)
  /                  |
 /    Rolling Hills  |
/____________________+_____________________________________
      Terrain        |
```
