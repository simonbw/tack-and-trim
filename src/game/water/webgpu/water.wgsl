// Water Surface Rendering Shader
// Renders realistic water surface with lighting and effects
// See WaterShaderGPU.ts for complete implementation

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
const TEXTURE_SIZE: f32 = 512.0;

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
  // Convert clip space to screen coords
  let screenPos = (in.clipPosition * 0.5 + 0.5) * vec2<f32>(uniforms.screenWidth, uniforms.screenHeight);

  // Transform to world position
  let worldPosH = uniforms.cameraMatrix * vec3<f32>(screenPos, 1.0);
  let worldPos = worldPosH.xy;

  // Map to texture UV
  var dataUV = (worldPos - vec2<f32>(uniforms.viewportLeft, uniforms.viewportTop)) /
               vec2<f32>(uniforms.viewportWidth, uniforms.viewportHeight);
  dataUV = clamp(dataUV, vec2<f32>(0.0), vec2<f32>(1.0));

  // Sample textures
  let waterData = textureSample(waterDataTexture, waterSampler, dataUV);
  let modifierData = textureSample(modifierDataTexture, waterSampler, dataUV);

  // Compute height
  let waveHeight = waterData.r;
  let modifierHeight = modifierData.r - 0.5;
  let rawHeight = waveHeight + modifierHeight;

  // Compute surface normal from gradients
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

  // Lighting
  let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));
  let viewDir = vec3<f32>(0.0, 0.0, 1.0);

  // Water colors
  let deepColor = vec3<f32>(0.08, 0.32, 0.52);
  let shallowColor = vec3<f32>(0.15, 0.50, 0.62);
  var baseColor = mix(deepColor, shallowColor, rawHeight);

  // Fresnel
  let facing = dot(normal, viewDir);
  let fresnel = pow(1.0 - facing, 4.0) * 0.15;

  // Diffuse and specular
  let diffuse = max(dot(normal, sunDir), 0.0);
  let reflectDir = reflect(-sunDir, normal);
  let specular = pow(max(dot(viewDir, reflectDir), 0.0), 64.0);

  // Combine
  let sunColor = vec3<f32>(1.0, 0.95, 0.85);
  let skyColor = vec3<f32>(0.5, 0.7, 0.95);

  var color = baseColor * 0.75
    + baseColor * sunColor * diffuse * 0.15
    + skyColor * fresnel * 0.1
    + sunColor * specular * 0.08;

  // Add noise
  let fineNoise = hash21(worldPos * 2.0) * 0.02 - 0.01;
  color = color + fineNoise;

  return vec4<f32>(color, 1.0);
}
