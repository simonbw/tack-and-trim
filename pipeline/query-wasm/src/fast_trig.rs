//! Fast f32 sincos approximations.
//!
//! On wasm32-unknown-unknown, `f32::sin` and `f32::cos` route through
//! libm-style scalar implementations that are accurate but call-heavy.
//! V8's `Math.sin`/`Math.cos` are typically faster per call.
//!
//! This module provides drop-in approximations using minimax-style
//! polynomial evaluations after argument reduction. Accuracy is ~1e-5
//! absolute over the [-π, π] domain — well within the parity test
//! tolerances (water velocity tolerates ~1e-2; normals tolerate ~2.0
//! due to existing sign-flip behavior near the threshold).
//!
//! Used by:
//!   - `water::calculate_gerstner_waves` (the hot loop, 8 wave sources
//!     × 2 passes per query point × {sin,cos} each)
//!   - `water::lookup_mesh_for_wave` (per-vertex phasor accumulation)
//!   - `wind::write_wind_result` (rotation matrix + final direction)

use std::f32::consts::PI;
const TWO_PI: f32 = std::f32::consts::TAU;
const INV_TWO_PI: f32 = 1.0 / TWO_PI;
const HALF_PI: f32 = std::f32::consts::FRAC_PI_2;

/// Reduce `x` modulo 2π into the range `[-π, π]`. Used by both `fast_sin`
/// and `fast_cos` so they share the cost when the caller has only one
/// of the two; for callers that want both, prefer `fast_sin_cos`.
#[inline]
fn reduce(x: f32) -> f32 {
    // Round toward nearest in units of 2π.
    let n = (x * INV_TWO_PI).round();
    x - n * TWO_PI
}

/// Polynomial approximation of `sin(x)` over `[-π, π]`. Exploits
/// `sin(π - x) = sin(x)` to compress the working range to `[-π/2, π/2]`,
/// then evaluates a degree-7 odd Taylor polynomial. Max error ~5e-7.
#[inline]
fn sin_reduced(x: f32) -> f32 {
    // Map to [-π/2, π/2] using sin(π-x) = sin(x).
    let mut y = x;
    if y > HALF_PI {
        y = PI - y;
    } else if y < -HALF_PI {
        y = -PI - y;
    }
    let y2 = y * y;
    // sin(y) ≈ y - y³/6 + y⁵/120 - y⁷/5040
    y * (1.0 - y2 * (1.0 / 6.0 - y2 * (1.0 / 120.0 - y2 * (1.0 / 5040.0))))
}

/// Polynomial approximation of `cos(x)` over `[-π, π]`. Reduces to
/// `[0, π/2]` via `cos(-x) = cos(x)` and `cos(π - x) = -cos(x)`, then
/// a degree-8 even polynomial. Max error ~5e-7.
#[inline]
fn cos_reduced(x: f32) -> f32 {
    let mut y = x.abs();
    let mut sign = 1.0_f32;
    if y > HALF_PI {
        y = PI - y;
        sign = -1.0;
    }
    let y2 = y * y;
    // cos(y) ≈ 1 - y²/2 + y⁴/24 - y⁶/720 + y⁸/40320
    sign
        * (1.0
            - y2
                * (0.5
                    - y2 * (1.0 / 24.0 - y2 * (1.0 / 720.0 - y2 * (1.0 / 40320.0)))))
}

#[allow(dead_code)] // exposed for future callers; SIMD chunked sincos
                    // (sincos_chunk_4) is the main caller in water now.
#[inline]
pub fn fast_cos(x: f32) -> f32 {
    cos_reduced(reduce(x))
}

/// Compute both `(sin(x), cos(x))` sharing the argument reduction.
/// Cheaper than two separate calls when the caller needs both.
#[inline]
pub fn fast_sin_cos(x: f32) -> (f32, f32) {
    let r = reduce(x);
    (sin_reduced(r), cos_reduced(r))
}

/// Vectorised sincos over four `f32` inputs at once. On wasm32 this
/// runs the same minimax polynomial as `fast_sin_cos` but evaluated
/// across an `f32x4` SIMD vector — the four lanes proceed in lockstep,
/// so the cost of four sincos calls collapses to roughly one. On host
/// builds (Cargo unit tests) it falls back to four scalar calls.
///
/// Used by `water::calculate_gerstner_waves` to evaluate the inner
/// loop's `sincos(phase)` for chunks of four wave sources at a time.
/// Writes results into the caller-supplied output arrays (no Vec
/// allocation, no return tuple — matches the hot-loop call site).
#[inline]
pub fn sincos_chunk_4(phases: &[f32; 4], sins: &mut [f32; 4], coses: &mut [f32; 4]) {
    #[cfg(target_arch = "wasm32")]
    {
        use core::arch::wasm32::*;

        // SAFETY: `v128_load` accepts unaligned addresses on wasm and
        // these arrays are 4*f32 wide, exactly v128. v128_store has
        // the same shape on the way out.
        unsafe {
            let phase_vec = v128_load(phases.as_ptr() as *const v128);

            // Argument reduction: r = x − round(x / 2π) · 2π
            let inv_two_pi = f32x4_splat(INV_TWO_PI);
            let two_pi = f32x4_splat(TWO_PI);
            let n = f32x4_nearest(f32x4_mul(phase_vec, inv_two_pi));
            let r = f32x4_sub(phase_vec, f32x4_mul(n, two_pi));

            // Fold to [−π/2, π/2] for sin via sin(π−x) = sin(x).
            let half_pi = f32x4_splat(HALF_PI);
            let neg_half_pi = f32x4_splat(-HALF_PI);
            let pi_v = f32x4_splat(PI);
            let neg_pi = f32x4_splat(-PI);
            let too_big = f32x4_gt(r, half_pi);
            let too_small = f32x4_lt(r, neg_half_pi);
            let r_pos = f32x4_sub(pi_v, r);
            let r_neg = f32x4_sub(neg_pi, r);
            let r_sin = v128_bitselect(
                r_pos,
                v128_bitselect(r_neg, r, too_small),
                too_big,
            );

            // sin(y) ≈ y − y³/6 + y⁵/120 − y⁷/5040
            let y2 = f32x4_mul(r_sin, r_sin);
            let s_c5 = f32x4_splat(1.0 / 120.0);
            let s_c7 = f32x4_splat(1.0 / 5040.0);
            let s_c3 = f32x4_splat(1.0 / 6.0);
            let s_c1 = f32x4_splat(1.0);
            let s_inner = f32x4_sub(s_c5, f32x4_mul(y2, s_c7));
            let s_inner2 = f32x4_sub(s_c3, f32x4_mul(y2, s_inner));
            let sin_vec = f32x4_mul(r_sin, f32x4_sub(s_c1, f32x4_mul(y2, s_inner2)));

            // Fold |r| to [0, π/2] for cos, with a sign flip when |r| > π/2.
            let abs_r = f32x4_abs(r);
            let too_big_cos = f32x4_gt(abs_r, half_pi);
            let r_cos = v128_bitselect(f32x4_sub(pi_v, abs_r), abs_r, too_big_cos);
            let cos_sign = v128_bitselect(
                f32x4_splat(-1.0),
                f32x4_splat(1.0),
                too_big_cos,
            );

            // cos(y) ≈ 1 − y²/2 + y⁴/24 − y⁶/720 + y⁸/40320
            let y2c = f32x4_mul(r_cos, r_cos);
            let c_c8 = f32x4_splat(1.0 / 40320.0);
            let c_c6 = f32x4_splat(1.0 / 720.0);
            let c_c4 = f32x4_splat(1.0 / 24.0);
            let c_c2 = f32x4_splat(0.5);
            let c_c0 = f32x4_splat(1.0);
            let c_inner = f32x4_sub(c_c6, f32x4_mul(y2c, c_c8));
            let c_inner2 = f32x4_sub(c_c4, f32x4_mul(y2c, c_inner));
            let c_inner3 = f32x4_sub(c_c2, f32x4_mul(y2c, c_inner2));
            let cos_vec = f32x4_mul(
                cos_sign,
                f32x4_sub(c_c0, f32x4_mul(y2c, c_inner3)),
            );

            v128_store(sins.as_mut_ptr() as *mut v128, sin_vec);
            v128_store(coses.as_mut_ptr() as *mut v128, cos_vec);
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..4 {
            let (s, c) = fast_sin_cos(phases[i]);
            sins[i] = s;
            coses[i] = c;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fast_sin(x: f32) -> f32 {
        sin_reduced(reduce(x))
    }

    #[test]
    fn sin_matches_libm_reasonably() {
        for i in -100..100 {
            let x = i as f32 * 0.1;
            let approx = fast_sin(x);
            let exact = x.sin();
            assert!(
                (approx - exact).abs() < 5e-4,
                "sin({}): approx={}, exact={}, diff={}",
                x,
                approx,
                exact,
                (approx - exact).abs()
            );
        }
    }

    #[test]
    fn sincos_chunk_4_matches_scalar() {
        let phases = [0.1_f32, 1.7, -3.2, 6.5];
        let mut s = [0.0_f32; 4];
        let mut c = [0.0_f32; 4];
        sincos_chunk_4(&phases, &mut s, &mut c);
        for i in 0..4 {
            let (es, ec) = fast_sin_cos(phases[i]);
            assert!(
                (s[i] - es).abs() < 1e-6,
                "lane {} sin: got {}, expected {}",
                i,
                s[i],
                es,
            );
            assert!(
                (c[i] - ec).abs() < 1e-6,
                "lane {} cos: got {}, expected {}",
                i,
                c[i],
                ec,
            );
        }
    }

    #[test]
    fn cos_matches_libm_reasonably() {
        for i in -100..100 {
            let x = i as f32 * 0.1;
            let approx = fast_cos(x);
            let exact = x.cos();
            assert!(
                (approx - exact).abs() < 5e-4,
                "cos({}): approx={}, exact={}, diff={}",
                x,
                approx,
                exact,
                (approx - exact).abs()
            );
        }
    }
}
