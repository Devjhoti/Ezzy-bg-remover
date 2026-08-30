/**
 * Thin wrapper around the ISNet segmentation model.
 *
 * Two deliberate choices here:
 *
 *  - We call `segmentForeground`, which returns the raw matte, rather than a
 *    finished cutout. Keeping the matte means every refinement control
 *    re-composites in milliseconds instead of re-running inference.
 *  - Pixels go in and out through the library's raw `image/x-rgba8` format,
 *    which skips a PNG encode on the way in and a decode on the way out.
 */
import { segmentForeground } from '@imgly/background-removal';

/** Where the .onnx and .wasm files come from. A vendored local copy wins if present. */
const CDN_PATH = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';

let pathPromise = null;

/** Use models from ./models (offline, no CDN round-trip) when `npm run vendor` has been run. */
function resolvePublicPath() {
  pathPromise ??= fetch('/app-config.json')
    .then((res) => (res.ok ? res.json() : null))
    .then((cfg) => cfg?.modelsPath || CDN_PATH)
    .catch(() => CDN_PATH);
  return pathPromise;
}

export function describeBackend() {
  const gpu = 'gpu' in navigator;
  const isolated = globalThis.crossOriginIsolated === true;
  const threads = isolated ? navigator.hardwareConcurrency || 4 : 1;
  return {
    device: gpu ? 'gpu' : 'cpu',
    label: gpu ? 'WebGPU' : `WASM · ${threads} thread${threads === 1 ? '' : 's'}`,
    isolated,
    threads
  };
}

/**
 * Fetch progress arrives per file. Roll the individual streams into one
 * fraction so the UI can show a single honest bar.
 */
function progressAggregator(onProgress) {
  const streams = new Map();
  return (key, current, total) => {
    if (!onProgress) return;
    streams.set(key, { current, total: total || current || 1 });
    let done = 0;
    let size = 0;
    for (const s of streams.values()) {
      done += s.current;
      size += s.total;
    }
    onProgress({
      fraction: size > 0 ? Math.min(1, done / size) : 0,
      downloading: key.startsWith('fetch'),
      bytes: done,
      totalBytes: size
    });
  };
}

async function buildConfig({ model, onProgress }) {
  return {
    publicPath: await resolvePublicPath(),
    device: describeBackend().device,
    model,
    output: { format: 'image/x-rgba8', quality: 1 },
    progress: progressAggregator(onProgress)
  };
}

/**
 * Run segmentation over an ImageData.
 *
 * @returns {Promise<ImageData>} The matte as an opaque greyscale image at the
 *   same size as the input — greyscale rather than an alpha channel so later
 *   canvas reads never round-trip through premultiplied alpha.
 */
export async function segment(source, { model, onProgress }) {
  const { width, height, data } = source;
  const input = new Blob([data], { type: `image/x-rgba8;width=${width};height=${height}` });

  const output = await segmentForeground(input, await buildConfig({ model, onProgress }));
  const bytes = new Uint8Array(await output.arrayBuffer());

  const mask = new ImageData(width, height);
  const out = mask.data;
  for (let i = 0, n = width * height; i < n; i++) {
    const p = i * 4;
    const a = bytes[p + 3];
    out[p] = a;
    out[p + 1] = a;
    out[p + 2] = a;
    out[p + 3] = 255;
  }
  return mask;
}

/** Serialise inference — the model is the bottleneck, parallel calls only thrash. */
let tail = Promise.resolve();
export function enqueue(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}
