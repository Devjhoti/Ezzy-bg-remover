/**
 * Matte refinement and compositing.
 *
 * The neural network gives us a soft mask. Turning that mask into a *good*
 * transparent image needs three more things, all of which happen here:
 *
 *   1. Edge shaping   — feather / shift / contrast on the alpha channel, so the
 *                       cutout neither aliases nor keeps a rim of background.
 *   2. Decontamination — a semi-transparent pixel is a mix of foreground and
 *                       background colour. Left alone it shows up as a halo on
 *                       any new background. We estimate the local background and
 *                       solve for the true foreground colour.
 *   3. Compositing     — non-premultiplied RGBA out, so the PNG composites
 *                       correctly over anything.
 *
 * Everything works on plain typed arrays and is resolution-independent: the
 * viewer renders a downscaled preview with identical settings, the exporter
 * runs the same code at full resolution.
 */

export const DEFAULTS = Object.freeze({
  feather: 1,
  shift: -0.5,
  contrast: 1.2,
  despill: true,
  trim: false,
  bgMode: 'transparent',
  bgColor: '#ffffff'
});

/* ── Blur ─────────────────────────────────────────────────────────────── */

/**
 * One horizontal box-blur pass with a sliding sum, plus fractional end taps so
 * non-integer radii still move the edge smoothly. O(1) work per pixel.
 */
function boxBlurH(src, dst, w, h, radius) {
  const ri = Math.floor(radius);
  const frac = radius - ri;
  const norm = 1 / (2 * radius + 1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    // Prime the window at x = 0 (edges clamp to the first/last pixel).
    for (let k = -ri; k <= ri; k++) sum += src[row + Math.min(w - 1, Math.max(0, k))];

    for (let x = 0; x < w; x++) {
      const lo = src[row + Math.min(w - 1, Math.max(0, x - ri - 1))];
      const hi = src[row + Math.min(w - 1, Math.max(0, x + ri + 1))];
      dst[row + x] = (sum + frac * (lo + hi)) * norm;

      // Slide the window one pixel right.
      const drop = src[row + Math.min(w - 1, Math.max(0, x - ri))];
      const add = src[row + Math.min(w - 1, Math.max(0, x + ri + 1))];
      sum += add - drop;
    }
  }
}

function boxBlurV(src, dst, w, h, radius) {
  const ri = Math.floor(radius);
  const frac = radius - ri;
  const norm = 1 / (2 * radius + 1);
  const last = h - 1;

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -ri; k <= ri; k++) sum += src[Math.min(last, Math.max(0, k)) * w + x];

    for (let y = 0; y < h; y++) {
      const lo = src[Math.min(last, Math.max(0, y - ri - 1)) * w + x];
      const hi = src[Math.min(last, Math.max(0, y + ri + 1)) * w + x];
      dst[y * w + x] = (sum + frac * (lo + hi)) * norm;

      const drop = src[Math.min(last, Math.max(0, y - ri)) * w + x];
      const add = src[Math.min(last, Math.max(0, y + ri + 1)) * w + x];
      sum += add - drop;
    }
  }
}

/** Two box passes each way ≈ a Gaussian, at a fraction of the cost. */
function blur(buf, w, h, radius, passes = 2) {
  if (radius < 0.05) return buf;
  const tmp = new Float32Array(buf.length);
  for (let p = 0; p < passes; p++) {
    boxBlurH(buf, tmp, w, h, radius);
    boxBlurV(tmp, buf, w, h, radius);
  }
  return buf;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/* ── Edge shaping ─────────────────────────────────────────────────────── */

/**
 * Reshape the raw mask into the final alpha channel, in three steps.
 *
 * 1. Normalise. A saliency network rarely outputs a confident 1.0 even in the
 *    middle of the subject, so without this the "opaque" interior would export
 *    at ~90% alpha and ghost over any background.
 * 2. Levels. `contrast` squeezes the response around the midpoint, snapping
 *    near-transparent haze to fully clear and near-solid pixels to fully solid.
 * 3. Geometry. Blurring by r px spreads each edge into a ramp about 2r px wide.
 *    That ramp is close to linear, so shifting the re-threshold by d alpha units
 *    moves the edge by d·2r pixels — which is what lets `shift` and `feather` be
 *    expressed in pixels instead of arbitrary units.
 */
function shapeAlpha(alpha, w, h, { feather, shift, contrast }) {
  let peak = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] > peak) peak = alpha[i];
  // Below this the network found nothing; rescaling would only amplify noise.
  const gain = peak > 0.25 ? 1 / peak : 1;

  const half = 0.5 / Math.max(contrast, 1);
  const lo = 0.5 - half;
  const hi = 0.5 + half;
  for (let i = 0; i < alpha.length; i++) alpha[i] = smoothstep(lo, hi, alpha[i] * gain);

  const r = Math.max(feather, Math.abs(shift), 0.5);
  blur(alpha, w, h, r);

  const t = Math.min(0.98, Math.max(0.02, 0.5 - shift / (2 * r)));
  // Clamped so the transition band always stays inside [0, 1]: if it spilled
  // past either end, no pixel could reach a true 0 or 1.
  const halfWidth = Math.min(Math.max(feather / (2 * r), 0.02), t, 1 - t);

  for (let i = 0; i < alpha.length; i++) {
    const a = smoothstep(t - halfWidth, t + halfWidth, alpha[i]);
    alpha[i] = a < 0.002 ? 0 : a > 0.998 ? 1 : a;
  }
  return alpha;
}

/* ── Background estimation ────────────────────────────────────────────── */

const BG_GRID = 8; // Background estimate resolution divisor — it only needs to be smooth.

/**
 * Estimate the background colour behind every pixel.
 *
 * Averages the image weighted by (1 - alpha) into a small grid, so only true
 * background pixels contribute, then blurs to push that colour underneath the
 * subject where no background is visible. Returns a low-res RGB grid plus its
 * dimensions, or null when the image has no usable background pixels.
 */
function estimateBackground(rgba, alpha, w, h) {
  const gw = Math.max(2, Math.ceil(w / BG_GRID));
  const gh = Math.max(2, Math.ceil(h / BG_GRID));
  const n = gw * gh;
  const acc = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const weight = new Float32Array(n);

  for (let y = 0; y < h; y++) {
    const gy = Math.min(gh - 1, (y / BG_GRID) | 0);
    for (let x = 0; x < w; x++) {
      const wgt = 1 - alpha[y * w + x];
      if (wgt < 0.02) continue;
      const g = gy * gw + Math.min(gw - 1, (x / BG_GRID) | 0);
      const p = (y * w + x) * 4;
      acc[0][g] += rgba[p] * wgt;
      acc[1][g] += rgba[p + 1] * wgt;
      acc[2][g] += rgba[p + 2] * wgt;
      weight[g] += wgt;
    }
  }

  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weight[i];
  if (totalWeight < 1) return null; // Image is essentially all foreground.

  // Spread the samples so cells fully covered by the subject inherit the
  // background colour of their neighbours.
  const spread = Math.max(2, Math.round(Math.max(gw, gh) / 24));
  for (const ch of acc) blur(ch, gw, gh, spread, 2);
  blur(weight, gw, gh, spread, 2);

  const global = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    global[0] += acc[0][i];
    global[1] += acc[1][i];
    global[2] += acc[2][i];
  }
  let gsum = 0;
  for (let i = 0; i < n; i++) gsum += weight[i];
  for (let c = 0; c < 3; c++) global[c] = gsum > 0 ? global[c] / gsum : 128;

  const grid = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const wgt = weight[i];
    for (let c = 0; c < 3; c++) grid[i * 3 + c] = wgt > 1e-4 ? acc[c][i] / wgt : global[c];
  }
  return { grid, gw, gh };
}

/** Bilinear lookup into the low-res background grid, in full-res coordinates. */
function sampleBackground(bg, x, y, out) {
  const fx = Math.min(bg.gw - 1.001, Math.max(0, x / BG_GRID - 0.5));
  const fy = Math.min(bg.gh - 1.001, Math.max(0, y / BG_GRID - 0.5));
  const x0 = fx | 0, y0 = fy | 0;
  const tx = fx - x0, ty = fy - y0;
  const i00 = (y0 * bg.gw + x0) * 3;
  const i10 = i00 + 3;
  const i01 = i00 + bg.gw * 3;
  const i11 = i01 + 3;
  for (let c = 0; c < 3; c++) {
    const top = bg.grid[i00 + c] + (bg.grid[i10 + c] - bg.grid[i00 + c]) * tx;
    const bot = bg.grid[i01 + c] + (bg.grid[i11 + c] - bg.grid[i01 + c]) * tx;
    out[c] = top + (bot - top) * ty;
  }
}

/* ── Manual edits ─────────────────────────────────────────────────────── */

/**
 * Fold brush strokes into the matte.
 *
 * Strokes are rasterised elsewhere into an RGBA layer where the red channel
 * marks erase, green marks restore, and the alpha channel carries the brush's
 * coverage — so a soft brush edge produces a soft correction. Later strokes
 * overwrite earlier ones on the layer, which is what makes erasing over a
 * restored area behave the way a user expects.
 */
export function applyEdits(alpha, edits) {
  for (let i = 0; i < alpha.length; i++) {
    const p = i * 4;
    const strength = edits[p + 3] / 255;
    if (strength <= 0.004) continue;
    alpha[i] = edits[p] >= edits[p + 1]
      ? Math.min(alpha[i], 1 - strength)
      : Math.max(alpha[i], strength);
  }
  return alpha;
}

/* ── Compositing ──────────────────────────────────────────────────────── */

/**
 * Turn source pixels + a raw mask into a transparent subject.
 *
 * Output is non-premultiplied RGBA with the background fully clear; anything
 * that goes *behind* the subject is the compositor's job, not this function's.
 *
 * @param {ImageData} source  Original image at working resolution.
 * @param {Float32Array} rawAlpha  Mask in 0..1 at the same resolution.
 * @param {object} opts  Refinement options; px values are pre-scaled by caller.
 * @returns {{ imageData: ImageData, bbox: {x,y,w,h}|null }}
 */
export function refine(source, rawAlpha, opts) {
  const { width: w, height: h } = source;
  const src = source.data;
  const alpha = shapeAlpha(rawAlpha, w, h, opts);

  const bg = opts.despill ? estimateBackground(src, alpha, w, h) : null;
  const est = [0, 0, 0];

  const out = new ImageData(w, h);
  const dst = out.data;

  // Track the opaque bounds while we are already touching every pixel.
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = i * 4;
      const a = alpha[i];
      if (a <= 0.002) continue;

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      let r = src[p], g = src[p + 1], b = src[p + 2];

      // Unmix the observed colour C = a·F + (1-a)·B to recover F. Only edge
      // pixels need it, and the correction is damped as alpha approaches 1
      // where the estimate is least reliable and matters least.
      if (bg && a < 0.995) {
        sampleBackground(bg, x, y, est);
        const inv = 1 - a;
        const k = 1 / Math.max(a, 0.12);
        r = Math.min(255, Math.max(0, (r - inv * est[0]) * k));
        g = Math.min(255, Math.max(0, (g - inv * est[1]) * k));
        b = Math.min(255, Math.max(0, (b - inv * est[2]) * k));
      }

      dst[p] = r;
      dst[p + 1] = g;
      dst[p + 2] = b;
      dst[p + 3] = Math.round(a * 255);
    }
  }

  const bbox = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  return { imageData: out, bbox };
}

/** Draw any canvas-like source at w×h and hand back its raw pixels. */
export function readScaled(ctx, source, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/**
 * Read a mask bitmap into a 0..1 Float32Array at the given working size,
 * letting the browser do the (bilinear) rescale.
 */
export function readMask(ctx, maskBitmap, w, h) {
  const d = readScaled(ctx, maskBitmap, w, h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = d[i * 4] / 255;
  return alpha;
}
