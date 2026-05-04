//! 3D simplex noise (Ashima/Gustavson formulation).
//!
//! Produces values approximately in [-1, 1]. Used for water amplitude
//! modulation and wind speed/direction variation.

#[inline]
fn mod289(x: f32) -> f32 {
    x - (x * (1.0 / 289.0)).floor() * 289.0
}

#[inline]
fn permute(x: f32) -> f32 {
    mod289((x * 34.0 + 10.0) * x)
}

#[inline]
fn taylor_inv_sqrt(r: f32) -> f32 {
    1.792_842_9 - 0.853_734_7 * r
}

/// Reconstruct a single corner gradient. Mirrors the WGSL inner block.
#[inline]
fn grad_corner(p: f32, ns_x: f32, ns_y: f32, ns_z: f32) -> (f32, f32, f32) {
    let j = p - 49.0 * (p * ns_z * ns_z).floor();
    let x_floor = (j * ns_z).floor();
    let y_floor = (j - 7.0 * x_floor).floor();
    let gx_raw = x_floor * ns_x + ns_y;
    let gy_raw = y_floor * ns_x + ns_y;
    let h = 1.0 - gx_raw.abs() - gy_raw.abs();

    let sx = gx_raw.floor() * 2.0 + 1.0;
    let sy = gy_raw.floor() * 2.0 + 1.0;
    let sh = if h <= 0.0 { -1.0 } else { 0.0 };
    (gx_raw + sx * sh, gy_raw + sy * sh, h)
}

/// Simplex 3D noise. Output approximately in [-1, 1].
pub fn simplex3d(vx: f32, vy: f32, vz: f32) -> f32 {
    let cx = 1.0 / 6.0;
    let cy = 1.0 / 3.0;

    let dot_v_cy = (vx + vy + vz) * cy;
    let ix = (vx + dot_v_cy).floor();
    let iy = (vy + dot_v_cy).floor();
    let iz = (vz + dot_v_cy).floor();
    let dot_i_cx = (ix + iy + iz) * cx;
    let x0x = vx - ix + dot_i_cx;
    let x0y = vy - iy + dot_i_cx;
    let x0z = vz - iz + dot_i_cx;

    // Other corners
    let gx: f32 = if x0x >= x0y { 1.0 } else { 0.0 };
    let gy: f32 = if x0y >= x0z { 1.0 } else { 0.0 };
    let gz: f32 = if x0z >= x0x { 1.0 } else { 0.0 };
    let lx: f32 = 1.0 - gx;
    let ly: f32 = 1.0 - gy;
    let lz: f32 = 1.0 - gz;
    let i1x = gx.min(lz);
    let i1y = gy.min(lx);
    let i1z = gz.min(ly);
    let i2x = gx.max(lz);
    let i2y = gy.max(lx);
    let i2z = gz.max(ly);

    let x1x = x0x - i1x + cx;
    let x1y = x0y - i1y + cx;
    let x1z = x0z - i1z + cx;
    let x2x = x0x - i2x + cy;
    let x2y = x0y - i2y + cy;
    let x2z = x0z - i2z + cy;
    let x3x = x0x - 0.5;
    let x3y = x0y - 0.5;
    let x3z = x0z - 0.5;

    let mix = mod289(ix);
    let miy = mod289(iy);
    let miz = mod289(iz);

    let pz_0 = permute(miz);
    let pz_1 = permute(miz + i1z);
    let pz_2 = permute(miz + i2z);
    let pz_3 = permute(miz + 1.0);

    let py_0 = permute(pz_0 + miy);
    let py_1 = permute(pz_1 + miy + i1y);
    let py_2 = permute(pz_2 + miy + i2y);
    let py_3 = permute(pz_3 + miy + 1.0);

    let p_0 = permute(py_0 + mix);
    let p_1 = permute(py_1 + mix + i1x);
    let p_2 = permute(py_2 + mix + i2x);
    let p_3 = permute(py_3 + mix + 1.0);

    let ns_x = 2.0 / 7.0;
    let ns_y = -13.0 / 14.0;
    let ns_z = 1.0 / 7.0;

    let (g0_x, g0_y, g0_z) = grad_corner(p_0, ns_x, ns_y, ns_z);
    let (g1_x, g1_y, g1_z) = grad_corner(p_1, ns_x, ns_y, ns_z);
    let (g2_x, g2_y, g2_z) = grad_corner(p_2, ns_x, ns_y, ns_z);
    let (g3_x, g3_y, g3_z) = grad_corner(p_3, ns_x, ns_y, ns_z);

    let norm0 = taylor_inv_sqrt(g0_x * g0_x + g0_y * g0_y + g0_z * g0_z);
    let norm1 = taylor_inv_sqrt(g1_x * g1_x + g1_y * g1_y + g1_z * g1_z);
    let norm2 = taylor_inv_sqrt(g2_x * g2_x + g2_y * g2_y + g2_z * g2_z);
    let norm3 = taylor_inv_sqrt(g3_x * g3_x + g3_y * g3_y + g3_z * g3_z);

    let g0_x = g0_x * norm0;
    let g0_y = g0_y * norm0;
    let g0_z = g0_z * norm0;
    let g1_x = g1_x * norm1;
    let g1_y = g1_y * norm1;
    let g1_z = g1_z * norm1;
    let g2_x = g2_x * norm2;
    let g2_y = g2_y * norm2;
    let g2_z = g2_z * norm2;
    let g3_x = g3_x * norm3;
    let g3_y = g3_y * norm3;
    let g3_z = g3_z * norm3;

    let d0 = x0x * x0x + x0y * x0y + x0z * x0z;
    let d1 = x1x * x1x + x1y * x1y + x1z * x1z;
    let d2 = x2x * x2x + x2y * x2y + x2z * x2z;
    let d3 = x3x * x3x + x3y * x3y + x3z * x3z;
    let m0 = (0.6 - d0).max(0.0);
    let m1 = (0.6 - d1).max(0.0);
    let m2 = (0.6 - d2).max(0.0);
    let m3 = (0.6 - d3).max(0.0);
    let m0_q = m0 * m0 * m0 * m0;
    let m1_q = m1 * m1 * m1 * m1;
    let m2_q = m2 * m2 * m2 * m2;
    let m3_q = m3 * m3 * m3 * m3;

    let dot0 = g0_x * x0x + g0_y * x0y + g0_z * x0z;
    let dot1 = g1_x * x1x + g1_y * x1y + g1_z * x1z;
    let dot2 = g2_x * x2x + g2_y * x2y + g2_z * x2z;
    let dot3 = g3_x * x3x + g3_y * x3y + g3_z * x3z;

    42.0 * (m0_q * dot0 + m1_q * dot1 + m2_q * dot2 + m3_q * dot3)
}
