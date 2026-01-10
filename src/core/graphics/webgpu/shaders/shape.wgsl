// Shape shader: Renders untextured colored primitives
// Vertex attributes include per-vertex color and model matrix

struct Uniforms {
  // View matrix in column-major format for 3x3 matrix
  // Stored as 3x vec3 for alignment: [col0, col1, col2]
  viewMatrix: mat3x3<f32>,
}

struct VertexInput {
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) modelCol0: vec2<f32>, // Model matrix column 0: [a, b]
  @location(3) modelCol1: vec2<f32>, // Model matrix column 1: [c, d]
  @location(4) modelCol2: vec2<f32>, // Model matrix column 2: [tx, ty]
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

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
  out.color = in.color;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return in.color;
}
