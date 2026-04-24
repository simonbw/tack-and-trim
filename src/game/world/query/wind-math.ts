/**
 * TypeScript port of the wind-query shader math.
 *
 * Mirrors `src/game/world/shaders/wind.wgsl.ts` and the simplex3D helper
 * in `src/game/world/shaders/noise.wgsl.ts`. Kept worker-safe: no DOM,
 * no BaseEntity, no imports from the wider codebase.
 *
 * Ported from the Ashima Arts / Stefan Gustavson GLSL simplex noise
 * (https://github.com/ashima/webgl-noise), converted via the WGSL
 * version in this project.
 *
 * The wind mesh lookup (`lookupWindMeshBlended`) lives in
 * `./wind-mesh-math.ts` — callers of `writeWindResult` pass the looked-up
 * speedFactor/directionOffset/turbulence as arguments.
 */

import {
  WIND_ANGLE_VARIATION,
  WIND_FLOW_CYCLE_PERIOD,
  WIND_NOISE_SPATIAL_SCALE,
  WIND_SLOW_TIME_SCALE,
  WIND_SPEED_VARIATION,
} from "../wind/WindConstants";

// ---------------------------------------------------------------------------
// simplex3D — line-for-line port of the WGSL implementation. Each WGSL
// `vec3`/`vec4` is represented as individual scalars suffixed `_0`, `_1`,
// `_2`, `_3` (or `x`/`y`/`z`). Comments quote the WGSL so it's easy to
// verify correspondence.
// ---------------------------------------------------------------------------

function mod289(x: number): number {
  return x - Math.floor(x * (1 / 289)) * 289;
}

function permute(x: number): number {
  return mod289((x * 34 + 10) * x);
}

function taylorInvSqrt(r: number): number {
  return 1.79284291400159 - 0.85373472095314 * r;
}

// Module-level scratch for 4-corner gradient reconstruction. Simplex3D
// runs in a single-threaded worker context, so shared state is safe.
const _gx: Float64Array = new Float64Array(4);
const _gy: Float64Array = new Float64Array(4);
const _gz: Float64Array = new Float64Array(4);

function gradCorner(
  p: number,
  corner: number,
  nsX: number,
  nsY: number,
  nsZ: number,
): void {
  // let j = p - 49 * floor(p * ns.z * ns.z);
  const j = p - 49 * Math.floor(p * nsZ * nsZ);
  // let x_ = floor(j * ns.z);
  // let y_ = floor(j - 7 * x_);
  const xFloor = Math.floor(j * nsZ);
  const yFloor = Math.floor(j - 7 * xFloor);
  // let x = x_ * ns.x + ns.yyyy;
  // let y = y_ * ns.x + ns.yyyy;
  const gxRaw = xFloor * nsX + nsY;
  const gyRaw = yFloor * nsX + nsY;
  // let h = 1 - abs(x) - abs(y);
  const h = 1 - Math.abs(gxRaw) - Math.abs(gyRaw);

  // s = floor(b)*2 + 1 (integer sign extraction)
  // sh = -step(h, 0) = h <= 0 ? -1 : 0
  const sx = Math.floor(gxRaw) * 2 + 1;
  const sy = Math.floor(gyRaw) * 2 + 1;
  const sh = h <= 0 ? -1 : 0;
  // a = b + s * sh
  _gx[corner] = gxRaw + sx * sh;
  _gy[corner] = gyRaw + sy * sh;
  _gz[corner] = h;
}

export function simplex3D(vx: number, vy: number, vz: number): number {
  // let C = vec2(1/6, 1/3);
  const Cx = 1 / 6;
  const Cy = 1 / 3;
  // let D = vec4(0.0, 0.5, 1.0, 2.0);
  // We'll reference D.x=0, D.y=0.5, D.z=1, D.w=2 by literals below.

  // var i = floor(v + dot(v, C.yyy));
  // let x0 = v - i + dot(i, C.xxx);
  const dotVCy = (vx + vy + vz) * Cy;
  const ix = Math.floor(vx + dotVCy);
  const iy = Math.floor(vy + dotVCy);
  const iz = Math.floor(vz + dotVCy);
  const dotICx = (ix + iy + iz) * Cx;
  const x0x = vx - ix + dotICx;
  const x0y = vy - iy + dotICx;
  const x0z = vz - iz + dotICx;

  // Other corners
  // let g = step(x0.yzx, x0.xyz);
  // step(a, b) = b >= a ? 1 : 0
  const gx = x0x >= x0y ? 1 : 0;
  const gy = x0y >= x0z ? 1 : 0;
  const gz = x0z >= x0x ? 1 : 0;
  // let l = 1.0 - g;
  const lx = 1 - gx;
  const ly = 1 - gy;
  const lz = 1 - gz;
  // let i1 = min(g.xyz, l.zxy);
  const i1x = Math.min(gx, lz);
  const i1y = Math.min(gy, lx);
  const i1z = Math.min(gz, ly);
  // let i2 = max(g.xyz, l.zxy);
  const i2x = Math.max(gx, lz);
  const i2y = Math.max(gy, lx);
  const i2z = Math.max(gz, ly);

  // let x1 = x0 - i1 + C.xxx;
  const x1x = x0x - i1x + Cx;
  const x1y = x0y - i1y + Cx;
  const x1z = x0z - i1z + Cx;
  // let x2 = x0 - i2 + C.yyy;
  const x2x = x0x - i2x + Cy;
  const x2y = x0y - i2y + Cy;
  const x2z = x0z - i2z + Cy;
  // let x3 = x0 - D.yyy;  (D.y = 0.5)
  const x3x = x0x - 0.5;
  const x3y = x0y - 0.5;
  const x3z = x0z - 0.5;

  // Permutations
  // i = mod289(i);
  const mix = mod289(ix);
  const miy = mod289(iy);
  const miz = mod289(iz);
  // let p = permute(permute(permute(
  //     i.z + vec4(0, i1.z, i2.z, 1))
  //   + i.y + vec4(0, i1.y, i2.y, 1))
  //   + i.x + vec4(0, i1.x, i2.x, 1));
  // Unrolled per-corner: k in {0,1,2,3} picks offsets (i1.*k, i2.*k, 1).
  const pz_0 = permute(miz + 0);
  const pz_1 = permute(miz + i1z);
  const pz_2 = permute(miz + i2z);
  const pz_3 = permute(miz + 1);

  const py_0 = permute(pz_0 + miy + 0);
  const py_1 = permute(pz_1 + miy + i1y);
  const py_2 = permute(pz_2 + miy + i2y);
  const py_3 = permute(pz_3 + miy + 1);

  const p_0 = permute(py_0 + mix + 0);
  const p_1 = permute(py_1 + mix + i1x);
  const p_2 = permute(py_2 + mix + i2x);
  const p_3 = permute(py_3 + mix + 1);

  // Gradients
  // let n_ = 1/7;
  // let ns = n_ * D.wyz - D.xzx;
  //        = (1/7) * vec3(2, 0.5, 1) - vec3(0, 1, 0)
  //        = vec3(2/7, 0.5/7 - 1, 1/7)
  //        = vec3(2/7, -13/14, 1/7)
  const nsX = 2 / 7;
  const nsY = -13 / 14;
  const nsZ = 1 / 7;

  // Per-corner gradient reconstruction. WGSL runs it as vec4s; we unroll
  // into four calls that write into module-level scratch vectors.
  gradCorner(p_0, 0, nsX, nsY, nsZ);
  gradCorner(p_1, 1, nsX, nsY, nsZ);
  gradCorner(p_2, 2, nsX, nsY, nsZ);
  gradCorner(p_3, 3, nsX, nsY, nsZ);

  // Normalise gradients
  const norm0 = taylorInvSqrt(
    _gx[0] * _gx[0] + _gy[0] * _gy[0] + _gz[0] * _gz[0],
  );
  const norm1 = taylorInvSqrt(
    _gx[1] * _gx[1] + _gy[1] * _gy[1] + _gz[1] * _gz[1],
  );
  const norm2 = taylorInvSqrt(
    _gx[2] * _gx[2] + _gy[2] * _gy[2] + _gz[2] * _gz[2],
  );
  const norm3 = taylorInvSqrt(
    _gx[3] * _gx[3] + _gy[3] * _gy[3] + _gz[3] * _gz[3],
  );
  const g0x = _gx[0] * norm0;
  const g0y = _gy[0] * norm0;
  const g0z = _gz[0] * norm0;
  const g1x = _gx[1] * norm1;
  const g1y = _gy[1] * norm1;
  const g1z = _gz[1] * norm1;
  const g2x = _gx[2] * norm2;
  const g2y = _gy[2] * norm2;
  const g2z = _gz[2] * norm2;
  const g3x = _gx[3] * norm3;
  const g3y = _gy[3] * norm3;
  const g3z = _gz[3] * norm3;

  // Mix final noise value
  // var m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0);
  // m = m * m;
  // return 42 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  const d0 = x0x * x0x + x0y * x0y + x0z * x0z;
  const d1 = x1x * x1x + x1y * x1y + x1z * x1z;
  const d2 = x2x * x2x + x2y * x2y + x2z * x2z;
  const d3 = x3x * x3x + x3y * x3y + x3z * x3z;
  const m0 = Math.max(0.6 - d0, 0);
  const m1 = Math.max(0.6 - d1, 0);
  const m2 = Math.max(0.6 - d2, 0);
  const m3 = Math.max(0.6 - d3, 0);
  const m0sq = m0 * m0;
  const m1sq = m1 * m1;
  const m2sq = m2 * m2;
  const m3sq = m3 * m3;
  const m0q = m0sq * m0sq;
  const m1q = m1sq * m1sq;
  const m2q = m2sq * m2sq;
  const m3q = m3sq * m3sq;

  const dot0 = g0x * x0x + g0y * x0y + g0z * x0z;
  const dot1 = g1x * x1x + g1y * x1y + g1z * x1z;
  const dot2 = g2x * x2x + g2y * x2y + g2z * x2z;
  const dot3 = g3x * x3x + g3y * x3y + g3z * x3z;

  return 42 * (m0q * dot0 + m1q * dot1 + m2q * dot2 + m3q * dot3);
}

// ---------------------------------------------------------------------------
// Wind velocity
// ---------------------------------------------------------------------------

/**
 * Port of `computeWindAtPoint` / `calculateWindVelocity` from
 * `shaders/wind.wgsl.ts`. Writes the four result floats directly to the
 * provided buffer at `resultOffset`.
 *
 * Layout matches WindResultLayout: [velocityX, velocityY, speed, direction].
 */
export function writeWindResult(
  worldX: number,
  worldY: number,
  time: number,
  baseWindX: number,
  baseWindY: number,
  influenceSpeedFactor: number,
  influenceDirectionOffset: number,
  influenceTurbulence: number,
  results: Float32Array,
  resultOffset: number,
): void {
  // Compute local flow velocity from terrain-modified wind
  const localFlowX = baseWindX * influenceSpeedFactor;
  const localFlowY = baseWindY * influenceSpeedFactor;
  const cosDir = Math.cos(influenceDirectionOffset);
  const sinDir = Math.sin(influenceDirectionOffset);
  const flowX = localFlowX * cosDir - localFlowY * sinDir;
  const flowY = localFlowX * sinDir + localFlowY * cosDir;

  // Dual-layer flow-map: two time phases offset by half a cycle
  const period = WIND_FLOW_CYCLE_PERIOD;
  const t0 = fract(time / period);
  const t1 = fract(time / period + 0.5);
  const blend = Math.abs(2 * t0 - 1);

  const slowTime = time * WIND_SLOW_TIME_SCALE;

  // Flow-advected UVs for speed noise
  const scale = WIND_NOISE_SPATIAL_SCALE;
  const uv0SpeedX = (worldX - flowX * t0 * period) * scale;
  const uv0SpeedY = (worldY - flowY * t0 * period) * scale;
  const uv1SpeedX = (worldX - flowX * t1 * period) * scale;
  const uv1SpeedY = (worldY - flowY * t1 * period) * scale;

  const speedNoise0 = simplex3D(uv0SpeedX, uv0SpeedY, slowTime);
  const speedNoise1 = simplex3D(uv1SpeedX, uv1SpeedY, slowTime);
  const speedNoise = speedNoise0 + (speedNoise1 - speedNoise0) * blend;

  // Flow-advected UVs for angle noise (offset for independent variation)
  const uv0AngleX = uv0SpeedX + 1000;
  const uv0AngleY = uv0SpeedY + 1000;
  const uv1AngleX = uv1SpeedX + 1000;
  const uv1AngleY = uv1SpeedY + 1000;

  const angleNoise0 = simplex3D(uv0AngleX, uv0AngleY, slowTime);
  const angleNoise1 = simplex3D(uv1AngleX, uv1AngleY, slowTime);
  const angleNoise = angleNoise0 + (angleNoise1 - angleNoise0) * blend;

  // Apply terrain influence to speed variation (turbulence boosts noise)
  const turbulenceBoost = 1 + influenceTurbulence * 0.5;
  let speedScale = 1 + speedNoise * WIND_SPEED_VARIATION * turbulenceBoost;
  speedScale *= influenceSpeedFactor;

  const totalAngleOffset =
    angleNoise * WIND_ANGLE_VARIATION + influenceDirectionOffset;

  const scaledX = baseWindX * speedScale;
  const scaledY = baseWindY * speedScale;

  const cosAngle = Math.cos(totalAngleOffset);
  const sinAngle = Math.sin(totalAngleOffset);
  const velocityX = scaledX * cosAngle - scaledY * sinAngle;
  const velocityY = scaledX * sinAngle + scaledY * cosAngle;

  const speed = Math.hypot(velocityX, velocityY);
  const direction = Math.atan2(velocityY, velocityX);

  results[resultOffset] = velocityX;
  results[resultOffset + 1] = velocityY;
  results[resultOffset + 2] = speed;
  results[resultOffset + 3] = direction;
}

function fract(x: number): number {
  return x - Math.floor(x);
}
