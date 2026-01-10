/**
 * WebGPU water surface rendering shader.
 *
 * Renders the water surface using:
 * - Wave height data from compute shader
 * - Modifier data (wakes) from CPU texture
 * - Surface normal calculation from height gradients
 * - Fresnel, subsurface scattering, and specular lighting
 */

import { getWebGPU } from "../../../core/graphics/webgpu/WebGPUDevice";
import { WebGPUFullscreenQuad } from "../../../core/graphics/webgpu/WebGPUFullscreenQuad";
import { WATER_TEXTURE_SIZE } from "../WaterConstants";

// WGSL water fragment shader
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
  _padding1: f32,
  _padding2: f32,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) clipPosition: vec2<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var waterSampler: sampler;
@group(0) @binding(2) var waterDataTexture: texture_2d<f32>;
@group(0) @binding(3) var modifierDataTexture: texture_2d<f32>;

const PI: f32 = 3.14159265359;
const TEXTURE_SIZE: f32 = ${WATER_TEXTURE_SIZE}.0;

// Hash function for procedural noise
fn hash21(p: vec2<f32>) -> f32 {
  var q = fract(p * vec2<f32>(234.34, 435.345));
  q = q + dot(q, q + 34.23);
  return fract(q.x * q.y);
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

  // Sample the data textures
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let modifierData = textureSample(modifierDataTexture, waterSampler, dataUV);

  // Unpack height
  let waveHeight = waterData.r;
  let modifierHeight = modifierData.r - 0.5;
  let rawHeight = waveHeight + modifierHeight;

  // Debug mode: height mapped to blue gradient
  if (uniforms.renderMode == 1) {
    var debugColor: vec3<f32>;
    if (rawHeight < 0.02) {
      debugColor = vec3<f32>(1.0, 0.0, 0.0);  // Red for min clipping
    } else if (rawHeight > 0.98) {
      debugColor = vec3<f32>(1.0, 0.0, 0.0);  // Red for max clipping
    } else {
      let darkBlue = vec3<f32>(0.0, 0.1, 0.3);
      let lightBlue = vec3<f32>(0.6, 0.85, 1.0);
      debugColor = mix(darkBlue, lightBlue, rawHeight);
    }
    return vec4<f32>(debugColor, 1.0);
  }

  // Compute surface normal from height gradients
  let texelSize = 1.0 / TEXTURE_SIZE;
  let heightL = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(-texelSize, 0.0)).r;
  let heightR = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(texelSize, 0.0)).r;
  let heightD = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, -texelSize)).r;
  let heightU = textureSample(waterDataTexture, waterSampler, dataUV + vec2<f32>(0.0, texelSize)).r;

  let heightScale = 3.0;
  let normal = normalize(vec3<f32>(
    (heightL - heightR) * heightScale,
    (heightD - heightU) * heightScale,
    1.0
  ));

  // Fixed midday sun
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));

  // Water colors
  let deepColor = vec3<f32>(0.08, 0.32, 0.52);
  let shallowColor = vec3<f32>(0.15, 0.50, 0.62);
  let scatterColor = vec3<f32>(0.1, 0.45, 0.55);
  var baseColor = mix(deepColor, shallowColor, rawHeight);

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

  return vec4<f32>(color, 1.0);
}
`;

/**
 * Water surface rendering shader using WebGPU.
 */
export class WaterShaderGPU {
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private quad: WebGPUFullscreenQuad | null = null;

  // Uniform data
  private uniformData: Float32Array;

  // Cached bind group (recreated when textures change)
  private bindGroup: GPUBindGroup | null = null;
  private lastWaterTexture: GPUTextureView | null = null;
  private lastModifierTexture: GPUTextureView | null = null;

  constructor() {
    // Uniform buffer layout:
    // mat3x3 (3x vec4 = 48 bytes) + time (4) + renderMode (4) + screenSize (8) +
    // viewport (16) + colorNoiseStrength (4) + padding (8) = 92 bytes, round to 96
    this.uniformData = new Float32Array(24); // 96 bytes / 4
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

    // Create bind group layout
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

  /**
   * Render the water surface.
   */
  render(
    renderPass: GPURenderPassEncoder,
    waterTextureView: GPUTextureView,
    modifierTextureView: GPUTextureView
  ): void {
    if (!this.pipeline || !this.quad || !this.uniformBuffer) {
      return;
    }

    const device = getWebGPU().device;

    // Upload uniforms
    device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData.buffer);

    // Recreate bind group if textures changed
    if (
      !this.bindGroup ||
      this.lastWaterTexture !== waterTextureView ||
      this.lastModifierTexture !== modifierTextureView
    ) {
      this.bindGroup = device.createBindGroup({
        layout: this.bindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: this.sampler! },
          { binding: 2, resource: waterTextureView },
          { binding: 3, resource: modifierTextureView },
        ],
        label: "Water Bind Group",
      });
      this.lastWaterTexture = waterTextureView;
      this.lastModifierTexture = modifierTextureView;
    }

    // Render
    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);
    this.quad.render(renderPass);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.quad?.destroy();
    this.pipeline = null;
    this.bindGroup = null;
  }
}
