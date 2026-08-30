# Background Remover

Removes image backgrounds and exports high-quality transparent PNGs. Everything —
model download, inference, compositing — happens in the browser. No server-side
processing, no API keys, no uploads.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:5173
```

The first cutout downloads the ~80 MB model from the IMG.LY CDN and the browser
caches it; every run after that is offline and instant.

## What it does

Segmentation runs **once** per image and the raw matte is cached, so every tool
below re-composites in milliseconds without ever touching the model again.

**Cutout** — feather, edge shift and matte contrast in real pixels; a
**magic-select wand** that takes a whole region of similar colour in one tap;
and erase/restore brushes for everything else. Trim to the subject.

**Background** — transparent, a solid colour (14 swatches or any custom value),
or the original scene blurred behind the subject. Photos drop in as movable
layers rather than a fixed backdrop.

**Objects** — the cutout and any imported image are layers you can move, resize,
rotate, reorder, duplicate and delete, with Photoshop-style selection handles.

**Effects** — drop shadow with opacity, blur, offset and colour.

**Adjust** — brightness, contrast and saturation; aspect-ratio reframing
(1:1, 4:5, 2:3, 3:2, 16:9, 9:16) that pads rather than crops, plus padding.

**Design** — text layers with font, weight, size, colour and outline. Drag them
into place directly on the canvas.

Everywhere: drag/drop/paste input, a compare slider against the original, and
full undo/redo, batch export as individual files or one `.zip`, and
PNG / WebP / JPEG output.

Not included, because they need something this app deliberately does not have:
a stock-photo library (a third-party API and key) and generative "expand image"
(a server-side diffusion model).

## Canvas shortcuts

| | |
| --- | --- |
| Drag | Move the selected object |
| Handles | Resize (corners keep proportions, edges do not); the stalk rotates |
| <kbd>Alt</kbd>+drag | Duplicate and move in one gesture |
| <kbd>Del</kbd> | Remove the selected object |
| <kbd>Ctrl</kbd>+wheel | Zoom about the cursor |
| <kbd>Space</kbd>+drag | Pan |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> | Undo / redo |
| <kbd>Esc</kbd> | Deselect |

## Why the output is clean

A segmentation mask alone makes a mediocre cutout. Three things in
[js/refine.js](js/refine.js) close the gap:

**Matte normalisation.** A saliency network rarely outputs a confident `1.0`
even in the middle of a subject. Exported raw, a "solid" subject lands near 90%
alpha and ghosts over any background. The matte is normalised against its own
peak, then run through a levels curve, so solid is solid and clear is clear.

**Pixel-denominated edge control.** The mask is blurred by *r* px, which spreads
each edge into a ramp roughly 2*r* wide. That ramp is near-linear, so moving the
re-threshold by *d* alpha units moves the edge by *d*·2*r* pixels — which is what
lets *feather* and *shift* be dialled in pixels rather than arbitrary units. The
transition band is clamped inside `[0, 1]` so full opacity and full transparency
remain reachable.

**Edge decontamination.** A semi-transparent pixel is a mix: `C = a·F + (1-a)·B`.
Keep `C` and it shows up as a coloured halo on the next background — the classic
green rim on anything cut out of foliage. The local background `B` is estimated
by averaging the image weighted by `(1-a)` into a coarse grid and blurring it
under the subject, then `F` is solved for directly. The included test measures
this: on a red disc over green, worst-case spill across the edge band is 0.0%.

Output is non-premultiplied RGBA, so the PNG composites correctly over anything.

## Controls

| Control | What it does |
| --- | --- |
| Edge feather | Width of the soft transition, in pixels. |
| Edge shift | Moves the matte edge in (negative) or out (positive). Slightly negative hides background fringe. |
| Matte contrast | Levels curve on the raw mask; pushes haze to fully clear. |
| Decontamination | Solves for true foreground colour on semi-transparent pixels. |
| Trim | Crops the transparent border to the subject's bounding box. |
| Magic select | Flood-fills from the tapped pixel by colour distance (or matches that colour image-wide with "connected areas" off), then feeds the region into the matte as an erase or a keep. |
| Erase / Restore | Paints corrections onto the matte. Both brush strokes and wand taps are stored as geometry, so undo replays them rather than snapshotting pixels. |
| Model | `isnet_fp16` (80 MB, default) · `isnet` (176 MB, best) · `isnet_quint8` (44 MB, fastest). |

## Performance

- **Cross-origin isolation.** [server.js](server.js) sets `Cross-Origin-Opener-Policy`
  and `Cross-Origin-Embedder-Policy`, which is what unlocks `SharedArrayBuffer` and
  multi-threaded WASM. Serving the folder with a generic static server works but
  runs inference single-threaded. WebGPU is used automatically when available.
- **Inference input is capped at 2048 px.** The network resizes to 1024² internally,
  so feeding it a 24 MP original is pure waste. Compositing and export still run at
  full resolution.
- **No image codec round-trips.** Pixels go to and from the model through the
  library's raw `image/x-rgba8` format instead of encoding and decoding PNGs.
- **Previews render downscaled**, exports at full size, both through the same code
  path with pixel settings scaled to match.

## Offline models

To serve the model and WASM runtime yourself instead of from the CDN:

```bash
npm run vendor            # runtime + the default balanced model
npm run vendor -- isnet   # a specific model
npm run vendor -- all     # everything, ~330 MB
```

Files land in `./models` and the app picks them up automatically on the next load.

## Tests

```bash
npm test
```

Boots the server, drives Chrome or Edge through a real cutout, and asserts on
the exported pixels — 30 checks covering the matte (background fully
transparent, subject fully opaque with its colour intact, plausible cutout area,
no edge spill), every editor tool (solid/blur backgrounds, aspect padding,
shadow, saturation, text), and the interactions, driven through real pointer,
wheel and keyboard events: an erase stroke, a wand tap and their undos, an
object drag, a handle resize, alt-duplicate, delete, ctrl+wheel zoom and
space+drag pan. Plus all three export formats, the zip writer, and a clean
console. Writes `screenshot.png`.

## Layout

```
index.html      markup and the import map that resolves onnxruntime-web
styles.css      styling
server.js       static server with the cross-origin isolation headers
js/engine.js    model config, raw-tensor I/O, single-file-at-a-time queue
js/refine.js    matte shaping, brush/wand edits, background estimation, decontamination
js/wand.js      scanline flood fill for one-tap region selection
js/compose.js   scene compositing: background, layer transforms, shadow, crop, text
js/app.js       UI, queue, tools, preview, transforms, history, export
js/zip.js       minimal stored-entry zip writer
scripts/        offline model vendoring, end-to-end test
```
