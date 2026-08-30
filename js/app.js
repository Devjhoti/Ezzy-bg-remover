/**
 * Background Remover — UI, queue, editing tools and export.
 *
 * The expensive step (segmentation) runs once per image and its raw matte is
 * kept in memory. Everything after that — brush and wand corrections,
 * backgrounds, object transforms, shadows, colour, crop, text — re-composites
 * from that cached matte, so the editor stays interactive without ever
 * touching the model again.
 */
import { segment, enqueue, describeBackend } from './engine.js';
import { refine, readMask, readScaled, applyEdits, DEFAULTS } from './refine.js';
import {
  compose, measureText, frameFor, naturalSize, hitTest, rotate,
  SCENE_DEFAULTS, LAYER_DEFAULTS
} from './compose.js';
import { selectRegion, regionToImageData } from './wand.js';
import { createZip } from './zip.js';

const $ = (id) => document.getElementById(id);

/** Inference happens at 1024² internally, so feeding it more than this is wasted work. */
const INFERENCE_MAX_DIM = 2048;
/** Cap for the on-screen preview render, independent of the exported resolution. */
const PREVIEW_MAX_DIM = 2600;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const ZOOM_LIMITS = [0.05, 8];
/** Selection handle size, in CSS pixels — kept constant on screen at any zoom. */
const HANDLE_PX = 9;
const ROTATE_OFFSET_PX = 26;

const SWATCHES = [
  '#ffffff', '#f5f5f4', '#e7e5e4', '#000000', '#1c1917', '#334155', '#0ea5e9',
  '#2563eb', '#7c3aed', '#db2777', '#e11d48', '#f97316', '#f59e0b', '#16a34a'
];

/** Handle id → direction from the box centre, in the layer's local axes. */
const HANDLE_DIRS = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0],
  se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0]
};

const state = {
  items: [],
  activeId: null,
  tool: 'cutout',
  view: 'result',
  splitPct: 50,
  zoom: 'fit',
  model: 'isnet_fp16',
  format: 'image/png',
  brush: { mode: 'off', size: 60 },
  wand: { tolerance: 22, contiguous: true, action: 'erase' },
  edge: { ...DEFAULTS },
  scene: { ...SCENE_DEFAULTS },
  selectedLayerId: null,
  activeTextId: null,
  preview: null,
  panning: false,
  history: [],
  future: [],
  pending: null
};

let nextId = 1;
let nextTextId = 1;
let nextLayerId = 1;

/* ── Scratch canvases, reused across renders ──────────────────────────── */
const scratch = (() => {
  const make = () => {
    const c = document.createElement('canvas');
    return { canvas: c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  };
  return { src: make(), mask: make(), edits: make(), plate: make(), region: make(), out: make() };
})();

function sizeCanvas({ canvas, ctx }, w, h) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  } else {
    ctx.clearRect(0, 0, w, h);
  }
  return ctx;
}

/* ── Small helpers ────────────────────────────────────────────────────── */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const formatBytes = (n) =>
  n < 1024 ? `${n} B`
    : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;

let toastTimer;
function toast(message, kind = 'error') {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('ok', kind === 'ok');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'ok' ? 2600 : 6000);
}

const extensionFor = (type) =>
  ({ 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[type] || 'png');

const isFlattened = () =>
  state.format === 'image/jpeg' || state.scene.bgMode !== 'transparent';

function outputName(item) {
  const base = item.name.replace(/\.[^.]+$/, '') || 'image';
  const suffix = isFlattened() ? 'cutout' : 'transparent';
  return `${base}-${suffix}.${extensionFor(state.format)}`;
}

function cropImageData(data, box) {
  const out = new ImageData(box.w, box.h);
  for (let y = 0; y < box.h; y++) {
    const from = ((y + box.y) * data.width + box.x) * 4;
    out.data.set(data.data.subarray(from, from + box.w * 4), y * box.w * 4);
  }
  return out;
}

function imageDataToCanvas(data, target) {
  const ctx = sizeCanvas(target, data.width, data.height);
  ctx.putImageData(data, 0, 0);
  return target.canvas;
}

const activeItem = () => state.items.find((i) => i.id === state.activeId) || null;
const activeText = () => activeItem()?.texts.find((t) => t.id === state.activeTextId) || null;
const selectedLayer = () =>
  activeItem()?.layers.find((l) => l.id === state.selectedLayerId) || null;

/* ── Matte edits: brush strokes and wand selections ───────────────────── */

/** The paint layer lives at matte resolution; edits are stored in original-image pixels. */
function paintLayer(item) {
  if (!item.paint) {
    const c = document.createElement('canvas');
    c.width = item.mask.width;
    c.height = item.mask.height;
    item.paint = c;
  }
  return item.paint;
}

const paintRatio = (item) => paintLayer(item).width / item.bitmap.width;

/** Original pixels at matte resolution — what the wand matches against. */
function wandSource(item) {
  if (!item.wandSource) {
    const layer = paintLayer(item);
    const ctx = sizeCanvas(scratch.region, layer.width, layer.height);
    ctx.drawImage(item.bitmap, 0, 0, layer.width, layer.height);
    item.wandSource = ctx.getImageData(0, 0, layer.width, layer.height);
  }
  return item.wandSource;
}

/**
 * Draw a stroke onto the paint layer.
 *
 * Red marks erase, green marks restore, and drawing source-over means a later
 * edit replaces an earlier one — so erasing over a restored area behaves the
 * way a user expects, without any per-edit bookkeeping at composite time.
 */
function drawStroke(ctx, op, k, fromIndex = 0) {
  const pts = op.points;
  const colour = op.mode === 'erase' ? 'rgba(255,0,0,1)' : 'rgba(0,255,0,1)';
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = Math.max(1, op.size * k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0][0] * k, pts[0][1] * k, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  const start = Math.max(0, fromIndex - 1);
  ctx.moveTo(pts[start][0] * k, pts[start][1] * k);
  for (let i = start + 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * k, pts[i][1] * k);
  ctx.stroke();
}

function drawWand(ctx, op, item) {
  const src = wandSource(item);
  const k = paintRatio(item);
  const region = selectRegion(src.data, src.width, src.height, op.seed[0] * k, op.seed[1] * k, {
    tolerance: op.tolerance,
    contiguous: op.contiguous
  });
  // Via a temp canvas rather than putImageData, so the region composites over
  // earlier edits instead of blanking the pixels around it.
  const tmp = sizeCanvas(scratch.edits, src.width, src.height);
  tmp.putImageData(regionToImageData(region, src.width, src.height, op.mode), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(scratch.edits.canvas, 0, 0);
}

function applyEditOp(item, op) {
  const ctx = paintLayer(item).getContext('2d');
  if (op.type === 'wand') drawWand(ctx, op, item);
  else drawStroke(ctx, op, paintRatio(item));
}

function repaintEdits(item) {
  const layer = paintLayer(item);
  const ctx = layer.getContext('2d');
  ctx.clearRect(0, 0, layer.width, layer.height);
  for (const op of item.edits) applyEditOp(item, op);
}

/* ── Building the output ──────────────────────────────────────────────── */

/**
 * Cut the subject out at a chosen resolution.
 *
 * Pixel-denominated settings are multiplied by the render scale so a preview
 * and a full-resolution export produce visually identical edges.
 */
function build(item, maxDim) {
  const iw = item.bitmap.width;
  const ih = item.bitmap.height;
  const scale = maxDim ? Math.min(1, maxDim / Math.max(iw, ih)) : 1;
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));

  const srcCtx = sizeCanvas(scratch.src, w, h);
  srcCtx.drawImage(item.bitmap, 0, 0, w, h);
  const source = srcCtx.getImageData(0, 0, w, h);

  const maskCtx = sizeCanvas(scratch.mask, w, h);
  const alpha = readMask(maskCtx, item.mask, w, h);

  if (item.edits.length) {
    const editCtx = sizeCanvas(scratch.edits, w, h);
    applyEdits(alpha, readScaled(editCtx, paintLayer(item), w, h));
  }

  const edge = {
    ...state.edge,
    feather: state.edge.feather * scale,
    shift: state.edge.shift * scale
  };

  const { imageData, bbox } = refine(source, alpha, edge);
  const bounds = bbox ?? { x: 0, y: 0, w, h };

  // The subject is always cropped to its own opaque bounds. That is what makes
  // a selection box hug the subject instead of the whole (mostly empty) frame,
  // and it keeps the resize handles reachable when a layer is dragged part-way
  // off the canvas. `contentOffset` remembers where it came from, so an
  // untransformed layer still lands exactly where the model found it.
  const subject = cropImageData(imageData, bounds);
  const trimming = state.edge.trim;

  return {
    subject,
    plate: trimming ? cropImageData(source, bounds) : source,
    frameSize: trimming ? { w: bounds.w, h: bounds.h } : { w, h },
    contentOffset: trimming ? { x: 0, y: 0 } : { x: bounds.x, y: bounds.y },
    crop: trimming ? bounds : { x: 0, y: 0, w, h },
    scale
  };
}

/** Cut out, then compose the scene on top. */
function render(canvas, item, maxDim) {
  const built = build(item, maxDim);
  const { frame, boxes } = compose(canvas, {
    subject: built.subject,
    frameSize: built.frameSize,
    contentOffset: built.contentOffset,
    plate: state.scene.bgMode === 'blur' ? imageDataToCanvas(built.plate, scratch.plate) : null,
    scene: state.scene,
    layers: item.layers,
    texts: item.texts,
    scale: built.scale
  });
  return { ...built, frame, boxes };
}

/* ── Preview ──────────────────────────────────────────────────────────── */

function fitScale(item) {
  const rect = $('stage').getBoundingClientRect();
  const availW = Math.max(160, rect.width - 44);
  const availH = Math.max(160, rect.height - 44);
  return Math.min(availW / item.bitmap.width, availH / item.bitmap.height, 1);
}

function previewGeometry(item) {
  const zoom = state.zoom === 'fit' ? fitScale(item) : state.zoom;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const longest = Math.max(item.bitmap.width, item.bitmap.height);
  return { zoom, maxDim: clamp(Math.round(longest * zoom * dpr), 64, PREVIEW_MAX_DIM) };
}

function renderPreview() {
  const item = activeItem();
  const wrap = $('canvas-wrap');

  if (!item || !item.mask) {
    state.preview = null;
    wrap.hidden = true;
    $('stage-empty').hidden = false;
    $('stage-empty').textContent = item
      ? (item.status === 'error' ? item.error : 'Removing background…')
      : 'Add an image to get started.';
    updateActions();
    return;
  }

  const geo = previewGeometry(item);
  const built = render($('canvas-result'), item, geo.maxDim);

  state.preview = {
    ...built,
    plateCanvas: imageDataToCanvas(built.plate, scratch.out),
    cssScale: geo.zoom / built.scale,
    zoom: geo.zoom
  };

  wrap.hidden = false;
  $('stage-empty').hidden = true;
  paintOverlays();
  applyCanvasSize();
  updateMeta();
  updateActions();
}

/** Result is already on the canvas; add the compare wipe and selection chrome. */
function paintOverlays() {
  const p = state.preview;
  if (!p) return;
  const canvas = $('canvas-result');
  const ctx = canvas.getContext('2d');
  const { frame } = p;

  if (state.view !== 'result') {
    const split = state.view === 'original'
      ? frame.width
      : Math.round((state.splitPct / 100) * frame.width);
    if (split > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, split, frame.height);
      ctx.clip();
      ctx.clearRect(0, 0, split, frame.height);
      ctx.drawImage(p.plateCanvas, frame.offsetX, frame.offsetY);
      ctx.restore();
    }
  }

  if (state.tool === 'objects' && state.view === 'result') drawSelection(ctx);

  const handle = $('compare-handle');
  handle.hidden = state.view !== 'compare';
  handle.style.left = `${state.splitPct}%`;
}

/** Selection outline plus resize/rotate handles, sized in screen pixels. */
function drawSelection(ctx) {
  const p = state.preview;
  const box = p.boxes.get(state.selectedLayerId);
  if (!box) return;

  const unit = 1 / p.cssScale;          // one CSS pixel, in canvas pixels
  const half = (HANDLE_PX * unit) / 2;

  ctx.save();
  ctx.translate(box.cx, box.cy);
  if (box.rot) ctx.rotate(box.rot);

  ctx.strokeStyle = '#67e8f9';
  ctx.lineWidth = 1.5 * unit;
  ctx.setLineDash([5 * unit, 4 * unit]);
  ctx.strokeRect(-box.w / 2, -box.h / 2, box.w, box.h);
  ctx.setLineDash([]);

  // Rotation handle, on a stalk above the top edge.
  const stalk = ROTATE_OFFSET_PX * unit;
  ctx.beginPath();
  ctx.moveTo(0, -box.h / 2);
  ctx.lineTo(0, -box.h / 2 - stalk);
  ctx.stroke();
  ctx.fillStyle = '#67e8f9';
  ctx.beginPath();
  ctx.arc(0, -box.h / 2 - stalk, half, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#0a0c11';
  for (const [dx, dy] of Object.values(HANDLE_DIRS)) {
    const x = (dx * box.w) / 2;
    const y = (dy * box.h) / 2;
    ctx.fillRect(x - half, y - half, half * 2, half * 2);
    ctx.strokeRect(x - half, y - half, half * 2, half * 2);
  }
  ctx.restore();
}

function applyCanvasSize() {
  const p = state.preview;
  if (!p) return;
  const canvas = $('canvas-result');
  canvas.style.width = `${Math.round(p.frame.width * p.cssScale)}px`;
  canvas.style.height = `${Math.round(p.frame.height * p.cssScale)}px`;
  $('zoom-reset').textContent = state.zoom === 'fit'
    ? 'Fit'
    : `${Math.round(p.zoom * 100)}%`;
}

/** Repaint without rebuilding the matte — used during drags. */
function repaintOnly() {
  const item = activeItem();
  const p = state.preview;
  if (!item || !p) return;
  const { boxes } = compose($('canvas-result'), {
    subject: p.subject,
    frameSize: p.frameSize,
    contentOffset: p.contentOffset,
    plate: state.scene.bgMode === 'blur' ? p.plateCanvas : null,
    scene: state.scene,
    layers: item.layers,
    texts: item.texts,
    scale: p.scale
  });
  p.boxes = boxes;
  paintOverlays();
  applyCanvasSize();
}

function updateMeta() {
  const p = state.preview;
  if (!p) { $('viewer-meta').textContent = ''; return; }
  // The preview is downscaled; the export is not, so report the real output size.
  const out = frameFor(
    Math.round(p.crop.w / p.scale),
    Math.round(p.crop.h / p.scale),
    state.scene
  );
  $('viewer-meta').textContent =
    `${out.width} × ${out.height} px · ${extensionFor(state.format).toUpperCase()}`;
}

/* ── Queue ────────────────────────────────────────────────────────────── */

function renderQueue() {
  const list = $('queue');
  list.textContent = '';
  $('clear-all').hidden = state.items.length === 0;

  for (const item of state.items) {
    const li = document.createElement('li');
    li.className = 'queue-item' + (item.id === state.activeId ? ' is-active' : '');
    li.tabIndex = 0;
    li.addEventListener('click', () => selectItem(item.id));

    const thumb = document.createElement('img');
    thumb.className = 'qi-thumb';
    thumb.src = item.thumbUrl;
    thumb.alt = '';

    const body = document.createElement('div');
    body.className = 'qi-body';
    const name = document.createElement('div');
    name.className = 'qi-name';
    name.textContent = item.name;
    name.title = item.name;
    const meta = document.createElement('div');
    meta.className = 'qi-meta' + (item.status === 'error' ? ' err' : '');
    meta.textContent =
      item.status === 'error' ? item.error
        : item.status === 'done' ? `${item.bitmap.width} × ${item.bitmap.height}`
          : item.status === 'working' ? 'Removing background…'
            : 'Queued';
    body.append(name, meta);

    const right = document.createElement('div');
    if (item.status === 'working' || item.status === 'queued') {
      const spin = document.createElement('div');
      spin.className = 'qi-spin';
      right.append(spin);
    } else {
      const remove = document.createElement('button');
      remove.className = 'qi-remove';
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item.id); });
      right.append(remove);
    }

    li.append(thumb, body, right);
    list.append(li);
  }
}

function selectItem(id) {
  state.activeId = id;
  const item = activeItem();
  state.activeTextId = item?.texts[0]?.id ?? null;
  state.selectedLayerId = item?.layers.at(-1)?.id ?? null;
  renderQueue();
  renderTextLayers();
  renderObjectLayers();
  renderPreview();
}

function removeItem(id) {
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [item] = state.items.splice(idx, 1);
  URL.revokeObjectURL(item.thumbUrl);
  item.bitmap?.close?.();
  item.mask?.close?.();
  for (const layer of item.layers) layer.bitmap?.close?.();
  if (state.activeId === id) {
    state.activeId = state.items[Math.min(idx, state.items.length - 1)]?.id ?? null;
    const next = activeItem();
    state.activeTextId = next?.texts[0]?.id ?? null;
    state.selectedLayerId = next?.layers.at(-1)?.id ?? null;
  }
  renderQueue();
  renderTextLayers();
  renderObjectLayers();
  renderPreview();
}

/* ── Ingest & processing ──────────────────────────────────────────────── */

async function addFiles(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) {
    if (files.length) toast('Those files are not images.');
    return;
  }

  for (const file of images) {
    let bitmap;
    try {
      // Honour EXIF rotation so the mask and the pixels always agree.
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      toast(`Could not decode ${file.name}.`);
      continue;
    }
    const item = {
      id: nextId++,
      name: file.name || `image-${nextId}.png`,
      file,
      bitmap,
      thumbUrl: URL.createObjectURL(file),
      mask: null,
      paint: null,
      wandSource: null,
      edits: [],
      texts: [],
      layers: [{ id: nextLayerId++, kind: 'subject', name: 'Cutout', ...LAYER_DEFAULTS }],
      status: 'queued',
      error: ''
    };
    state.items.push(item);
    if (state.activeId === null) {
      state.activeId = item.id;
      state.selectedLayerId = item.layers[0].id;
    }
    process(item);
  }
  renderQueue();
  renderObjectLayers();
  renderPreview();
}

/** Downscaled pixels for inference — the network sees 1024² regardless. */
function inferenceInput(bitmap) {
  const scale = Math.min(1, INFERENCE_MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = sizeCanvas(scratch.out, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function process(item) {
  item.status = 'queued';
  enqueue(async () => {
    if (!state.items.includes(item)) return;
    item.status = 'working';
    renderQueue();
    const isActive = () => state.activeId === item.id;
    if (isActive()) showBusy(true, 'Removing background…');

    try {
      const maskImage = await segment(inferenceInput(item.bitmap), {
        model: state.model,
        onProgress: (p) => {
          if (!isActive()) return;
          setProgress(p.fraction, p.downloading
            ? `Downloading model — ${formatBytes(p.bytes)} of ${formatBytes(p.totalBytes)}`
            : '');
        }
      });
      if (!state.items.includes(item)) return;

      item.mask = await createImageBitmap(maskImage);
      item.paint = null;
      item.wandSource = null;
      if (item.edits.length) repaintEdits(item);
      item.status = 'done';
      setEngine('ready');
    } catch (err) {
      console.error(err);
      item.status = 'error';
      item.error = String(err?.message || err).slice(0, 120);
      setEngine('error');
      toast(`Failed on ${item.name}: ${item.error}`);
    } finally {
      renderQueue();
      if (isActive()) { showBusy(false); renderPreview(); }
      updateActions();
    }
  });
}

function reprocessAll() {
  for (const item of state.items) {
    item.mask?.close?.();
    item.mask = null;
    item.wandSource = null;
    process(item);
  }
  renderQueue();
  renderPreview();
}

/* ── Busy / status chrome ─────────────────────────────────────────────── */

function showBusy(on, label = '') {
  $('stage-busy').hidden = !on;
  if (label) $('busy-label').textContent = label;
  if (!on) setProgress(0, '');
  setEngine(on ? 'busy' : 'ready');
}

function setProgress(fraction, hint) {
  $('progress-bar').style.width = `${Math.round(fraction * 100)}%`;
  $('busy-hint').textContent = hint;
}

let backendLabel = '';
function setEngine(status) {
  $('engine-dot').className = `dot ${status}`;
  $('engine-label').textContent = status === 'error' ? 'Error' : backendLabel;
}

/* ── History ──────────────────────────────────────────────────────────── */

const cloneOp = (op) => ({
  ...op,
  points: op.points?.map((p) => [...p]),
  seed: op.seed ? [...op.seed] : undefined
});

function snapshot() {
  const item = activeItem();
  return {
    itemId: state.activeId,
    edge: { ...state.edge },
    scene: { ...state.scene },
    activeTextId: state.activeTextId,
    selectedLayerId: state.selectedLayerId,
    edits: item ? item.edits.map(cloneOp) : [],
    texts: item ? item.texts.map((t) => ({ ...t })) : [],
    layers: item ? item.layers.map((l) => ({ ...l })) : []
  };
}

function restore(snap) {
  state.edge = { ...snap.edge };
  state.scene = { ...snap.scene };
  state.activeTextId = snap.activeTextId;
  state.selectedLayerId = snap.selectedLayerId;

  const item = state.items.find((i) => i.id === snap.itemId);
  if (item) {
    // Matte edits are stored as geometry, so undo replays them rather than
    // keeping pixel snapshots — cheap in memory, exact on replay.
    const editsChanged = item.edits.length !== snap.edits.length;
    item.edits = snap.edits.map(cloneOp);
    item.texts = snap.texts.map((t) => ({ ...t }));
    item.layers = snap.layers.map((l) => ({ ...l }));
    if (item.mask && editsChanged) repaintEdits(item);
    state.activeId = item.id;
  }

  syncControls();
  renderTextLayers();
  renderObjectLayers();
  renderQueue();
  renderPreview();
}

/** Capture the pre-edit state once per interaction; `commitEdit` closes it out. */
function beginEdit() {
  state.pending ??= snapshot();
}

function commitEdit() {
  if (!state.pending) return;
  state.history.push(state.pending);
  if (state.history.length > 60) state.history.shift();
  state.pending = null;
  state.future.length = 0;
  updateHistoryButtons();
}

function edit(mutate) {
  beginEdit();
  mutate();
  commitEdit();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  restore(state.history.pop());
  updateHistoryButtons();
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $('undo').disabled = state.history.length === 0;
  $('redo').disabled = state.future.length === 0;
}

/* ── Export ───────────────────────────────────────────────────────────── */

async function toBlob(item) {
  const canvas = document.createElement('canvas');
  render(canvas, item, null);

  let target = canvas;
  if (state.format === 'image/jpeg' && state.scene.bgMode === 'transparent') {
    // JPEG has no alpha; put the cutout on white rather than emitting black.
    target = document.createElement('canvas');
    target.width = canvas.width;
    target.height = canvas.height;
    const ctx = target.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(canvas, 0, 0);
  }

  const quality = state.format === 'image/png' ? undefined : 0.92;
  const blob = await new Promise((res) => target.toBlob(res, state.format, quality));
  if (!blob) throw new Error('Encoding failed');
  return blob;
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function downloadActive() {
  const item = activeItem();
  if (!item?.mask) return;
  showBusy(true, 'Rendering at full resolution…');
  setProgress(0.5, '');
  try {
    const blob = await toBlob(item);
    saveBlob(blob, outputName(item));
    $('size-note').textContent = `Saved ${formatBytes(blob.size)}`;
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  } finally {
    showBusy(false);
  }
}

async function downloadAll() {
  const ready = state.items.filter((i) => i.mask);
  if (!ready.length) return;
  showBusy(true, 'Rendering all images…');
  try {
    const files = [];
    for (const [i, item] of ready.entries()) {
      setProgress(i / ready.length, `${i + 1} of ${ready.length}`);
      files.push({ name: outputName(item), blob: await toBlob(item) });
    }
    setProgress(1, 'Packing zip…');
    const zip = await createZip(files);
    saveBlob(zip, 'background-removed.zip');
    $('size-note').textContent = `Saved ${ready.length} images · ${formatBytes(zip.size)}`;
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  } finally {
    showBusy(false);
  }
}

function updateActions() {
  const item = activeItem();
  $('download').disabled = !item?.mask;
  $('download-all').disabled = !state.items.some((i) => i.mask) || state.items.length < 2;
}

/* ── Object layers ────────────────────────────────────────────────────── */

/** Redraw the overlay only when there is something to draw on. */
function paintOverlaysSafely() {
  if (state.preview) repaintOnly();
}

function renderObjectLayers() {
  const list = $('object-layers');
  const item = activeItem();
  list.textContent = '';

  // Topmost first, matching what the eye sees on the canvas.
  for (const layer of [...(item?.layers ?? [])].reverse()) {
    const li = document.createElement('li');
    li.className = 'layer-item' + (layer.id === state.selectedLayerId ? ' is-active' : '');
    li.addEventListener('click', () => {
      state.selectedLayerId = layer.id;
      renderObjectLayers();
      paintOverlaysSafely();
    });

    const label = document.createElement('span');
    label.textContent = layer.name;
    const kind = document.createElement('span');
    kind.className = 'layer-kind';
    kind.textContent = layer.kind === 'subject' ? 'cutout' : 'image';
    li.append(label, kind);
    list.append(li);
  }

  const layer = selectedLayer();
  $('object-editor').hidden = !layer;
  if (layer) {
    const scalePct = Math.round(layer.sx * 100);
    const rotDeg = Math.round((layer.rot * 180) / Math.PI);
    $('layer-scale').value = clamp(scalePct, 5, 400);
    $('v-layer-scale').textContent = `${scalePct}%`;
    $('layer-rot').value = rotDeg;
    $('v-layer-rot').textContent = `${rotDeg}°`;
    $('layer-opacity').value = Math.round(layer.opacity * 100);
    $('v-layer-opacity').textContent = `${Math.round(layer.opacity * 100)}%`;
    $('del-layer').disabled = (item?.layers.length ?? 0) < 2;
  }
}

function duplicateLayer(layer) {
  const item = activeItem();
  const copy = { ...layer, id: nextLayerId++, name: `${layer.name} copy` };
  item.layers.splice(item.layers.indexOf(layer) + 1, 0, copy);
  state.selectedLayerId = copy.id;
  return copy;
}

async function addImageLayer(file, { atBottom = false } = {}) {
  const item = activeItem();
  if (!item) { toast('Add an image first.'); return; }
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    toast('Could not load that image.');
    return;
  }

  // Size it to cover the current frame, so a backdrop lands ready to use.
  const p = state.preview;
  const frameW = p ? p.frame.width / p.scale : item.bitmap.width;
  const frameH = p ? p.frame.height / p.scale : item.bitmap.height;
  const cover = Math.max(frameW / bitmap.width, frameH / bitmap.height);

  edit(() => {
    const layer = {
      id: nextLayerId++,
      kind: 'image',
      name: file.name?.replace(/\.[^.]+$/, '') || 'Image',
      bitmap,
      ...LAYER_DEFAULTS,
      sx: cover,
      sy: cover
    };
    if (atBottom) item.layers.unshift(layer);
    else item.layers.push(layer);
    state.selectedLayerId = layer.id;
  });

  setTool('objects');
  renderObjectLayers();
  renderPreview();
}

/* ── Text layers ──────────────────────────────────────────────────────── */

function renderTextLayers() {
  const list = $('text-layers');
  const item = activeItem();
  list.textContent = '';

  for (const layer of item?.texts ?? []) {
    const li = document.createElement('li');
    li.className = 'layer-item' + (layer.id === state.activeTextId ? ' is-active' : '');
    li.addEventListener('click', () => { state.activeTextId = layer.id; renderTextLayers(); });

    const label = document.createElement('span');
    label.textContent = layer.text || 'Empty text';
    const remove = document.createElement('button');
    remove.textContent = '×';
    remove.title = 'Delete';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      edit(() => {
        item.texts = item.texts.filter((t) => t.id !== layer.id);
        if (state.activeTextId === layer.id) state.activeTextId = item.texts[0]?.id ?? null;
      });
      renderTextLayers();
      renderPreview();
    });
    li.append(label, remove);
    list.append(li);
  }

  const layer = activeText();
  $('text-editor').hidden = !layer;
  if (layer) {
    $('text-content').value = layer.text;
    $('text-size').value = layer.size;
    $('v-text-size').textContent = `${layer.size}%`;
    $('text-font').value = layer.font;
    $('text-weight').value = layer.weight;
    $('text-color').value = layer.color;
    $('text-outline').checked = layer.outline;
    $('text-outline-color').value = layer.outlineColor;
  }
}

function addTextLayer() {
  const item = activeItem();
  if (!item) { toast('Add an image first.'); return; }
  edit(() => {
    const layer = {
      id: nextTextId++,
      text: 'Your text',
      x: 0.5,
      y: 0.85,
      size: 8,
      font: 'system-ui, sans-serif',
      weight: '700',
      color: '#ffffff',
      outline: true,
      outlineColor: '#000000',
      opacity: 1
    };
    item.texts.push(layer);
    state.activeTextId = layer.id;
  });
  renderTextLayers();
  renderPreview();
}

function updateActiveText(patch, { commit = true } = {}) {
  const layer = activeText();
  if (!layer) return;
  beginEdit();
  Object.assign(layer, patch);
  if (commit) commitEdit();
  renderPreview();
}

/* ── Pointer interaction on the canvas ────────────────────────────────── */

/** Canvas client coordinates → canvas pixels and original-image pixels. */
function toImageCoords(event) {
  const p = state.preview;
  if (!p) return null;
  const canvas = $('canvas-result');
  const rect = canvas.getBoundingClientRect();
  const canvasX = (event.clientX - rect.left) * (canvas.width / rect.width);
  const canvasY = (event.clientY - rect.top) * (canvas.height / rect.height);
  // The subject is drawn 1:1 into the frame at its offset, so this inverts exactly.
  return {
    x: (p.crop.x + canvasX - p.frame.offsetX) / p.scale,
    y: (p.crop.y + canvasY - p.frame.offsetY) / p.scale,
    canvasX,
    canvasY
  };
}

/** Which handle of the selected layer, if any, is under this canvas point? */
function handleAt(canvasX, canvasY) {
  const p = state.preview;
  const box = p?.boxes.get(state.selectedLayerId);
  if (!box) return null;

  const grab = (HANDLE_PX * 1.6) / p.cssScale;
  const local = rotate(canvasX - box.cx, canvasY - box.cy, -box.rot);

  const stalkY = -box.h / 2 - ROTATE_OFFSET_PX / p.cssScale;
  if (Math.hypot(local.x, local.y - stalkY) <= grab) return 'rotate';

  for (const [id, [dx, dy]] of Object.entries(HANDLE_DIRS)) {
    const hx = (dx * box.w) / 2;
    const hy = (dy * box.h) / 2;
    if (Math.abs(local.x - hx) <= grab && Math.abs(local.y - hy) <= grab) return id;
  }
  return null;
}

let stroke = null;
let drawnPoints = 0;
let textDrag = null;
let objectDrag = null;
let compareDrag = false;
let panDrag = null;
let frameQueued = false;

function queueFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; renderPreview(); });
}

function beginPan(event) {
  const stage = $('stage');
  panDrag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  stage.classList.add('is-grabbing');
}

/**
 * Set up a resize or rotate drag.
 *
 * Resizing pins the opposite handle: its world position is captured up front,
 * and every frame recomputes size and centre from the pointer's offset from
 * that fixed anchor — which is what makes a handle drag feel like it grabs the
 * box's edge rather than its middle.
 */
function startTransform(handle, box, at) {
  const p = state.preview;
  const layer = selectedLayer();

  if (handle === 'rotate') {
    return {
      kind: 'rotate',
      layer,
      startRot: layer.rot,
      startAngle: Math.atan2(at.canvasY - box.cy, at.canvasX - box.cx)
    };
  }

  const [dx, dy] = HANDLE_DIRS[handle];
  const anchorOffset = rotate((-dx * box.w) / 2, (-dy * box.h) / 2, box.rot);

  return {
    kind: 'scale',
    layer,
    dx,
    dy,
    rot: box.rot,
    startW: box.w,
    startH: box.h,
    anchorX: box.cx + anchorOffset.x,
    anchorY: box.cy + anchorOffset.y,
    baseX: box.baseX,
    baseY: box.baseY,
    natural: naturalSize(layer, p.subject, p.scale)
  };
}

function applyTransform(drag, at) {
  const p = state.preview;
  const { layer } = drag;

  if (drag.kind === 'move') {
    layer.tx = drag.startTx + (at.canvasX - drag.originX) / p.scale;
    layer.ty = drag.startTy + (at.canvasY - drag.originY) / p.scale;
    return;
  }

  if (drag.kind === 'rotate') {
    const box = p.boxes.get(layer.id);
    const angle = Math.atan2(at.canvasY - box.cy, at.canvasX - box.cx);
    layer.rot = drag.startRot + (angle - drag.startAngle);
    return;
  }

  // Pointer offset from the pinned anchor, expressed in the layer's own axes.
  const v = rotate(at.canvasX - drag.anchorX, at.canvasY - drag.anchorY, -drag.rot);

  let w = drag.startW;
  let h = drag.startH;
  if (drag.dx && drag.dy) {
    // Corner: uniform, so the layer keeps its proportions.
    const factor = Math.max(Math.abs(v.x) / drag.startW, Math.abs(v.y) / drag.startH);
    w = drag.startW * factor;
    h = drag.startH * factor;
  } else if (drag.dx) {
    w = Math.abs(v.x);
  } else {
    h = Math.abs(v.y);
  }

  w = Math.max(4, w);
  h = Math.max(4, h);

  const centreOffset = rotate((drag.dx * w) / 2, (drag.dy * h) / 2, drag.rot);
  layer.sx = w / (drag.natural.w * p.scale);
  layer.sy = h / (drag.natural.h * p.scale);
  layer.tx = (drag.anchorX + centreOffset.x - drag.baseX) / p.scale;
  layer.ty = (drag.anchorY + centreOffset.y - drag.baseY) / p.scale;
}

function onPointerDown(event) {
  const item = activeItem();
  const p = state.preview;

  if (state.panning) {
    event.preventDefault();
    beginPan(event);
    return;
  }
  if (!item || !p) return;

  if (state.view === 'compare' && event.target.closest('.compare-handle')) {
    compareDrag = true;
    $('checker').setPointerCapture(event.pointerId);
    return;
  }

  const at = toImageCoords(event);
  if (!at) return;
  const canvas = $('canvas-result');

  if (state.tool === 'objects') {
    const box = p.boxes.get(state.selectedLayerId);
    const handle = handleAt(at.canvasX, at.canvasY);

    if (handle && box) {
      beginEdit();
      objectDrag = startTransform(handle, box, at);
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    // Topmost layer under the cursor wins, matching paint order.
    for (const layer of [...item.layers].reverse()) {
      const lb = p.boxes.get(layer.id);
      if (!lb || !hitTest(lb, at.canvasX, at.canvasY)) continue;

      beginEdit();
      const target = event.altKey ? duplicateLayer(layer) : layer;
      state.selectedLayerId = target.id;
      objectDrag = {
        kind: 'move',
        layer: target,
        startTx: target.tx,
        startTy: target.ty,
        originX: at.canvasX,
        originY: at.canvasY
      };
      canvas.setPointerCapture(event.pointerId);
      renderObjectLayers();
      repaintOnly();
      return;
    }

    state.selectedLayerId = null;
    renderObjectLayers();
    repaintOnly();
    return;
  }

  if (state.tool === 'design') {
    const ctx = canvas.getContext('2d');
    for (const layer of [...item.texts].reverse()) {
      const tb = measureText(ctx, p.frame, layer);
      if (at.canvasX >= tb.x && at.canvasX <= tb.x + tb.w &&
          at.canvasY >= tb.y && at.canvasY <= tb.y + tb.h) {
        state.activeTextId = layer.id;
        beginEdit();
        textDrag = {
          layer,
          dx: layer.x * p.frame.width - at.canvasX,
          dy: layer.y * p.frame.height - at.canvasY
        };
        canvas.setPointerCapture(event.pointerId);
        renderTextLayers();
        return;
      }
    }
    return;
  }

  if (state.tool !== 'cutout' || state.brush.mode === 'off') return;

  if (state.brush.mode === 'wand') {
    edit(() => {
      const op = {
        type: 'wand',
        mode: state.wand.action,
        seed: [at.x, at.y],
        tolerance: state.wand.tolerance,
        contiguous: state.wand.contiguous
      };
      item.edits.push(op);
      applyEditOp(item, op);
    });
    renderPreview();
    return;
  }

  beginEdit();
  stroke = { type: 'stroke', mode: state.brush.mode, size: state.brush.size, points: [[at.x, at.y]] };
  item.edits.push(stroke);
  drawStroke(paintLayer(item).getContext('2d'), stroke, paintRatio(item));
  drawnPoints = 1;
  canvas.setPointerCapture(event.pointerId);
  queueFrame();
}

function onPointerMove(event) {
  const item = activeItem();

  if (panDrag) {
    const stage = $('stage');
    stage.scrollLeft = panDrag.left - (event.clientX - panDrag.x);
    stage.scrollTop = panDrag.top - (event.clientY - panDrag.y);
    return;
  }

  if (compareDrag) {
    const rect = $('checker').getBoundingClientRect();
    state.splitPct = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100);
    repaintOnly();
    return;
  }

  if (objectDrag) {
    applyTransform(objectDrag, toImageCoords(event));
    repaintOnly();
    return;
  }

  if (textDrag && state.preview) {
    const at = toImageCoords(event);
    const { frame } = state.preview;
    textDrag.layer.x = clamp((at.canvasX + textDrag.dx) / frame.width, 0, 1);
    textDrag.layer.y = clamp((at.canvasY + textDrag.dy) / frame.height, 0, 1);
    repaintOnly();
    return;
  }

  if (stroke && item) {
    const at = toImageCoords(event);
    stroke.points.push([at.x, at.y]);
    // Only the new segment needs drawing; the layer keeps everything before it.
    drawStroke(paintLayer(item).getContext('2d'), stroke, paintRatio(item), drawnPoints);
    drawnPoints = stroke.points.length;
    queueFrame();
  }
}

function onPointerUp() {
  if (panDrag) {
    panDrag = null;
    $('stage').classList.remove('is-grabbing');
    return;
  }
  if (compareDrag) { compareDrag = false; return; }
  if (objectDrag) {
    objectDrag = null;
    commitEdit();
    renderObjectLayers();
    return;
  }
  if (textDrag) { textDrag = null; commitEdit(); renderTextLayers(); return; }
  if (stroke) {
    stroke = null;
    commitEdit();
    renderPreview();
  }
}

/* ── Brush cursor ─────────────────────────────────────────────────────── */

const ring = document.createElement('div');
ring.className = 'brush-ring';
ring.hidden = true;
document.body.append(ring);

function updateRing(event) {
  const painting = state.tool === 'cutout'
    && (state.brush.mode === 'erase' || state.brush.mode === 'restore');
  const active = painting && state.preview && !state.panning;
  ring.hidden = !active;
  if (!active) return;
  const size = state.brush.size * state.preview.zoom;
  ring.style.width = `${size}px`;
  ring.style.height = `${size}px`;
  ring.style.left = `${event.clientX}px`;
  ring.style.top = `${event.clientY}px`;
  ring.classList.toggle('restore', state.brush.mode === 'restore');
}

/* ── Zoom & pan ───────────────────────────────────────────────────────── */

let zoomRebuildTimer;

/**
 * Apply a zoom level.
 *
 * The CSS size updates immediately so wheel zoom feels continuous, and the
 * expensive re-render at the new resolution is debounced behind it.
 */
function setZoom(zoom) {
  state.zoom = zoom;
  const p = state.preview;
  const item = activeItem();
  if (p && item) {
    p.zoom = zoom === 'fit' ? fitScale(item) : zoom;
    p.cssScale = p.zoom / p.scale;
    applyCanvasSize();
    paintOverlays();
  }
  clearTimeout(zoomRebuildTimer);
  zoomRebuildTimer = setTimeout(renderPreview, 180);
}

/** Zoom keeping the point under the cursor pinned in place. */
function zoomAt(zoom, clientX, clientY) {
  const stage = $('stage');
  const canvas = $('canvas-result');
  const before = canvas.getBoundingClientRect();
  const fx = (clientX - before.left) / before.width;
  const fy = (clientY - before.top) / before.height;

  setZoom(zoom);

  const after = canvas.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - clientX;
  stage.scrollTop += after.top + fy * after.height - clientY;
}

/* ── Control wiring ───────────────────────────────────────────────────── */

let renderTimer;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => requestAnimationFrame(renderPreview), 40);
}

/** id → [state bucket, key, label formatter] */
const SLIDERS = {
  feather: ['edge', 'feather', (v) => `${v.toFixed(2)} px`],
  shift: ['edge', 'shift', (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} px`],
  contrast: ['edge', 'contrast', (v) => `${v.toFixed(1)}×`],
  bgBlur: ['scene', 'bgBlur', (v) => `${v} px`],
  shadowOpacity: ['scene', 'shadowOpacity', (v) => `${v}%`],
  shadowBlur: ['scene', 'shadowBlur', (v) => `${v} px`],
  shadowX: ['scene', 'shadowX', (v) => `${v} px`],
  shadowY: ['scene', 'shadowY', (v) => `${v} px`],
  brightness: ['scene', 'brightness', (v) => `${v}%`],
  contrastAdj: ['scene', 'contrast', (v) => `${v}%`],
  saturation: ['scene', 'saturation', (v) => `${v}%`],
  padding: ['scene', 'padding', (v) => `${v}%`],
  brushSize: ['brush', 'size', (v) => `${v} px`],
  wandTolerance: ['wand', 'tolerance', (v) => `${v}`]
};

function syncControls() {
  for (const [id, [bucket, key, format]] of Object.entries(SLIDERS)) {
    const input = $(id);
    input.value = state[bucket][key];
    $(`v-${id}`).textContent = format(Number(input.value));
  }
  $('despill').checked = state.edge.despill;
  $('trim').checked = state.edge.trim;
  $('shadow').checked = state.scene.shadow;
  $('shadowColor').value = state.scene.shadowColor;
  $('bgColor').value = state.scene.bgColor;
  $('v-bgColor').textContent = state.scene.bgColor;
  $('aspect').value = state.scene.aspect;
  $('wandContiguous').checked = state.wand.contiguous;

  for (const btn of $('bg-modes').children) {
    btn.classList.toggle('is-active', btn.dataset.bg === state.scene.bgMode);
  }
  // Swatches and the photo button stay visible in every mode; hiding them left
  // the panel looking empty on first open.
  for (const section of document.querySelectorAll('[data-bg-section]')) {
    section.hidden = section.dataset.bgSection === 'blur' && state.scene.bgMode !== 'blur';
  }
  for (const btn of $('brush-modes').children) {
    btn.classList.toggle('is-active', btn.dataset.brush === state.brush.mode);
  }
  for (const sw of $('swatches').children) {
    sw.classList.toggle('is-active', sw.dataset.color === state.scene.bgColor);
  }
  $('wand-opts').hidden = state.brush.mode !== 'wand';
  $('brush-size-ctrl').hidden = state.brush.mode === 'wand' || state.brush.mode === 'off';
  $('wand-remove').classList.toggle('is-active', state.wand.action === 'erase');
  $('wand-keep').classList.toggle('is-active', state.wand.action === 'restore');
}

function bindSliders() {
  for (const [id, [bucket, key, format]] of Object.entries(SLIDERS)) {
    const input = $(id);
    // Brush and wand settings are tool state, not picture state: no re-render.
    const live = bucket !== 'brush' && bucket !== 'wand';
    input.addEventListener('input', () => {
      if (live) beginEdit();
      state[bucket][key] = Number(input.value);
      $(`v-${id}`).textContent = format(Number(input.value));
      if (live) scheduleRender();
    });
    input.addEventListener('change', () => { if (live) commitEdit(); });
  }
}

function bindToggles() {
  const toggles = [
    ['despill', 'edge', 'despill'],
    ['trim', 'edge', 'trim'],
    ['shadow', 'scene', 'shadow']
  ];
  for (const [id, bucket, key] of toggles) {
    $(id).addEventListener('change', (e) => {
      edit(() => { state[bucket][key] = e.target.checked; });
      renderPreview();
    });
  }

  $('wandContiguous').addEventListener('change', (e) => {
    state.wand.contiguous = e.target.checked;
  });

  $('shadowColor').addEventListener('input', () => {
    beginEdit();
    state.scene.shadowColor = $('shadowColor').value;
    scheduleRender();
  });
  $('shadowColor').addEventListener('change', commitEdit);

  $('aspect').addEventListener('change', (e) => {
    edit(() => { state.scene.aspect = e.target.value; });
    renderPreview();
  });
}

function buildSwatches() {
  const wrap = $('swatches');
  for (const colour of SWATCHES) {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.dataset.color = colour;
    btn.style.background = colour;
    btn.title = colour;
    btn.addEventListener('click', () => {
      edit(() => {
        state.scene.bgColor = colour;
        state.scene.bgMode = 'color';
      });
      syncControls();
      renderPreview();
    });
    wrap.append(btn);
  }
}

function bindBackground() {
  $('bg-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    edit(() => { state.scene.bgMode = btn.dataset.bg; });
    syncControls();
    renderPreview();
  });

  $('bgColor').addEventListener('input', () => {
    beginEdit();
    state.scene.bgColor = $('bgColor').value;
    state.scene.bgMode = 'color';
    $('v-bgColor').textContent = state.scene.bgColor;
    scheduleRender();
  });
  $('bgColor').addEventListener('change', () => { commitEdit(); syncControls(); });

  $('pick-bg').addEventListener('click', () => {
    $('bg-input').dataset.position = 'bottom';
    $('bg-input').click();
  });
  $('add-layer-image').addEventListener('click', () => {
    $('bg-input').dataset.position = 'top';
    $('bg-input').click();
  });
  $('bg-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const atBottom = e.target.dataset.position === 'bottom';
    e.target.value = '';
    if (file) await addImageLayer(file, { atBottom });
  });
}

function bindBrush() {
  $('brush-modes').addEventListener('click', (e) => {
    const btn = e.target.closest('.brush-btn');
    if (!btn) return;
    state.brush.mode = btn.dataset.brush;
    syncControls();
    const painting = state.brush.mode === 'erase' || state.brush.mode === 'restore';
    $('stage').classList.toggle('is-painting', painting);
    if (!painting) ring.hidden = true;
  });

  for (const [id, action] of [['wand-remove', 'erase'], ['wand-keep', 'restore']]) {
    $(id).addEventListener('click', () => {
      state.wand.action = action;
      syncControls();
    });
  }

  $('clear-strokes').addEventListener('click', () => {
    const item = activeItem();
    if (!item?.edits.length) return;
    edit(() => { item.edits = []; });
    repaintEdits(item);
    renderPreview();
  });
}

function bindObjects() {
  const applyToLayer = (patch) => {
    const layer = selectedLayer();
    if (!layer) return;
    beginEdit();
    Object.assign(layer, patch);
    repaintOnly();
  };

  $('layer-scale').addEventListener('input', (e) => {
    const factor = Number(e.target.value) / 100;
    $('v-layer-scale').textContent = `${e.target.value}%`;
    applyToLayer({ sx: factor, sy: factor });
  });
  $('layer-scale').addEventListener('change', commitEdit);

  $('layer-rot').addEventListener('input', (e) => {
    $('v-layer-rot').textContent = `${e.target.value}°`;
    applyToLayer({ rot: (Number(e.target.value) * Math.PI) / 180 });
  });
  $('layer-rot').addEventListener('change', commitEdit);

  $('layer-opacity').addEventListener('input', (e) => {
    $('v-layer-opacity').textContent = `${e.target.value}%`;
    applyToLayer({ opacity: Number(e.target.value) / 100 });
  });
  $('layer-opacity').addEventListener('change', commitEdit);

  $('dup-layer').addEventListener('click', () => {
    const layer = selectedLayer();
    if (!layer) return;
    edit(() => {
      const copy = duplicateLayer(layer);
      // Nudge the copy so it reads as a separate object straight away.
      copy.tx += 24;
      copy.ty += 24;
    });
    renderObjectLayers();
    renderPreview();
  });

  $('del-layer').addEventListener('click', () => {
    const item = activeItem();
    const layer = selectedLayer();
    if (!item || !layer || item.layers.length < 2) return;
    edit(() => {
      item.layers = item.layers.filter((l) => l.id !== layer.id);
      state.selectedLayerId = item.layers.at(-1)?.id ?? null;
    });
    renderObjectLayers();
    renderPreview();
  });

  const reorder = (delta) => {
    const item = activeItem();
    const layer = selectedLayer();
    if (!item || !layer) return;
    const from = item.layers.indexOf(layer);
    const to = clamp(from + delta, 0, item.layers.length - 1);
    if (to === from) return;
    edit(() => {
      item.layers.splice(from, 1);
      item.layers.splice(to, 0, layer);
    });
    renderObjectLayers();
    renderPreview();
  };
  $('layer-up').addEventListener('click', () => reorder(1));
  $('layer-down').addEventListener('click', () => reorder(-1));

  $('reset-transform').addEventListener('click', () => {
    const layer = selectedLayer();
    if (!layer) return;
    edit(() => { Object.assign(layer, { tx: 0, ty: 0, rot: 0, sx: 1, sy: 1 }); });
    renderObjectLayers();
    renderPreview();
  });
}

function bindText() {
  $('add-text').addEventListener('click', addTextLayer);
  $('text-content').addEventListener('input', (e) => {
    updateActiveText({ text: e.target.value }, { commit: false });
    const active = $('text-layers').querySelector('.is-active span');
    if (active) active.textContent = e.target.value || 'Empty text';
  });
  $('text-content').addEventListener('change', commitEdit);

  $('text-size').addEventListener('input', (e) => {
    $('v-text-size').textContent = `${e.target.value}%`;
    updateActiveText({ size: Number(e.target.value) }, { commit: false });
  });
  $('text-size').addEventListener('change', commitEdit);

  for (const [id, key] of [
    ['text-font', 'font'],
    ['text-weight', 'weight'],
    ['text-color', 'color'],
    ['text-outline-color', 'outlineColor']
  ]) {
    $(id).addEventListener('input', (e) => updateActiveText({ [key]: e.target.value }, { commit: false }));
    $(id).addEventListener('change', commitEdit);
  }
  $('text-outline').addEventListener('change', (e) => updateActiveText({ outline: e.target.checked }));
}

function bindZoom() {
  $('zoom-in').addEventListener('click', () => {
    const current = state.preview?.zoom ?? 1;
    setZoom(ZOOM_STEPS.find((z) => z > current + 0.001) ?? ZOOM_STEPS.at(-1));
  });
  $('zoom-out').addEventListener('click', () => {
    const current = state.preview?.zoom ?? 1;
    setZoom([...ZOOM_STEPS].reverse().find((z) => z < current - 0.001) ?? ZOOM_STEPS[0]);
  });
  $('zoom-reset').addEventListener('click', () => setZoom('fit'));

  // Ctrl/⌘ + wheel zooms about the cursor, like every other canvas app.
  $('stage').addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (!state.preview) return;
    const next = clamp(state.preview.zoom * Math.exp(-event.deltaY * 0.0016), ...ZOOM_LIMITS);
    zoomAt(next, event.clientX, event.clientY);
  }, { passive: false });
}

function setTool(tool) {
  state.tool = tool;
  for (const t of $('tool-tabs').children) t.classList.toggle('is-active', t.dataset.tool === tool);
  for (const panel of document.querySelectorAll('.tool-panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === tool);
  }
  if (tool !== 'cutout') {
    state.brush.mode = 'off';
    syncControls();
    $('stage').classList.remove('is-painting');
  }
  $('stage').classList.toggle('is-objects', tool === 'objects');
  ring.hidden = true;
  paintOverlaysSafely();
}

function bindResets() {
  $('reset-refine').addEventListener('click', () => {
    edit(() => { state.edge = { ...DEFAULTS }; });
    syncControls();
    renderPreview();
  });
  $('reset-shadow').addEventListener('click', () => {
    edit(() => {
      for (const key of ['shadow', 'shadowBlur', 'shadowOpacity', 'shadowX', 'shadowY', 'shadowColor']) {
        state.scene[key] = SCENE_DEFAULTS[key];
      }
    });
    syncControls();
    renderPreview();
  });
  $('reset-adjust').addEventListener('click', () => {
    edit(() => {
      for (const key of ['brightness', 'contrast', 'saturation', 'aspect', 'padding']) {
        state.scene[key] = SCENE_DEFAULTS[key];
      }
    });
    syncControls();
    renderPreview();
  });
}

function bindKeyboard() {
  const isTyping = (el) => el?.matches?.('input[type="text"], input[type="color"], select');

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e.target) && !state.panning) {
      state.panning = true;
      $('stage').classList.add('is-panning');
      ring.hidden = true;
      e.preventDefault();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && !isTyping(e.target)
        && state.tool === 'objects' && state.selectedLayerId) {
      e.preventDefault();
      $('del-layer').click();
      return;
    }

    if (e.key === 'Escape' && state.tool === 'objects') {
      state.selectedLayerId = null;
      renderObjectLayers();
      paintOverlaysSafely();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !isTyping(e.target)) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    }
  });

  const stopPanning = () => {
    state.panning = false;
    $('stage').classList.remove('is-panning', 'is-grabbing');
    panDrag = null;
  };
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') stopPanning(); });
  // A tab-away while Space is held would otherwise leave pan mode stuck on.
  window.addEventListener('blur', stopPanning);
}

function init() {
  const backend = describeBackend();
  backendLabel = backend.label;
  setEngine('ready');
  if (!backend.isolated && backend.device === 'cpu') {
    $('engine-status').title =
      'Single-threaded WASM. Serve the app with npm start for cross-origin isolation and multi-threaded inference.';
  }

  buildSwatches();
  bindSliders();
  bindToggles();
  bindBackground();
  bindBrush();
  bindObjects();
  bindText();
  bindZoom();
  bindResets();
  bindKeyboard();
  syncControls();

  $('tool-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tool');
    if (btn) setTool(btn.dataset.tool);
  });

  $('view-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    state.view = btn.dataset.view;
    for (const s of $('view-tabs').children) s.classList.toggle('is-active', s === btn);
    repaintOnly();
  });

  // Canvas interaction: strokes, wand taps, object transforms, text, compare, pan.
  const checker = $('checker');
  checker.addEventListener('pointerdown', onPointerDown);
  checker.addEventListener('pointermove', onPointerMove);
  // Panning also works from the empty area around the canvas.
  $('stage').addEventListener('pointerdown', (e) => {
    if (state.panning && !e.target.closest('#checker')) onPointerDown(e);
  });
  window.addEventListener('pointermove', (e) => { if (panDrag) onPointerMove(e); });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', updateRing);
  checker.addEventListener('pointerleave', () => { ring.hidden = true; });

  $('format').addEventListener('change', (e) => {
    state.format = e.target.value;
    updateMeta();
  });

  $('model').addEventListener('change', (e) => {
    state.model = e.target.value;
    if (state.items.length) reprocessAll();
  });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);

  // Input sources
  $('dropzone').addEventListener('click', () => $('file-input').click());
  $('dropzone').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
  });
  $('file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    $('drag-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; $('drag-overlay').hidden = true; }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drag-overlay').hidden = true;
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  $('clear-all').addEventListener('click', () => {
    for (const item of state.items.slice()) removeItem(item.id);
  });
  $('download').addEventListener('click', downloadActive);
  $('download-all').addEventListener('click', downloadAll);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderPreview, 150);
  });

  updateActions();
  updateHistoryButtons();
}

init();

// Exposed for the automated smoke test in scripts/test.mjs.
window.__app = {
  state, addFiles, toBlob, activeItem, renderPreview, undo, redo, setTool, setZoom
};
