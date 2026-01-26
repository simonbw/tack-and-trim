# SurfaceRenderer Data Flow Trace

This document traces every piece of data that flows into the SurfaceRenderer shader, from final shader input back to its ultimate origin.

## SurfaceShader Bind Group 0 (SurfaceShader.ts:18-24)

```
@group(0) @binding(0) var<uniform> uniforms: Uniforms
@group(0) @binding(1) var waterSampler: sampler
@group(0) @binding(2) var waterDataTexture: texture_2d<f32>  // rgba32float
@group(0) @binding(3) var terrainDataTexture: texture_2d<f32>  // rgba32float
@group(0) @binding(4) var wetnessTexture: texture_2d<f32>  // r32float
```

---

## Binding 0: Uniform Buffer (144 bytes)

### Layout (SurfaceRenderer.ts:89-104)

| Index | Field                                        | Bytes |
| ----- | -------------------------------------------- | ----- |
| 0-11  | cameraMatrix (mat3x3, padded)                | 48    |
| 12    | time                                         | 4     |
| 13    | renderMode                                   | 4     |
| 14-15 | screenWidth, screenHeight                    | 8     |
| 16-19 | viewport (left, top, width, height)          | 16    |
| 20    | colorNoiseStrength (unused)                  | 4     |
| 21    | hasTerrainData                               | 4     |
| 22    | shallowThreshold                             | 4     |
| 23-28 | texture dimensions (water, terrain, wetness) | 24    |
| 29-30 | (padding)                                    | 8     |
| 31-34 | wetness viewport bounds                      | 16    |

### Data Flow Tree

```
uniforms (SurfaceRenderer.ts:89-104)
├── cameraMatrix [indices 0-11] (SurfaceRenderer.ts:553-554)
│   └── Camera2d.getMatrix().invert() (Camera2d.ts:292-363)
│       └── Camera2d.getMatrix() (Camera2d.ts:292-339)
│           ├── position (Camera2d.ts:36-37)
│           │   ├── User input (pan/drag)
│           │   └── Entity follow target (Camera2d.ts:59-60)
│           ├── zoom (Camera2d.ts:54-55)
│           │   └── User input (scroll wheel)
│           └── screenSize (Camera2d.ts:39)
│               └── RenderManager.getScreenSize()
│
├── time [index 12] (SurfaceRenderer.ts:464-467)
│   └── TimeOfDay.getTimeInSeconds() (TimeOfDay.ts:106-108)
│       └── timeInMinutes (TimeOfDay.ts:35)
│           └── TimeOfDay.onTick() accumulation (TimeOfDay.ts:83-94)
│               └── Game tick delta time
│
├── renderMode [index 13] (SurfaceRenderer.ts:69, 550)
│   └── SurfaceRenderer.renderMode property
│       └── Debug UI toggle (RenderMode enum)
│
├── screenWidth, screenHeight [indices 14-15] (SurfaceRenderer.ts:537)
│   └── RenderManager.getScreenSize()
│       └── Canvas/window dimensions
│
├── viewport bounds [indices 16-19] (SurfaceRenderer.ts:538-542)
│   └── Camera2d.getWorldViewport() + margin (SurfaceRenderer.ts:323-336)
│       └── Camera2d.getWorldViewport() (Camera2d.ts:247-277)
│           ├── position (see above)
│           ├── zoom (see above)
│           └── screenSize (see above)
│
├── hasTerrainData [index 21] (SurfaceRenderer.ts:197)
│   └── Boolean: terrainTexture exists
│
├── shallowThreshold [index 22] (SurfaceRenderer.ts:199)
│   └── SHALLOW_WATER_THRESHOLD constant (SurfaceRenderer.ts:55)
│       └── Value: 1.2
│
├── texture dimensions [indices 23-28] (SurfaceRenderer.ts:150-167, 201-206)
│   ├── waterTextureWidth/Height
│   │   └── config.scale × screenSize (SurfaceRenderer.ts:150-154)
│   ├── terrainTextureWidth/Height
│   │   └── config.scale × screenSize (SurfaceRenderer.ts:160-164)
│   └── wetnessTextureWidth/Height
│       └── WetnessRenderPipeline texture dimensions
│
└── wetness viewport bounds [indices 31-34] (SurfaceRenderer.ts:532-533)
    └── WetnessRenderPipeline.getSnappedViewport() (WetnessRenderPipeline.ts:326-328)
        └── Internal viewport calculation based on camera
```

---

## Binding 2: Water Data Texture (rgba32float)

### Texture Output Format

- R: wave height (displacement)
- G: wave normal X
- B: wave normal Y
- A: water depth

### Data Flow Tree

```
waterDataTexture (SurfaceRenderer.ts:518)
└── AnalyticalWaterRenderPipeline.getTexture() (AnalyticalWaterRenderPipeline.ts:268-270)
    └── AnalyticalWaterDataTileCompute output (AnalyticalWaterRenderPipeline.ts:88-95)
        └── AnalyticalWaterStateShader compute (AnalyticalWaterStateShader.ts:60-468)
            │
            ├── @group(0) @binding(0) params buffer (AnalyticalWaterRenderPipeline.ts:221-239)
            │   ├── viewport (left, top, width, height)
            │   │   └── SurfaceRenderer.getWaterViewport() (SurfaceRenderer.ts:323-336)
            │   │       └── Camera2d.getWorldViewport() + margin
            │   ├── time
            │   │   └── TimeOfDay.getTimeInSeconds()
            │   ├── depthConfig (nearDepth, farDepth, depthDecay)
            │   │   └── Constants from WaterConstants.ts
            │   └── tideHeight
            │       └── WaterInfo.getTideHeight() (WaterInfo.ts:519-522)
            │           └── calculateTideHeight() (WaterInfo.ts:252-259)
            │               └── TimeOfDay.getHour() (TimeOfDay.ts:98-100)
            │
            ├── @group(0) @binding(1) waveData buffer (AnalyticalWaterRenderPipeline.ts:211-212)
            │   └── WAVE_COMPONENTS constant array (WaterConstants.ts:18-32)
            │       └── Hardcoded wave parameters:
            │           ├── amplitude
            │           ├── wavelength
            │           ├── direction (x, y)
            │           ├── steepness
            │           └── speed
            │
            ├── @group(0) @binding(2) segments buffer (AnalyticalWaterRenderPipeline.ts:215)
            │   └── WaterInfo.collectShaderSegmentData() (WaterInfo.ts:480-514)
            │       └── WakeParticle entities (WaterInfo.ts:495-510)
            │           └── game.entities.getTagged("wake")
            │               └── WakeParticle.getShaderSegmentData()
            │                   ├── position (from physics body)
            │                   ├── width
            │                   ├── fadeInStart, fadeInEnd
            │                   ├── fadeOutStart, fadeOutEnd
            │                   └── velocityDirection
            │
            ├── @group(0) @binding(3) depthTexture (AnalyticalWaterRenderPipeline.ts:179-180)
            │   └── InfluenceFieldManager.getDepthTexture() (InfluenceFieldManager.ts:613-615)
            │       └── depthTexture (InfluenceFieldManager.ts:479-492)
            │           └── TerrainRenderPipeline depth readback (InfluenceFieldManager.ts:400-503)
            │               └── Terrain contour data (see Binding 3)
            │
            ├── @group(0) @binding(5) shadowBoundaries buffer (AnalyticalWaterRenderPipeline.ts:186-188)
            │   └── WavePhysicsManager.getShadowBuffers().boundariesBuffer (WavePhysicsManager.ts:119-121)
            │       └── ShadowGeometryBuffers.boundariesBuffer (ShadowGeometryBuffers.ts:176-178)
            │           └── buildShadowGeometry() (WavePhysicsManager.ts:67-71)
            │               └── computeShadowBoundaries()
            │                   └── silhouettePoints
            │                       └── computeAllSilhouettePoints() (WavePhysicsManager.ts:61-64)
            │                           └── CoastlineManager.getSilhouettePoints()
            │                               └── Land geometry from terrain
            │
            ├── @group(0) @binding(6) shadowPolygons buffer (AnalyticalWaterRenderPipeline.ts:189-191)
            │   └── WavePhysicsManager.getShadowBuffers().polygonsBuffer (ShadowGeometryBuffers.ts:183-185)
            │       └── buildShadowGeometry()
            │           └── computeShadowPolygons()
            │               └── silhouettePoints (see above)
            │
            ├── @group(0) @binding(7) shadowParams buffer (AnalyticalWaterRenderPipeline.ts:192-194)
            │   └── WavePhysicsManager.getShadowBuffers().paramsBuffer (ShadowGeometryBuffers.ts:190-192)
            │       └── shadowCount, coastlineCount
            │
            └── @group(0) @binding(8) coastlinePoints buffer (AnalyticalWaterRenderPipeline.ts:195-197)
                └── WavePhysicsManager.getShadowBuffers().coastlineBuffer (ShadowGeometryBuffers.ts:197-199)
                    └── CoastlineManager coastline points
                        └── Terrain boundary extraction
```

---

## Binding 3: Terrain Data Texture (rgba32float)

### Texture Output Format

- R: terrain elevation/height
- G: terrain gradient X
- B: terrain gradient Y
- A: terrain type/flags

### Data Flow Tree

```
terrainDataTexture (SurfaceRenderer.ts:519)
└── TerrainRenderPipeline.getTexture() (TerrainRenderPipeline.ts:304-306)
    └── TerrainRenderPipeline output texture (TerrainRenderPipeline.ts:76-85)
        └── TerrainStateShader compute
            │
            ├── Contour data
            │   └── TerrainInfo.getContours() (TerrainInfo.ts:227-229)
            │       └── contours array (TerrainInfo.ts:109-111)
            │           └── TerrainDefinition (constructor parameter)
            │               └── Level file JSON (resources/levels/*.terrain.json)
            │                   └── Terrain Editor output
            │                       └── User-created contour splines
            │
            └── Viewport/params
                └── SurfaceRenderer.getTerrainViewport()
                    └── Camera2d.getWorldViewport() + margin
```

### Level File Source

```
TerrainDefinition (SurfaceRenderer.ts:483-488)
└── Level JSON file
    └── resources/levels/default.terrain.json
        └── Terrain Editor (src/editor/)
            ├── EditorController (EditorController.ts)
            │   └── Document state management
            ├── ContourEditor
            │   └── Mouse interaction for control points
            └── User input
                └── Click/drag to create/edit contour splines
```

---

## Binding 4: Wetness Texture (r32float)

### Texture Output Format

- R: wetness value (0.0 = dry, 1.0 = wet)

### Data Flow Tree

```
wetnessTexture (SurfaceRenderer.ts:520)
└── WetnessRenderPipeline.getTexture() (WetnessRenderPipeline.ts:300-306)
    └── Ping-pong texture output (WetnessRenderPipeline.ts:115-135)
        └── WetnessShader compute
            │
            ├── @binding(0) water texture (WetnessRenderPipeline.ts:213)
            │   └── SurfaceRenderer.getWaterTexture() (SurfaceRenderer.ts:521)
            │       └── AnalyticalWaterRenderPipeline.getTexture()
            │           └── (see Binding 2 above)
            │
            ├── @binding(1) terrain texture (WetnessRenderPipeline.ts:213)
            │   └── SurfaceRenderer.getTerrainTexture() (SurfaceRenderer.ts:522)
            │       └── TerrainRenderPipeline.getTexture()
            │           └── (see Binding 3 above)
            │
            ├── @binding(2) previous wetness texture (ping-pong)
            │   └── WetnessRenderPipeline internal
            │       └── Previous frame's wetness output
            │
            ├── dt (delta time) (SurfaceRenderer.ts:523)
            │   └── Game frame time
            │       └── Game.onRender() delta
            │
            ├── wettingRate constant (WetnessRenderPipeline.ts:58)
            │   └── Value: 2.0
            │
            └── dryingRate constant (WetnessRenderPipeline.ts:59)
                └── Value: 0.15
```

---

## Binding 1: Water Sampler

```
waterSampler (SurfaceShader.ts:19)
└── device.createSampler() (SurfaceRenderer.ts:123-127)
    └── Configuration:
        ├── magFilter: "linear"
        ├── minFilter: "linear"
        └── addressMode: "clamp-to-edge"
```

---

## Deep Origin Summary

### User Input Sources

| Data             | Origin                                |
| ---------------- | ------------------------------------- |
| Camera position  | Mouse drag / entity follow            |
| Camera zoom      | Scroll wheel                          |
| Render mode      | Debug UI toggle                       |
| Terrain contours | Terrain Editor (saved to level files) |

### Computed/Derived Sources

| Data            | Computed From                        |
| --------------- | ------------------------------------ |
| Time            | Accumulated tick deltas              |
| Tide height     | Time of day (hour)                   |
| Depth texture   | Terrain contour rasterization        |
| Shadow geometry | Coastline silhouette from terrain    |
| Wetness         | Water height vs terrain + time decay |

### Constant Sources

| Data                    | File                     | Line  |
| ----------------------- | ------------------------ | ----- |
| WAVE_COMPONENTS         | WaterConstants.ts        | 18-32 |
| SHALLOW_WATER_THRESHOLD | SurfaceRenderer.ts       | 55    |
| wettingRate             | WetnessRenderPipeline.ts | 58    |
| dryingRate              | WetnessRenderPipeline.ts | 59    |

### External Data Sources

| Data               | Source                |
| ------------------ | --------------------- |
| Terrain definition | Level JSON files      |
| Screen dimensions  | Browser window/canvas |

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            SurfaceShader                                │
├─────────────────────────────────────────────────────────────────────────┤
│  uniforms ◄──────── Camera, Time, Screen, Viewport, Config              │
│  waterSampler ◄──── Static sampler config                               │
│  waterDataTexture ◄─┬── AnalyticalWaterRenderPipeline                   │
│                     │   ├── WAVE_COMPONENTS (constants)                 │
│                     │   ├── WakeParticle segments (entities)            │
│                     │   ├── Depth texture ◄── InfluenceFieldManager     │
│                     │   │                     ◄── TerrainRenderPipeline │
│                     │   ├── Shadow geometry ◄── WavePhysicsManager      │
│                     │   │                       ◄── CoastlineManager    │
│                     │   │                       ◄── Terrain             │
│                     │   └── Tide height ◄── TimeOfDay                   │
│  terrainDataTexture ◄── TerrainRenderPipeline                           │
│                         ◄── TerrainInfo.contours                        │
│                         ◄── Level JSON file                             │
│  wetnessTexture ◄───┬── WetnessRenderPipeline                           │
│                     │   ├── Water texture (above)                       │
│                     │   ├── Terrain texture (above)                     │
│                     │   └── Previous wetness (ping-pong)                │
└─────────────────────────────────────────────────────────────────────────┘
```
