/**
 * Magic wand — pick a whole region of similar colour in one tap.
 *
 * The model gives a good subject/background split, but it has no opinion about
 * the *parts* of a subject: a logo's coloured disc, a flat studio backdrop that
 * survived, a sticker's halo. Those are trivially separable by colour, and a
 * click is far quicker than painting them out by hand.
 */

/** Tolerance 0–100 maps to this much per-channel slack before the squaring. */
const MAX_CHANNEL_DELTA = 120;

/**
 * Select pixels matching the one under (seedX, seedY).
 *
 * @param {Uint8ClampedArray} data  RGBA pixels.
 * @param {number} w
 * @param {number} h
 * @param {number} seedX
 * @param {number} seedY
 * @param {{tolerance: number, contiguous: boolean}} opts
 * @returns {Uint8Array} 0 or 255 per pixel.
 */
export function selectRegion(data, w, h, seedX, seedY, { tolerance, contiguous }) {
  const out = new Uint8Array(w * h);
  const sx = Math.min(w - 1, Math.max(0, Math.round(seedX)));
  const sy = Math.min(h - 1, Math.max(0, Math.round(seedY)));

  const seed = (sy * w + sx) * 4;
  const r0 = data[seed], g0 = data[seed + 1], b0 = data[seed + 2], a0 = data[seed + 3];

  // Compare squared distance so the hot loop needs no square root.
  const delta = (tolerance / 100) * MAX_CHANNEL_DELTA;
  const limit = delta * delta * 3;

  const matches = (i) => {
    const dr = data[i] - r0;
    const dg = data[i + 1] - g0;
    const db = data[i + 2] - b0;
    const da = data[i + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= limit;
  };

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (matches(p * 4)) out[p] = 255;
    return out;
  }

  // Scanline flood fill: fill a whole horizontal run, then queue only the
  // starts of qualifying runs on the rows above and below. Far fewer stack
  // entries than a naive four-way flood.
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    const row = y * w;
    if (out[row + x] || !matches((row + x) * 4)) continue;

    let left = x;
    while (left > 0 && !out[row + left - 1] && matches((row + left - 1) * 4)) left--;
    let right = x;
    while (right < w - 1 && !out[row + right + 1] && matches((row + right + 1) * 4)) right++;

    for (let i = left; i <= right; i++) out[row + i] = 255;

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      const nrow = ny * w;
      let inRun = false;
      for (let i = left; i <= right; i++) {
        const ok = !out[nrow + i] && matches((nrow + i) * 4);
        if (ok && !inRun) {
          stack.push(i, ny);
          inRun = true;
        } else if (!ok) {
          inRun = false;
        }
      }
    }
  }
  return out;
}

/**
 * Turn a region into an RGBA layer the matte pipeline understands: red for
 * erase, green for restore, alpha carrying coverage.
 */
export function regionToImageData(region, w, h, mode) {
  const image = new ImageData(w, h);
  const px = image.data;
  const red = mode === 'erase' ? 255 : 0;
  const green = mode === 'erase' ? 0 : 255;
  for (let i = 0; i < region.length; i++) {
    if (!region[i]) continue;
    const p = i * 4;
    px[p] = red;
    px[p + 1] = green;
    px[p + 3] = 255;
  }
  return image;
}
