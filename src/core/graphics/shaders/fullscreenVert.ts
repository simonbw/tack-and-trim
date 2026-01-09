/**
 * Standard fullscreen vertex shader.
 * Passes through clip-space position and provides UV coordinates.
 *
 * Outputs:
 * - v_position: clip-space position [-1, 1]
 * - v_uv: texture coordinates [0, 1]
 */
export const FULLSCREEN_VERTEX_SHADER = /*glsl*/ `#version 300 es
precision highp float;

in vec2 a_position;

out vec2 v_position;
out vec2 v_uv;

void main() {
  v_position = a_position;
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;
