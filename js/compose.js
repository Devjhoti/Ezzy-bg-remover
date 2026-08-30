/**
 * Scene compositing — everything that happens once the subject is cut out.
 *
 * Layer order, bottom to top: background fill, object layers, text.
 *
 * Object layers carry a transform (offset, scale, rotation) so the cutout and
 * any imported images can be moved and resized on the canvas independently.
 * All transforms are stored in *original-image pixels* and multiplied by
 * `scale` at draw time, so a downscaled preview and a full-resolution export
 * come out identical.
 *
 * Colour adjustments and blurs go through `ctx.filter` rather than per-pixel
 * loops: it is GPU-accelerated and stays fast at export resolution.
 */

export const SCENE_DEFAULTS = Object.freeze({
  bgMode: 'transparent',      // transparent | color | blur
  bgColor: '#ffffff',
  bgBlur: 18,
  shadow: false,
  shadowBlur: 30,
  shadowOpacity: 45,
  shadowX: 0,
  shadowY: 22,
  shadowColor: '#000000',
  brightness: 100,
  contrast: 100,
  saturation: 100,
  aspect: 'original',
  padding: 0
});

/** A freshly created layer sits centred, unscaled and upright. */
export const LAYER_DEFAULTS = Object.freeze({
  tx: 0, ty: 0, sx: 1, sy: 1, rot: 0, opacity: 1, visible: true
});

/** Aspect presets, as width/height. `original` keeps the subject's own frame. */
export const ASPECTS = {
  original: null,
  '1:1': 1,
  '4:5': 4 / 5,
  '3:2': 3 / 2,
  '2:3': 2 / 3,
  '16:9': 16 / 9,
  '9:16': 9 / 16
};

const supportsFilter = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.filter = 'blur(1px)';
  return ctx.filter !== 'none' && ctx.filter !== '';
})();

const hexToRgb = (hex) => {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
};

const rgba = (hex, alpha) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

function adjustmentFilter({ brightness, contrast, saturation }) {
  if (!supportsFilter) return 'none';
  const parts = [];
  if (brightness !== 100) parts.push(`brightness(${brightness}%)`);
  if (contrast !== 100) parts.push(`contrast(${contrast}%)`);
  if (saturation !== 100) parts.push(`saturate(${saturation}%)`);
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * Work out the output frame.
 *
 * Padding is expressed as a percentage of the subject's longest side so it
 * reads the same whatever the image's resolution, and the aspect preset then
 * grows (never crops) the frame to hit the requested ratio.
 */
export function frameFor(subjectW, subjectH, { aspect, padding }, scale = 1) {
  const pad = Math.round((padding / 100) * Math.max(subjectW, subjectH));
  let width = subjectW + pad * 2;
  let height = subjectH + pad * 2;

  const ratio = ASPECTS[aspect];
  if (ratio) {
    if (width / height < ratio) width = Math.round(height * ratio);
    else height = Math.round(width / ratio);
  }

  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
    offsetX: Math.round((width - subjectW) / 2),
    offsetY: Math.round((height - subjectH) / 2),
    scale
  };
}

/** Put an ImageData on its own canvas so it can be drawn with filters. */
function toCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
  return canvas;
}

function drawCover(ctx, source, x, y, width, height) {
  const fit = Math.max(width / source.width, height / source.height);
  const dw = source.width * fit;
  const dh = source.height * fit;
  ctx.drawImage(source, x + (width - dw) / 2, y + (height - dh) / 2, dw, dh);
}

function paintBackground(ctx, frame, scene, plate) {
  const { width, height } = frame;

  if (scene.bgMode === 'color') {
    ctx.fillStyle = scene.bgColor;
    ctx.fillRect(0, 0, width, height);
    return;
  }

  if (scene.bgMode === 'blur' && plate) {
    const radius = Math.max(0.5, scene.bgBlur * frame.scale);
    // A Gaussian of sigma r reaches about 3r. Draw the plate that much larger
    // than the frame, or the kernel samples the transparent void beyond its
    // edge and leaves a translucent, darkened border.
    const margin = Math.ceil(radius * 3);
    ctx.save();
    if (supportsFilter) ctx.filter = `blur(${radius}px)`;
    drawCover(ctx, plate, -margin, -margin, width + margin * 2, height + margin * 2);
    ctx.restore();
  }
  // 'transparent' leaves the canvas clear.
}

/* ── Layers ───────────────────────────────────────────────────────────── */

/** A layer's untransformed size, in original-image pixels. */
export function naturalSize(layer, subject, scale) {
  return layer.kind === 'subject'
    ? { w: subject.width / scale, h: subject.height / scale }
    : { w: layer.bitmap.width, h: layer.bitmap.height };
}

/**
 * A layer's resting position on the canvas, before its own offset.
 *
 * The cutout rests where its content already sits in the frame; anything
 * imported rests in the middle. Either way tx/ty then read as "nudged from
 * where it belongs", so a fresh layer needs no special case.
 */
export function layerBase(layer, frame, subject, contentOffset) {
  return layer.kind === 'subject'
    ? {
      x: frame.offsetX + contentOffset.x + subject.width / 2,
      y: frame.offsetY + contentOffset.y + subject.height / 2
    }
    : { x: frame.width / 2, y: frame.height / 2 };
}

/** Where a layer lands on the canvas, given its resting base. */
export function layerBox(layer, base, natural, scale) {
  return {
    baseX: base.x,
    baseY: base.y,
    cx: base.x + layer.tx * scale,
    cy: base.y + layer.ty * scale,
    w: natural.w * layer.sx * scale,
    h: natural.h * layer.sy * scale,
    rot: layer.rot
  };
}

/** Rotate a vector by `angle` radians. */
export function rotate(x, y, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: x * c - y * s, y: x * s + y * c };
}

/** Is a canvas-space point inside this (possibly rotated) box? */
export function hitTest(box, px, py) {
  const local = rotate(px - box.cx, py - box.cy, -box.rot);
  return Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2;
}

function drawLayer(ctx, layer, source, box, scene, filter) {
  ctx.save();
  ctx.translate(box.cx, box.cy);
  if (box.rot) ctx.rotate(box.rot);
  ctx.globalAlpha = layer.opacity;
  ctx.filter = filter;
  ctx.drawImage(source, -box.w / 2, -box.h / 2, box.w, box.h);
  ctx.restore();
}

function paintText(ctx, frame, texts) {
  for (const layer of texts) {
    if (!layer.text) continue;
    const size = Math.max(4, (layer.size / 100) * frame.height);
    ctx.save();
    ctx.font = `${layer.weight} ${size}px ${layer.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const x = layer.x * frame.width;
    const y = layer.y * frame.height;
    if (layer.outline) {
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.strokeStyle = layer.outlineColor;
      ctx.lineJoin = 'round';
      ctx.strokeText(layer.text, x, y);
    }
    ctx.fillStyle = layer.color;
    ctx.globalAlpha = layer.opacity ?? 1;
    ctx.fillText(layer.text, x, y);
    ctx.restore();
  }
}

/** Measure a text layer's box in canvas pixels, for hit-testing and dragging. */
export function measureText(ctx, frame, layer) {
  const size = Math.max(4, (layer.size / 100) * frame.height);
  ctx.save();
  ctx.font = `${layer.weight} ${size}px ${layer.font}`;
  const width = ctx.measureText(layer.text || ' ').width;
  ctx.restore();
  return {
    x: layer.x * frame.width - width / 2,
    y: layer.y * frame.height - size / 2,
    w: width,
    h: size
  };
}

/**
 * Compose the final scene onto `canvas`.
 *
 * @param {HTMLCanvasElement} canvas  Target, resized to the computed frame.
 * @param {object} args
 * @param {ImageData} args.subject  Cut-out subject, cropped to its own content.
 * @param {{w: number, h: number}} args.frameSize  Base frame, before padding.
 * @param {{x: number, y: number}} args.contentOffset  Subject's place in that frame.
 * @param {HTMLCanvasElement} [args.plate]  Original pixels, for the blur background.
 * @param {object} args.scene  Scene options.
 * @param {Array} args.layers  Object layers, bottom to top.
 * @param {Array} args.texts  Text layers.
 * @param {number} args.scale  Working resolution ÷ original resolution.
 * @returns {{ frame: object, boxes: Map }} Layout, for pointer mapping and handles.
 */
export function compose(canvas, {
  subject, frameSize, contentOffset = { x: 0, y: 0 },
  plate, scene, layers = [], texts = [], scale = 1
}) {
  const size = frameSize ?? { w: subject.width, h: subject.height };
  const frame = frameFor(size.w, size.h, scene, scale);
  canvas.width = frame.width;
  canvas.height = frame.height;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, frame.width, frame.height);

  paintBackground(ctx, frame, scene, plate);

  const subjectCanvas = toCanvas(subject);
  const filter = adjustmentFilter(scene);
  const boxes = new Map();

  for (const layer of layers) {
    const base = layerBase(layer, frame, subject, contentOffset);
    const box = layerBox(layer, base, naturalSize(layer, subject, scale), scale);
    boxes.set(layer.id, box);
    if (!layer.visible || box.w < 0.5 || box.h < 0.5) continue;

    const source = layer.kind === 'subject' ? subjectCanvas : layer.bitmap;

    // Pass 1 lays down the shadow. The canvas shadow is cast from the drawn
    // image's alpha, so the layer comes along with it; pass 2 then covers that
    // copy with the colour-adjusted one, pixel for pixel. Imported images are
    // usually backdrops, so only cutouts get a shadow.
    if (scene.shadow && scene.shadowOpacity > 0 && layer.kind === 'subject') {
      ctx.save();
      ctx.shadowColor = rgba(scene.shadowColor, scene.shadowOpacity / 100);
      ctx.shadowBlur = Math.max(0, scene.shadowBlur * scale);
      ctx.shadowOffsetX = scene.shadowX * scale;
      ctx.shadowOffsetY = scene.shadowY * scale;
      drawLayer(ctx, layer, source, box, scene, 'none');
      ctx.restore();
    }

    drawLayer(ctx, layer, source, box, scene, filter);
  }

  paintText(ctx, frame, texts);

  return { frame, boxes };
}
