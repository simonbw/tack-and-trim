/**
 * Noise function shader modules.
 */

import type { ShaderModule } from "../../../core/graphics/webgpu/ShaderModule";

/**
 * Simplex 3D noise function.
 *
 * Provides simplex3D(v: vec3<f32>) -> f32
 * Returns a value in the range [-1, 1].
 *
 * Adapted from Ashima Arts / Stefan Gustavson GLSL implementation:
 * https://github.com/ashima/webgl-noise
 */
export const fn_simplex3D: ShaderModule = {
  code: /*wgsl*/ `
    // Internal helper functions for simplex3D
    fn _simplex3D_mod289_vec3(x: vec3<f32>) -> vec3<f32> {
      return x - floor(x * (1.0 / 289.0)) * 289.0;
    }

    fn _simplex3D_mod289_vec4(x: vec4<f32>) -> vec4<f32> {
      return x - floor(x * (1.0 / 289.0)) * 289.0;
    }

    fn _simplex3D_permute(x: vec4<f32>) -> vec4<f32> {
      return _simplex3D_mod289_vec4(((x * 34.0) + 10.0) * x);
    }

    fn _simplex3D_taylorInvSqrt(r: vec4<f32>) -> vec4<f32> {
      return 1.79284291400159 - 0.85373472095314 * r;
    }

    fn simplex3D(v: vec3<f32>) -> f32 {
      let C = vec2<f32>(1.0 / 6.0, 1.0 / 3.0);
      let D = vec4<f32>(0.0, 0.5, 1.0, 2.0);

      // First corner
      var i = floor(v + dot(v, C.yyy));
      let x0 = v - i + dot(i, C.xxx);

      // Other corners
      let g = step(x0.yzx, x0.xyz);
      let l = 1.0 - g;
      let i1 = min(g.xyz, l.zxy);
      let i2 = max(g.xyz, l.zxy);

      let x1 = x0 - i1 + C.xxx;
      let x2 = x0 - i2 + C.yyy;
      let x3 = x0 - D.yyy;

      // Permutations
      i = _simplex3D_mod289_vec3(i);
      let p = _simplex3D_permute(_simplex3D_permute(_simplex3D_permute(
          i.z + vec4<f32>(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4<f32>(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4<f32>(0.0, i1.x, i2.x, 1.0));

      // Gradients
      let n_ = 0.142857142857; // 1.0/7.0
      let ns = n_ * D.wyz - D.xzx;

      let j = p - 49.0 * floor(p * ns.z * ns.z);

      let x_ = floor(j * ns.z);
      let y_ = floor(j - 7.0 * x_);

      let x = x_ * ns.x + ns.yyyy;
      let y = y_ * ns.x + ns.yyyy;
      let h = 1.0 - abs(x) - abs(y);

      let b0 = vec4<f32>(x.xy, y.xy);
      let b1 = vec4<f32>(x.zw, y.zw);

      let s0 = floor(b0) * 2.0 + 1.0;
      let s1 = floor(b1) * 2.0 + 1.0;
      let sh = -step(h, vec4<f32>(0.0));

      let a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      let a1 = b1.xzyw + s1.xzyw * sh.zzww;

      var p0 = vec3<f32>(a0.xy, h.x);
      var p1 = vec3<f32>(a0.zw, h.y);
      var p2 = vec3<f32>(a1.xy, h.z);
      var p3 = vec3<f32>(a1.zw, h.w);

      // Normalise gradients
      let norm = _simplex3D_taylorInvSqrt(vec4<f32>(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
      p0 = p0 * norm.x;
      p1 = p1 * norm.y;
      p2 = p2 * norm.z;
      p3 = p3 * norm.w;

      // Mix final noise value
      var m = max(0.6 - vec4<f32>(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), vec4<f32>(0.0));
      m = m * m;
      return 42.0 * dot(m * m, vec4<f32>(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
    }
  `,
};

/**
 * 4-octave fractal noise built on simplex3D.
 *
 * Provides fractalNoise3D(pos: vec3<f32>) -> f32
 * Returns a value in approximately [-1, 1].
 */
export const fn_fractalNoise3D: ShaderModule = {
  dependencies: [fn_simplex3D],
  code: /*wgsl*/ `
    fn fractalNoise3D(pos: vec3<f32>) -> f32 {
      var n = 0.0;
      var amp = 0.5;
      var p = pos;
      for (var i = 0; i < 4; i++) {
        n += amp * simplex3D(p);
        p *= 2.0;
        amp *= 0.5;
      }
      return n;
    }
  `,
};
