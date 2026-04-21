/** Unpack a hex color (0xRRGGBB) into normalized rgba components. */
export function unpackColor(
  color: number,
  alpha: number,
): { r: number; g: number; b: number; a: number } {
  return {
    r: ((color >> 16) & 0xff) / 255,
    g: ((color >> 8) & 0xff) / 255,
    b: (color & 0xff) / 255,
    a: alpha,
  };
}
