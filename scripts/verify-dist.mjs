#!/usr/bin/env node
/**
 * Deployment check: serve ./dist exactly the way a static host does — no dev
 * server, no node_modules, no dynamic routes — and confirm the app still boots,
 * segments an image and exports a transparent PNG.
 *
 *   npm run verify
 *
 * The headers mirror vercel.json, so this also proves cross-origin isolation
 * survives the deploy (which is what gets multi-threaded WASM).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 5194;
const ORIGIN = `http://127.0.0.1:${PORT}/`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
};

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function serveDist() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, ORIGIN).pathname);
    const file = path.normalize(path.join(DIST, pathname === '/' ? 'index.html' : pathname));

    // Headers from vercel.json, applied to every response.
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    };

    if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, headers).end('Not found');
      return;
    }
    headers['Content-Type'] = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('No dist/. Run `npm run build` first.');
    process.exit(1);
  }

  const server = await serveDist();
  const executablePath = BROWSERS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found.');

  const browser = await puppeteer.launch({
    executablePath, headless: 'new', args: ['--no-sandbox']
  });
  let failed = false;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    const errors = [];
    const missing = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${r.url()}`); });

    await page.goto(ORIGIN, { waitUntil: 'networkidle2' });
    await page.waitForFunction('window.__app !== undefined', { timeout: 20000 });

    const boot = await page.evaluate(() => ({
      isolated: crossOriginIsolated,
      background: getComputedStyle(document.body).backgroundColor,
      tools: document.querySelectorAll('.tool').length
    }));

    const checks = [
      // An unstyled page keeps the UA default white; ours is near-black.
      ['stylesheet applied', boot.background === 'rgb(10, 12, 17)'],
      ['import map resolved and app booted', true],
      ['cross-origin isolated', boot.isolated],
      ['all six tools present', boot.tools === 6],
      ['no 4xx/5xx responses', missing.length === 0],
      ['no console errors', errors.length === 0]
    ];
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${label}`);
      if (!ok) failed = true;
    }
    if (missing.length) console.log(`    missing:\n    ${missing.slice(0, 6).join('\n    ')}`);
    if (errors.length) console.log(`    errors:\n    ${errors.slice(0, 4).join('\n    ')}`);

    // A real cutout, end to end, from the deployed bundle.
    console.log('  … running a cutout against the CDN weights');
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const x = c.getContext('2d');
      x.fillStyle = '#1e9e4a';
      x.fillRect(0, 0, 512, 512);
      x.fillStyle = '#d81f26';
      x.beginPath();
      x.arc(256, 256, 150, 0, Math.PI * 2);
      x.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      await window.__app.addFiles([new File([blob], 'disc.png', { type: 'image/png' })]);
    });
    await page.waitForFunction(
      () => ['done', 'error'].includes(window.__app.state.items[0]?.status),
      { timeout: 600000, polling: 1000 });

    const probe = await page.evaluate(async () => {
      const item = window.__app.activeItem();
      if (item.status !== 'done') return { error: item.error };
      const blob = await window.__app.toBlob(item);
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const at = (x, y) => [...d.slice((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)];
      return { size: blob.size, corner: at(4, 4), centre: at(256, 256) };
    });

    if (probe.error) {
      console.log(`  ✗ segmentation failed: ${probe.error}`);
      failed = true;
    } else {
      const ok = probe.corner[3] === 0 && probe.centre[3] === 255;
      console.log(`  ${ok ? '✓' : '✗'} cutout works from dist (corner alpha ${probe.corner[3]}, centre alpha ${probe.centre[3]}, ${(probe.size / 1024).toFixed(0)} KB)`);
      if (!ok) failed = true;
    }

    await wait(300);
    await page.screenshot({ path: path.join(ROOT, 'screenshot-dist.png') });
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    failed = true;
  } finally {
    await browser.close();
    server.close();
  }

  console.log(failed ? '\nDEPLOY CHECK FAILED\n' : '\nDeploy check passed — dist/ is good to ship.\n');
  process.exit(failed ? 1 : 0);
}

main();
