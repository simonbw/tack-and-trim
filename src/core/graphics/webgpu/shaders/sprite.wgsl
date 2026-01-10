// Sprite shader: Renders textured quads with tinting
// Vertex attributes include per-vertex color/tint and model matrix

struct Uniforms {
  // View matrix in column-major format for 3x3 matrix
  viewMatrix: mat3x3<f32>,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) texCoord: vec2<f32>,
  @location(2) color: vec4<f32>,
  @location(3) modelCol0: vec2<f32>, // Model matrix column 0: [a, b]
  @location(4) modelCol1: vec2<f32>, // Model matrix column 1: [c, d]
  @location(5) modelCol2: vec2<f32>, // Model matrix column 2: [tx, ty]
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) texCoord: vec2<f32>,
  @location(1) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var textureSampler: sampler;
@group(1) @binding(0) var spriteTexture: texture_2d<f32>;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  // Reconstruct 3x3 model matrix from per-vertex attributes
  let modelMatrix = mat3x3<f32>(
    vec3<f32>(in.modelCol0.x, in.modelCol0.y, 0.0),
    vec3<f32>(in.modelCol1.x, in.modelCol1.y, 0.0),
    vec3<f32>(in.modelCol2.x, in.modelCol2.y, 1.0)
  );

  // Apply model transform
  let worldPos = modelMatrix * vec3<f32>(in.position, 1.0);

  // Apply view matrix
  let clipPos = uniforms.viewMatrix * worldPos;

  var out: VertexOutput;
  out.position = vec4<f32>(clipPos.xy, 0.0, 1.0);
  out.texCoord = in.texCoord;
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(spriteTexture, textureSampler, in.texCoord);
  return texColor * in.color;
}
