/**
 * Shadow Texture Shader
 *
 * Renders shadow polygons with pre-computed Fresnel diffraction to a texture.
 * - Vertex shader: transforms polygon vertices from world space to clip space
 * - Fragment shader: computes wave energy attenuation for each pixel
 *
 * This shader computes the diffraction pattern once and stores the result.
 * The water shader then samples this pre-computed attenuation.
 *
 * Output format: rg16float
 * - R channel: Swell wave attenuation (0.0 = full shadow, 1.0 = full energy)
 * - G channel: Chop wave attenuation
 */

import { FullscreenShader } from "../../core/graphics/webgpu/FullscreenShader";
import { fresnelDiffractionModule } from "../world/shaders/fresnel-diffraction.wgsl";

// Wavelength constants for swell and chop waves
const SWELL_WAVELENGTH = 200.0; // feet
const CHOP_WAVELENGTH = 30.0; // feet

const bindings = {
  uniforms: { type: "uniform" },
  shadowData: { type: "storage" },
} as const;

/**
 * Shadow texture shader for rendering wave diffraction patterns.
 * Uses FullscreenShader base class with custom vertex/fragment WGSL code.
 */
export class ShadowTextureShader extends FullscreenShader<typeof bindings> {
  readonly bindings = bindings;

  protected vertexModules = [];
  protected fragmentModules = [fresnelDiffractionModule];

  /**
   * Get the complete shader code for manual pipeline creation.
   * Used by ShadowTextureRenderer which needs custom vertex buffer layout.
   */
  getShaderCode(): string {
    return (
      this.getMathConstants() +
      "\n\n" +
      this.buildAllModuleCode() +
      "\n\n" +
      this.vertexMainCode +
      "\n\n" +
      this.fragmentMainCode
    );
  }

  protected vertexMainCode = /*wgsl*/ `
struct Uniforms {
  viewportLeft: f32,
  viewportTop: f32,
  viewportWidth: f32,
  viewportHeight: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> shadowData: ShadowData;

// Per-polygon shadow data for Fresnel diffraction calculation
struct PolygonShadowData {
  leftSilhouette: vec2<f32>,
  rightSilhouette: vec2<f32>,
  obstacleWidth: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
}

// Shadow data storage buffer
struct ShadowData {
  waveDirection: vec2<f32>,
  polygonCount: u32,
  _padding: u32,
  polygons: array<PolygonShadowData>,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) polygonIndex: u32,
}

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPosition: vec2<f32>,
  @location(1) @interpolate(flat) polygonIndex: u32,
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;

  // Transform world position to normalized device coordinates (0 to 1)
  let normalizedX = (input.position.x - uniforms.viewportLeft) / uniforms.viewportWidth;
  let normalizedY = (input.position.y - uniforms.viewportTop) / uniforms.viewportHeight;

  // Convert to clip space (-1 to 1)
  // Flip Y so texture is right-side-up relative to world coordinates
  let clipX = normalizedX * 2.0 - 1.0;
  let clipY = 1.0 - normalizedY * 2.0;

  output.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
  output.worldPosition = input.position;
  output.polygonIndex = input.polygonIndex;

  return output;
}
`;

  protected fragmentMainCode = /*wgsl*/ `
const SWELL_WAVELENGTH: f32 = ${SWELL_WAVELENGTH};
const CHOP_WAVELENGTH: f32 = ${CHOP_WAVELENGTH};

struct FragmentInput {
  @location(0) worldPosition: vec2<f32>,
  @location(1) @interpolate(flat) polygonIndex: u32,
}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
  // Get polygon diffraction parameters
  let polygon = shadowData.polygons[input.polygonIndex];
  let waveDir = shadowData.waveDirection;
  let perpRight = vec2<f32>(waveDir.y, -waveDir.x);

  // Compute distances to both shadow boundaries
  let toLeft = input.worldPosition - polygon.leftSilhouette;
  let toRight = input.worldPosition - polygon.rightSilhouette;

  let distToLeft = abs(dot(toLeft, perpRight));
  let distToRight = abs(dot(toRight, perpRight));
  let distBehindLeft = dot(toLeft, waveDir);
  let distBehindRight = dot(toRight, waveDir);

  // Use closer boundary for diffraction calculation
  let distToBoundary = min(distToLeft, distToRight);
  let distBehind = max((distBehindLeft + distBehindRight) * 0.5, 0.0);

  // Compute Fresnel diffraction for both wavelength classes
  let swellBase = computeFresnelEnergy(distToBoundary, distBehind, SWELL_WAVELENGTH);
  let chopBase = computeFresnelEnergy(distToBoundary, distBehind, CHOP_WAVELENGTH);

  // Shadow recovery: waves gradually return to full strength far behind obstacle
  let swellRecoveryDist = polygon.obstacleWidth * polygon.obstacleWidth / SWELL_WAVELENGTH;
  let chopRecoveryDist = polygon.obstacleWidth * polygon.obstacleWidth / CHOP_WAVELENGTH;

  let swellRecovery = smoothstep(0.5 * swellRecoveryDist, swellRecoveryDist, distBehind);
  let chopRecovery = smoothstep(0.5 * chopRecoveryDist, chopRecoveryDist, distBehind);

  // Mix toward full energy at recovery distance
  let swellAttenuation = mix(swellBase, 1.0, swellRecovery);
  let chopAttenuation = mix(chopBase, 1.0, chopRecovery);

  // Output energy attenuation factors
  // R = swell, G = chop, BA unused
  return vec4<f32>(swellAttenuation, chopAttenuation, 0.0, 1.0);
}
`;
}
