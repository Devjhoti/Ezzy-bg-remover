#!/usr/bin/env node
/**
 * End-to-end smoke test: boots the server, drives a real browser through a
 * synthetic image, and asserts the exported PNG is genuinely transparent where
 * the background was and opaque where the subject was.
 *
 *   npm test
 *
 * Needs puppeteer-core plus a local Chrome or Edge, and downloads the model on
 * the first run.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}/`;

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

function findBrowser() {
  const found = BROWSERS.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found for testing.');
  return found;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  // The import map points at ./vendor, which is generated rather than committed.
  const build = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'build.mjs'), '--vendor-only'], { stdio: 'ignore' });
  if (build.status !== 0) throw new Error('Build failed; run `npm install` first.');

  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return proc;
    } catch { /* not up yet */ }
    await wait(200);
  }
  proc.kill();
  throw new Error('Server did not start');
}

async function main() {
  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--enable-features=SharedArrayBuffer']
  });

  let failed = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto(URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction('window.__app !== undefined', { timeout: 15000 });

    const isolated = await page.evaluate(() => crossOriginIsolated);
    console.log(`  cross-origin isolated: ${isolated}`);
    if (errors.length) throw new Error(`Console errors on load:\n  ${errors.join('\n  ')}`);
    console.log('  ✓ page loads clean');

    // A red disc on a green field — unambiguous foreground and background.
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#1e9e4a';
      ctx.fillRect(0, 0, 512, 512);
      ctx.fillStyle = '#d81f26';
      ctx.beginPath();
      ctx.arc(256, 256, 150, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const file = new File([blob], 'disc.png', { type: 'image/png' });
      await window.__app.addFiles([file]);
    });

    console.log('  … downloading model and running inference (first run is slow)');
    await page.waitForFunction(
      () => window.__app.state.items[0]?.status === 'done' ||
            window.__app.state.items[0]?.status === 'error',
      { timeout: 600000, polling: 1000 }
    );

    const status = await page.evaluate(() => window.__app.state.items[0].status);
    if (status !== 'done') {
      const msg = await page.evaluate(() => window.__app.state.items[0].error);
      throw new Error(`Segmentation failed: ${msg}`);
    }
    console.log('  ✓ segmentation completed');

    // Export at full resolution and inspect the actual pixels.
    const probe = await page.evaluate(async () => {
      const blob = await window.__app.toBlob(window.__app.activeItem());
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => {
        const p = (y * c.width + x) * 4;
        return [d[p], d[p + 1], d[p + 2], d[p + 3]];
      };
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 250) opaque++;
      return {
        type: blob.type,
        size: blob.size,
        width: c.width,
        height: c.height,
        corner: at(4, 4),
        centre: at(256, 256),
        opaqueFraction: opaque / (c.width * c.height)
      };
    });

    console.log(`  output: ${probe.width}×${probe.height} ${probe.type} ${(probe.size / 1024).toFixed(0)} KB`);
    console.log(`  corner alpha=${probe.corner[3]}  centre=rgba(${probe.centre})  opaque=${(probe.opaqueFraction * 100).toFixed(1)}%`);

    const checks = [
      ['output is PNG', probe.type === 'image/png'],
      ['full resolution preserved', probe.width === 512 && probe.height === 512],
      ['background is fully transparent', probe.corner[3] === 0],
      ['subject is fully opaque', probe.centre[3] === 255],
      ['subject keeps its colour', probe.centre[0] > 150 && probe.centre[1] < 90],
      // A r=150 disc covers ~27% of a 512² frame.
      ['cutout area is plausible', probe.opaqueFraction > 0.18 && probe.opaqueFraction < 0.38]
    ];

    for (const [label, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${label}`);
      if (!ok) failed = true;
    }

    // The headline quality claim: semi-transparent edge pixels must not carry
    // the old background's colour, or the cutout haloes on a new background.
    const fringe = await page.evaluate(async () => {
      const blob = await window.__app.toBlob(window.__app.activeItem());
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let worst = 0;
      let count = 0;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        if (a < 40 || a > 215) continue; // only the soft edge band
        count++;
        // The discarded background was pure green; any green dominance is spill.
        const spill = (d[i + 1] - Math.max(d[i], d[i + 2])) / 255;
        if (spill > worst) worst = spill;
      }
      return { worst, count };
    });
    console.log(`  edge band: ${fringe.count} px, worst green spill ${(fringe.worst * 100).toFixed(1)}%`);
    const spillOk = fringe.count > 100 && fringe.worst < 0.12;
    console.log(`  ${spillOk ? '✓' : '✗'} edge pixels are free of background colour spill`);
    if (!spillOk) failed = true;

    // Both alternative export formats must round-trip.
    for (const [format, mime] of [['image/webp', 'image/webp'], ['image/jpeg', 'image/jpeg']]) {
      const info = await page.evaluate(async (fmt) => {
        const sel = document.getElementById('format');
        sel.value = fmt;
        sel.dispatchEvent(new Event('change'));
        const blob = await window.__app.toBlob(window.__app.activeItem());
        const bitmap = await createImageBitmap(blob);
        return { type: blob.type, size: blob.size, w: bitmap.width, h: bitmap.height };
      }, format);
      const ok = info.type === mime && info.size > 0 && info.w === 512;
      console.log(`  ${ok ? '✓' : '✗'} ${format} export (${(info.size / 1024).toFixed(0)} KB)`);
      if (!ok) failed = true;
    }
    await page.evaluate(() => {
      const sel = document.getElementById('format');
      sel.value = 'image/png';
      sel.dispatchEvent(new Event('change'));
    });

    /* ── Editor tools ──────────────────────────────────────────────── */

    // Probe the exported pixels under whatever scene settings are set.
    const probeExport = () => page.evaluate(async () => {
      const blob = await window.__app.toBlob(window.__app.activeItem());
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const at = (fx, fy) => {
        const x = Math.round(fx * (c.width - 1));
        const y = Math.round(fy * (c.height - 1));
        const p = (y * c.width + x) * 4;
        return [d[p], d[p + 1], d[p + 2], d[p + 3]];
      };
      let nonEmpty = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) nonEmpty++;
      return { w: c.width, h: c.height, at: { corner: at(0.02, 0.02), centre: at(0.5, 0.5) }, nonEmpty };
    });

    const setScene = (patch) => page.evaluate((p) => {
      Object.assign(window.__app.state.scene, p);
      window.__app.renderPreview();
    }, patch);

    const resetScene = () => page.evaluate(() => {
      Object.assign(window.__app.state.scene, {
        bgMode: 'transparent', shadow: false, aspect: 'original', padding: 0,
        brightness: 100, contrast: 100, saturation: 100
      });
      window.__app.renderPreview();
    });

    const baseline = await probeExport();

    // Solid-colour background must fill the frame opaquely.
    await setScene({ bgMode: 'color', bgColor: '#0000ff' });
    const coloured = await probeExport();
    const colourOk = coloured.at.corner[3] === 255 && coloured.at.corner[2] > 200 && coloured.at.corner[0] < 60;
    console.log(`  ${colourOk ? '✓' : '✗'} solid background fills opaquely (corner rgba=${coloured.at.corner})`);
    if (!colourOk) failed = true;
    await resetScene();

    // Blurred-original background keeps the scene but defocused, so the corner
    // becomes opaque green again rather than transparent.
    await setScene({ bgMode: 'blur', bgBlur: 20 });
    const blurred = await probeExport();
    const blurOk = blurred.at.corner[3] === 255 && blurred.at.corner[1] > 100;
    console.log(`  ${blurOk ? '✓' : '✗'} blur background restores the original scene (corner rgba=${blurred.at.corner})`);
    if (!blurOk) failed = true;
    await resetScene();

    // Aspect padding grows the frame without cropping the subject.
    await setScene({ aspect: '16:9', padding: 10 });
    const padded = await probeExport();
    const ratio = padded.w / padded.h;
    const aspectOk = Math.abs(ratio - 16 / 9) < 0.02 && padded.w > 512;
    console.log(`  ${aspectOk ? '✓' : '✗'} 16:9 padding reframes to ${padded.w}×${padded.h} (ratio ${ratio.toFixed(3)})`);
    if (!aspectOk) failed = true;
    await resetScene();

    // A drop shadow must add opaque-ish pixels the plain cutout did not have.
    await setScene({ shadow: true, shadowBlur: 30, shadowY: 25, shadowOpacity: 70 });
    const shadowed = await probeExport();
    const shadowOk = shadowed.nonEmpty > baseline.nonEmpty * 1.1;
    console.log(`  ${shadowOk ? '✓' : '✗'} shadow adds coverage (${baseline.nonEmpty} → ${shadowed.nonEmpty} px)`);
    if (!shadowOk) failed = true;
    await resetScene();

    // Colour adjustment must actually change the subject's pixels.
    await setScene({ saturation: 0 });
    const desaturated = await probeExport();
    const [r, g, b] = desaturated.at.centre;
    const greyOk = Math.max(r, g, b) - Math.min(r, g, b) < 20;
    console.log(`  ${greyOk ? '✓' : '✗'} saturation 0 greys the subject (centre rgb=${r},${g},${b})`);
    if (!greyOk) failed = true;
    await resetScene();

    // Text layer renders into the export.
    await page.evaluate(() => {
      document.querySelector('[data-tool="design"]').click();
      document.getElementById('add-text').click();
    });
    const withText = await probeExport();
    const textOk = withText.nonEmpty > baseline.nonEmpty;
    console.log(`  ${textOk ? '✓' : '✗'} text layer renders (${baseline.nonEmpty} → ${withText.nonEmpty} px)`);
    if (!textOk) failed = true;
    await page.evaluate(() => {
      const item = window.__app.activeItem();
      item.texts = [];
      window.__app.state.activeTextId = null;
      window.__app.renderPreview();
    });

    // Erase brush, driven through real pointer events so the coordinate
    // mapping from screen space back to image space is covered too.
    await page.evaluate(() => {
      document.querySelector('[data-tool="cutout"]').click();
      document.querySelector('[data-brush="erase"]').click();
    });
    const box = await page.evaluate(() => {
      const r = document.getElementById('canvas-result').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(box.x + box.w * 0.35, box.y + box.h * 0.5);
    await page.mouse.down();
    for (let t = 0.35; t <= 0.65; t += 0.05) {
      await page.mouse.move(box.x + box.w * t, box.y + box.h * 0.5);
    }
    await page.mouse.up();
    await wait(400);

    const erased = await probeExport();
    const strokes = await page.evaluate(() => window.__app.activeItem().edits.length);
    const eraseOk = strokes === 1 && erased.at.centre[3] === 0;
    console.log(`  ${eraseOk ? '✓' : '✗'} erase brush clears painted pixels (${strokes} stroke, centre alpha ${erased.at.centre[3]})`);
    if (!eraseOk) failed = true;

    // Undo must put them back.
    await page.evaluate(() => window.__app.undo());
    await wait(300);
    const undone = await probeExport();
    const undoOk = undone.at.centre[3] === 255;
    console.log(`  ${undoOk ? '✓' : '✗'} undo restores the erased pixels (centre alpha ${undone.at.centre[3]})`);
    if (!undoOk) failed = true;

    await page.evaluate(() => {
      document.querySelector('[data-brush="off"]').click();
    });

    /* ── Magic wand ────────────────────────────────────────────────── */

    // Tap the green field with "keep": a correct flood fill restores exactly
    // the background region and leaves the red disc untouched.
    await page.evaluate(() => {
      document.querySelector('[data-tool="cutout"]').click();
      document.querySelector('[data-brush="wand"]').click();
      document.getElementById('wand-keep').click();
    });
    const canvasBox = () => page.evaluate(() => {
      const r = document.getElementById('canvas-result').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    let cb = await canvasBox();
    await page.mouse.click(cb.x + cb.w * 0.06, cb.y + cb.h * 0.06);
    await wait(600);

    const wanded = await probeExport();
    const ops = await page.evaluate(() => window.__app.activeItem().edits.length);
    const wandOk = ops === 1
      && wanded.at.corner[3] === 255 && wanded.at.corner[1] > 100
      && wanded.at.centre[3] === 255 && wanded.at.centre[0] > 150;
    console.log(`  ${wandOk ? '✓' : '✗'} wand selects the tapped region (corner rgba=${wanded.at.corner}, centre rgba=${wanded.at.centre})`);
    if (!wandOk) failed = true;

    await page.evaluate(() => window.__app.undo());
    await wait(500);
    const wandUndone = await probeExport();
    const wandUndoOk = wandUndone.at.corner[3] === 0;
    console.log(`  ${wandUndoOk ? '✓' : '✗'} undo reverts the wand selection (corner alpha ${wandUndone.at.corner[3]})`);
    if (!wandUndoOk) failed = true;

    await page.evaluate(() => document.querySelector('[data-brush="off"]').click());

    /* ── Object transforms ─────────────────────────────────────────── */

    await page.evaluate(() => window.__app.setTool('objects'));
    await wait(250);
    cb = await canvasBox();

    // Drag the cutout well to the right; the centre must empty out and the
    // subject must reappear at the drop point.
    await page.mouse.move(cb.x + cb.w * 0.5, cb.y + cb.h * 0.5);
    await page.mouse.down();
    for (let t = 0.5; t <= 0.9; t += 0.08) {
      await page.mouse.move(cb.x + cb.w * t, cb.y + cb.h * 0.5);
    }
    await page.mouse.up();
    await wait(400);

    const moved = await page.evaluate(async () => {
      const layer = window.__app.activeItem().layers[0];
      const blob = await window.__app.toBlob(window.__app.activeItem());
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const alphaAt = (fx, fy) => {
        const x = Math.round(fx * (c.width - 1));
        const y = Math.round(fy * (c.height - 1));
        return d[(y * c.width + x) * 4 + 3];
      };
      return { tx: layer.tx, centre: alphaAt(0.5, 0.5), right: alphaAt(0.88, 0.5) };
    });
    const moveOk = moved.tx > 100 && moved.centre === 0 && moved.right === 255;
    console.log(`  ${moveOk ? '✓' : '✗'} object drag moves the cutout (tx=${Math.round(moved.tx)}px, centre ${moved.centre}, right ${moved.right})`);
    if (!moveOk) failed = true;

    // Recentre first, so the handles sit inside the canvas.
    await page.evaluate(() => document.getElementById('reset-transform').click());
    await wait(350);

    // Resize by the south-east handle: dragging it halfway to the centre
    // should roughly halve the layer.
    const grip = await page.evaluate(() => {
      const p = window.__app.state.preview;
      const box = p.boxes.get(window.__app.state.selectedLayerId);
      const canvas = document.getElementById('canvas-result');
      const r = canvas.getBoundingClientRect();
      const toClient = (cx, cy) => ({
        x: r.x + cx * (r.width / canvas.width),
        y: r.y + cy * (r.height / canvas.height)
      });
      return {
        handle: toClient(box.cx + box.w / 2, box.cy + box.h / 2),
        centre: toClient(box.cx, box.cy)
      };
    });
    await page.mouse.move(grip.handle.x, grip.handle.y);
    await page.mouse.down();
    await page.mouse.move(
      grip.centre.x + (grip.handle.x - grip.centre.x) * 0.5,
      grip.centre.y + (grip.handle.y - grip.centre.y) * 0.5);
    await page.mouse.up();
    await wait(350);
    const scaleNow = await page.evaluate(() => window.__app.activeItem().layers[0].sx);
    const resizeOk = scaleNow > 0.2 && scaleNow < 0.85;
    console.log(`  ${resizeOk ? '✓' : '✗'} handle drag resizes the layer (scale ${scaleNow.toFixed(2)}×)`);
    if (!resizeOk) failed = true;

    // Alt+drag duplicates rather than moving.
    await page.evaluate(() => document.getElementById('reset-transform').click());
    await wait(350);
    cb = await canvasBox();
    await page.keyboard.down('Alt');
    await page.mouse.move(cb.x + cb.w * 0.5, cb.y + cb.h * 0.5);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.w * 0.62, cb.y + cb.h * 0.5);
    await page.mouse.move(cb.x + cb.w * 0.72, cb.y + cb.h * 0.5);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await wait(350);

    const afterDup = await page.evaluate(() => window.__app.activeItem().layers.length);
    const dupOk = afterDup === 2;
    console.log(`  ${dupOk ? '✓' : '✗'} alt+drag duplicates the object (${afterDup} layers)`);
    if (!dupOk) failed = true;

    // Delete removes the selected copy.
    await page.keyboard.press('Delete');
    await wait(350);
    const afterDel = await page.evaluate(() => window.__app.activeItem().layers.length);
    const delOk = afterDel === 1;
    console.log(`  ${delOk ? '✓' : '✗'} delete removes the selected object (${afterDel} layer)`);
    if (!delOk) failed = true;

    await page.evaluate(() => {
      document.getElementById('reset-transform').click();
      window.__app.setTool('cutout');
    });
    await wait(350);

    /* ── Canvas navigation ─────────────────────────────────────────── */

    const wheelZoom = await page.evaluate(async () => {
      window.__app.setZoom('fit');
      await new Promise((r) => setTimeout(r, 300));
      const before = window.__app.state.preview.zoom;
      const stage = document.getElementById('stage');
      const r = stage.getBoundingClientRect();
      stage.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -400, ctrlKey: true, bubbles: true, cancelable: true,
        clientX: r.x + r.width / 2, clientY: r.y + r.height / 2
      }));
      return { before, after: window.__app.state.preview.zoom };
    });
    const wheelOk = wheelZoom.after > wheelZoom.before * 1.3;
    console.log(`  ${wheelOk ? '✓' : '✗'} ctrl+wheel zooms (${wheelZoom.before.toFixed(2)} → ${wheelZoom.after.toFixed(2)})`);
    if (!wheelOk) failed = true;

    // Space+drag pans the stage once zoom makes it scrollable.
    await page.evaluate(() => window.__app.setZoom(3));
    await wait(500);
    await page.keyboard.down('Space');
    const panning = await page.evaluate(() =>
      document.getElementById('stage').classList.contains('is-panning'));
    const stageRect = await page.evaluate(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    const stageBefore = await page.evaluate(() => document.getElementById('stage').scrollLeft);
    await page.mouse.move(stageRect.x + stageRect.w * 0.6, stageRect.y + stageRect.h * 0.5);
    await page.mouse.down();
    await page.mouse.move(stageRect.x + stageRect.w * 0.6 - 90, stageRect.y + stageRect.h * 0.5);
    await page.mouse.move(stageRect.x + stageRect.w * 0.6 - 160, stageRect.y + stageRect.h * 0.5);
    await page.mouse.up();
    await page.keyboard.up('Space');
    const stageAfter = await page.evaluate(() => document.getElementById('stage').scrollLeft);
    const panOk = panning && stageAfter > stageBefore + 50;
    console.log(`  ${panOk ? '✓' : '✗'} space+drag pans the canvas (scrollLeft ${stageBefore} → ${stageAfter})`);
    if (!panOk) failed = true;
    await page.evaluate(() => window.__app.setZoom('fit'));
    await wait(350);

    // Zoom must actually enlarge the canvas and make the stage scrollable —
    // easy to break with a stray max-width on the canvas.
    const zoomed = await page.evaluate(async () => {
      const fitWidth = document.getElementById('canvas-result').getBoundingClientRect().width;
      document.getElementById('zoom-in').click();
      document.getElementById('zoom-in').click();
      await new Promise((r) => requestAnimationFrame(r));
      const stage = document.getElementById('stage');
      const canvas = document.getElementById('canvas-result');
      const out = {
        fitWidth,
        zoomWidth: canvas.getBoundingClientRect().width,
        scrollable: stage.scrollWidth > stage.clientWidth + 1,
        label: document.getElementById('zoom-reset').textContent
      };
      document.getElementById('zoom-reset').click();
      return out;
    });
    const zoomOk = zoomed.zoomWidth > zoomed.fitWidth * 1.2 && zoomed.scrollable;
    console.log(`  ${zoomOk ? '✓' : '✗'} zoom enlarges and scrolls (${Math.round(zoomed.fitWidth)} → ${Math.round(zoomed.zoomWidth)} px at ${zoomed.label})`);
    if (!zoomOk) failed = true;

    // Exercise the interactive paths that do not need another inference pass.
    await page.evaluate(() => {
      document.getElementById('feather').value = '3';
      document.getElementById('feather').dispatchEvent(new Event('input'));
      document.querySelector('[data-view="compare"]').click();
    });
    await wait(600);
    await page.evaluate(() => document.querySelector('[data-view="result"]').click());

    const zip = await page.evaluate(async () => {
      const { createZip } = await import('/js/zip.js');
      const blob = await createZip([{ name: 'a.txt', blob: new Blob(['hello']) }]);
      const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
      return [...head];
    });
    const zipOk = zip[0] === 0x50 && zip[1] === 0x4b;
    console.log(`  ${zipOk ? '✓' : '✗'} zip writer emits a valid archive header`);
    if (!zipOk) failed = true;

    if (errors.length) {
      console.log(`  ✗ console errors:\n    ${errors.join('\n    ')}`);
      failed = true;
    } else {
      console.log('  ✓ no console errors during interaction');
    }

    const shot = path.join(ROOT, 'screenshot.png');
    await page.screenshot({ path: shot });
    console.log(`  screenshot: ${shot}`);
  } catch (err) {
    console.error(`\n  ✗ ${err.message}`);
    failed = true;
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(failed ? '\nFAILED\n' : '\nAll checks passed.\n');
  process.exit(failed ? 1 : 0);
}

main();
