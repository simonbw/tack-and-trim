/**
 * Water surface rendering shader.
 *
 * Renders the water surface using:
 * - Combined wave + modifier height data from unified compute shader
 * - Optional terrain height data for depth-based sand/water blending
 * - Surface normal calculation from height gradients
 * - Fresnel, subsurface scattering, and specular lighting
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { WebGPUFullscreenQuad } from "../../../core/graphics/webgpu/WebGPUFullscreenQuad";
import { TERRAIN_TEXTURE_SIZE } from "../../terrain/TerrainConstants";
import { WATER_TEXTURE_SIZE } from "../WaterConstants";

// Terrain constants
const MAX_TERRAIN_HEIGHT = 20.0;
const SHALLOW_WATER_THRESHOLD = 1.5;

// WGSL water fragment shader with terrain support
const waterShaderSource = /*wgsl*/ `
struct Uniforms {
  cameraMatrix: mat3x3<f32>,
  time: f32,
  renderMode: i32,
  screenWidth: f32,
  screenHeight: f32,
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
  colorNoiseStrength: f32,
  hasTerrainData: i32,
  shallowThreshold: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var waterSampler: sampler;
@group(0) @binding(2) var waterDataTexture: texture_2d<f32>;
@group(0) @binding(3) var terrainDataTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const TEXTURE_SIZE: f32 = ${WATER_TEXTURE_SIZE}.0;
const TERRAIN_TEX_SIZE: f32 = ${TERRAIN_TEXTURE_SIZE}.0;
const MAX_TERRAIN_HEIGHT: f32 = ${MAX_TERRAIN_HEIGHT};

// Sample terrain height with bilinear filtering
// Returns signed height: negative = underwater depth, positive = above water
// Uses textureSampleLevel to avoid uniform control flow restrictions
fn sampleTerrain(uv: vec2<f32>) -> f32 {
  let clampedUV = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  // Use textureSampleLevel with mip level 0 for bilinear filtering without control flow issues
  return textureSampleLevel(terrainDataTexture, waterSampler, clampedUV, 0.0).r;
}

// Hash function for procedural noise
fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(234.34, 435.345));
  q = q + dot(q, q + 34.23);
  return fract(q.x * q.y);
}

// Render sand/beach surface
fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>) -> vec3<f32> {
  // Sand colors - wet near water, dry higher up
  let wetSand = vec3<f32>(0.76, 0.70, 0.50);
  let drySand = vec3<f32>(0.96, 0.91, 0.76);

  // Blend based on height above water
  let heightFactor = smoothstep(0.0, 3.0, height);
  var baseColor = mix(wetSand, drySand, heightFactor);

  // Add sandy texture noise
  let sandNoise = hash21(worldPos * 5.0) * 0.05;
  baseColor = baseColor + sandNoise;

  // Add darker grain noise
  let grainNoise = hash21(worldPos * 20.0) * 0.03 - 0.015;
  baseColor = baseColor + grainNoise;

  // Fixed midday sun
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));

  // Diffuse lighting
  let diffuse = max(dot(normal, sunDir), 0.0);

  // Combine with ambient
  let ambient = 0.7;
  let lit = baseColor * (ambient + diffuse * 0.3);

  return lit;
}

// Render water with depth information
fn renderWater(rawHeight: f32, normal: vec3<f32>, worldPos: vec2<f32>, waterDepth: f32) -> vec3<f32> {
  // Fixed midday sun
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));

  // Water colors - vary by depth
  let shallowWater = vec3<f32>(0.15, 0.55, 0.65);  // Light blue-green
  let deepWater = vec3<f32>(0.08, 0.32, 0.52);     // Darker blue
  let scatterColor = vec3<f32>(0.1, 0.45, 0.55);

  // Depth-based color (deeper = darker/more blue)
  let depthFactor = smoothstep(0.0, 10.0, waterDepth);
  var baseColor = mix(shallowWater, deepWater, depthFactor);

  // Slope-based color variation
  let sunFacing = dot(normal.xy, sunDir.xy);
  let slopeShift = mix(vec3<f32>(-0.02, -0.01, 0.02), vec3<f32>(0.02, 0.03, -0.01), sunFacing * 0.5 + 0.5);
  baseColor = baseColor + slopeShift * 0.08;

  // Troughs are darker
  let troughDarken = (1.0 - rawHeight) * 0.12;
  baseColor = baseColor * (1.0 - troughDarken);

  // Sun and sky colors
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let skyColor = vec3<f32>(0.5, 0.7, 0.95);

  // View direction (looking straight down)
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);

  // Fresnel effect
  let facing = dot(normal, viewDir);
  let fresnel = pow(1.0 - facing, 4.0) * 0.15;

  // Subsurface scattering
  let scatter = max(dot(normal, sunDir), 0.0) * (0.5 + 0.5 * rawHeight);
  let subsurface = scatterColor * scatter * 0.1;

  // Diffuse lighting
  let diffuse = max(dot(normal, sunDir), 0.0);

  // Specular
  let reflectDir = reflect(-sunDir, normal);
  let specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);

  // Combine lighting
  let ambient = baseColor * 0.75;
  let diffuseLight = baseColor * sunColor * diffuse * 0.15;
  let skyReflection = skyColor * fresnel * 0.1;
  let specularLight = sunColor * specular * 0.08;

  var color = ambient + subsurface + diffuseLight + skyReflection + specularLight;

  // Add high-frequency noise
  let fineNoise = hash21(worldPos * 2.0) * 0.02 - 0.01;
  color = color + fineNoise;

  return color;
}

@vertex
fn vs_main(@location(0) position: vec2<f32>) -> VertexOutput {
  var out: VertexOutput;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.clipPosition = position;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Convert clip space (-1,1) to screen coords (0, screenSize)
  let screenPos = (in.clipPosition * 0.5 + 0.5) * vec2<f32>(uniforms.screenWidth, uniforms.screenHeight);

  // Transform screen position to world position using camera matrix
  let worldPosH = uniforms.cameraMatrix * vec3<f32>(screenPos, 1.0);
  let worldPos = worldPosH.xy;

  // Map world position to data texture UV coordinates
  var dataUV = (worldPos - vec2<f32>(uniforms.viewportLeft, uniforms.viewportTop)) /
               vec2<f32>(uniforms.viewportWidth, uniforms.viewportHeight);
  dataUV = clamp(dataUV, vec2<f32>(0.0), vec2<f32>(1.0));

  // Sample the unified water data texture
  // R: combined height (waves + modifiers), normalized
  // G: dh/dt, normalized
  // B, A: reserved
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let rawHeight = waterData.r;

  // Sample terrain height (bilinear filtered)
  // terrainHeight is signed: negative = underwater, 0 = sea level, positive = land
  let terrainHeight = sampleTerrain(dataUV);

  // Calculate water depth (water surface height - terrain height)
  let waterSurfaceHeight = (rawHeight - 0.5) * 5.0;  // Denormalize to world units
  let waterDepth = waterSurfaceHeight - terrainHeight;

  // Debug mode: show terrain in brown, water in blue
  if (uniforms.renderMode == 1) {
    var debugColor: vec3<f32>;
    if (waterDepth < 0.0) {
      // Above water - terrain
      debugColor = vec3<f32>(0.6, 0.4, 0.2) * (terrainHeight / MAX_TERRAIN_HEIGHT + 0.3);
    } else {
      // Underwater - color by depth
      let darkBlue = vec3<f32>(0.0, 0.1, 0.3);
      let lightBlue = vec3<f32>(0.6, 0.85, 1.0);
      let depthFactor = smoothstep(0.0, 10.0, waterDepth);
      debugColor = mix(lightBlue, darkBlue, depthFactor);
    }
    return vec4<f32>(debugColor, 1.0);
  }

  // Compute water surface normal from height gradients
  let texelSize = 1.0 / TEXTURE_SIZE;
  let heightL = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(-texelSize, 0.0)).r;
  let heightR = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(texelSize, 0.0)).r;
  let heightD = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, -texelSize)).r;
  let heightU = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, texelSize)).r;

  let heightScale = 3.0;
  let waterNormal = normalize(vec3<f32>(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Compute terrain surface normal from height gradients
  let terrainL = sampleTerrain(dataUV + vec2<f32>(-texelSize, 0.0));
  let terrainR = sampleTerrain(dataUV + vec2<f32>(texelSize, 0.0));
  let terrainD = sampleTerrain(dataUV + vec2<f32>(0.0, -texelSize));
  let terrainU = sampleTerrain(dataUV + vec2<f32>(0.0, texelSize));

  let terrainNormal = normalize(vec3<f32>(
    (terrainL - terrainR) * 0.5,
    (terrainD - terrainU) * 0.5,
    1.0
  ));

  // Blend normals: use terrain normal on land, water normal in deep water, blend in shallow
  var normal: vec3<f32>;
  if (waterDepth < 0.0) {
    normal = terrainNormal;
  } else if (waterDepth < uniforms.shallowThreshold) {
    let blendFactor = waterDepth / uniforms.shallowThreshold;
    normal = normalize(mix(terrainNormal, waterNormal, blendFactor));
  } else {
    normal = waterNormal;
  }

  // Render based on water depth
  if (waterDepth < 0.0) {
    // Above water - render sand
    let sandColor = renderSand(terrainHeight, normal, worldPos);
    return vec4<f32>(sandColor, 1.0);
  } else if (waterDepth < uniforms.shallowThreshold) {
    // Shallow water - blend sand and water
    let blendFactor = smoothstep(0.0, uniforms.shallowThreshold, waterDepth);
    let sandColor = renderSand(terrainHeight, normal, worldPos);
    let waterColor = renderWater(rawHeight, normal, worldPos, waterDepth);
    let blendedColor = mix(sandColor, waterColor, blendFactor);
    return vec4<f32>(blendedColor, 1.0);
  } else {
    // Deep water
    let color = renderWater(rawHeight, normal, worldPos, waterDepth);
    return vec4<f32>(color, 1.0);
  }
}
`;

/**
 * Water surface rendering shader with terrain support.
 */
export class WaterShader {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  // Placeholder texture for when terrain is not available
  private placeholderTerrainTexture: GPUTexture | null = null;
  private placeholderTerrainView: GPUTextureView | null = null;

  // Uniform data
  private uniformData: Float32Array;

  // Cached bind group (recreated when texture changes)
  private bindGroup: GPUBindGroup | null = null;
  private lastWaterTexture: GPUTextureView | null = null;
  private lastTerrainTexture: GPUTextureView | null = null;

  constructor() {
    // Uniform buffer layout:
    // mat3x3 (3x vec4 = 48 bytes) + time (4) + renderMode (4) + screenSize (8) +
    // viewport (16) + colorNoiseStrength (4) + hasTerrainData (4) + shallowThreshold (4) = 92 bytes, round to 96
    this.uniformData = new Float32Array(24); // 96 bytes / 4

    // Default values
    this.uniformData[21] = 0; // hasTerrainData
    this.uniformData[22] = SHALLOW_WATER_THRESHOLD; // shallowThreshold
  }

  async init(): Promise<void> {
    const device = getWebGPU().device;

    // Create shader module
    const shaderModule = device.createShaderModule({
      code: waterShaderSource,
      label: "Water Shader",
    });

    // Create uniform buffer
    this.uniformBuffer = device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: "Water Uniform Buffer",
    });

    // Create sampler
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Create placeholder terrain texture (1x1 deep water = no terrain)
    // Must match terrain texture format (rgba32float)
    this.placeholderTerrainTexture = device.createTexture({
      size: { width: 1, height: 1 },
      format: "rgba32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: "Placeholder Terrain Texture",
    });
    this.placeholderTerrainView = this.placeholderTerrainTexture.createView();

    // Write deep water value (-50) to placeholder
    device.queue.writeTexture(
      { texture: this.placeholderTerrainTexture },
      new Float32Array([-50, 0, 0, 1]),
      { bytesPerRow: 16 },
      { width: 1, height: 1 }
    );

    // Create bind group layout (with terrain texture)
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: "float" },
        },
      ],
      label: "Water Bind Group Layout",
    });

    // Create pipeline
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
      label: "Water Pipeline Layout",
    });

    this.pipeline = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [WebGPUFullscreenQuad.getVertexBufferLayout()],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [
          {
            format: getWebGPU().preferredFormat,
          },
        ],
      },
      primitive: {
        topology: "triangle-list",
      },
      label: "Water Render Pipeline",
    });

    // Create fullscreen quad
    this.quad = new WebGPUFullscreenQuad();
  }

  /**
   * Set the camera inverse matrix (screen to world).
   */
  setCameraMatrix(matrix: Float32Array): void {
    // Pack mat3x3 with 16-byte alignment per column
    this.uniformData[0] = matrix[0];
    this.uniformData[1] = matrix[1];
    this.uniformData[2] = matrix[2];
    this.uniformData[3] = 0; // padding

    this.uniformData[4] = matrix[3];
    this.uniformData[5] = matrix[4];
    this.uniformData[6] = matrix[5];
    this.uniformData[7] = 0; // padding

    this.uniformData[8] = matrix[6];
    this.uniformData[9] = matrix[7];
    this.uniformData[10] = matrix[8];
    this.uniformData[11] = 0; // padding
  }

  setTime(time: number): void {
    this.uniformData[12] = time;
  }

  setRenderMode(mode: number): void {
    // Store as float, will be converted to int in shader
    this.uniformData[13] = mode;
  }

  setScreenSize(width: number, height: number): void {
    this.uniformData[14] = width;
    this.uniformData[15] = height;
  }

  setViewportBounds(
    left: number,
    top: number,
    width: number,
    height: number
  ): void {
    this.uniformData[16] = left;
    this.uniformData[17] = top;
    this.uniformData[18] = width;
    this.uniformData[19] = height;
  }

  setColorNoiseStrength(value: number): void {
    this.uniformData[20] = value;
  }

  setHasTerrainData(hasTerrain: boolean): void {
    this.uniformData[21] = hasTerrain ? 1 : 0;
  }

  setShallowThreshold(threshold: number): void {
    this.uniformData[22] = threshold;
  }

  /**
   * Render the water surface.
   */
  render(
    renderPass: GPURenderPassEncoder,
    waterTextureView: GPUTextureView,
    terrainTextureView?: GPUTextureView | null
  ): void {
    if (!this.pipeline || !this.quad || !this.uniformBuffer) {
      return;
    }

    const device = getWebGPU().device;

    // Use placeholder if no terrain texture
    const effectiveTerrainView =
      terrainTextureView ?? this.placeholderTerrainView!;
    this.setHasTerrainData(!!terrainTextureView);

    // Upload uniforms
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);

    // Recreate bind group if textures changed
    if (
      !this.bindGroup ||
      this.lastWaterTexture !== waterTextureView ||
      this.lastTerrainTexture !== effectiveTerrainView
    ) {
      this.bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: waterTextureView },
          { binding: 3, resource: effectiveTerrainView },
        ],
        label: "Water Bind Group",
      });
      this.lastWaterTexture = waterTextureView;
      this.lastTerrainTexture = effectiveTerrainView;
    }

    // Render
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    this.quad.render(renderPass);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.placeholderTerrainTexture?.destroy();
    this.quad?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
  }
}
