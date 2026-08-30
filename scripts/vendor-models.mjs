#!/usr/bin/env node
/**
 * Download the ONNX models and WASM runtime into ./models so the app works
 * offline and without touching a CDN at runtime. Optional — the app falls back
 * to the IMG.LY CDN when ./models is absent.
 *
 *   npm run vendor              # runtime + the default balanced model
 *   npm run vendor -- isnet     # runtime + a specific model
 *   npm run vendor -- all       # everything (~330 MB)
 */
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const VERSION = '1.7.0';
const BASE = `https://staticimgly.com/@imgly/background-removal-data/${VERSION}/dist/`;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');

const MODELS = ['isnet', 'isnet_fp16', 'isnet_quint8'];
const requested = process.argv.slice(2);
const wanted =
  requested.includes('all') ? MODELS
    : requested.filter((a) => MODELS.includes(a)).length ? requested.filter((a) => MODELS.includes(a))
      : ['isnet_fp16'];

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function download(name) {
  const dest = path.join(OUT, name);
  const existing = await fs.stat(dest).catch(() => null);
  if (existing?.size > 0) return existing.size;

  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`${res.status} for ${name}`);
  const tmp = `${dest}.part`;
  await pipeline(res.body, createWriteStream(tmp));
  await fs.rename(tmp, dest);
  return (await fs.stat(dest)).size;
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const resources = await fetchJson(BASE + 'resources.json');

  // Keep every entry in the manifest; only fetch the chunks we actually need.
  const keep = Object.keys(resources).filter(
    (k) => !k.startsWith('/models/') || wanted.includes(k.replace('/models/', ''))
  );

  const chunks = [...new Set(keep.flatMap((k) => resources[k].chunks.map((c) => c.name)))];
  console.log(`Vendoring ${wanted.join(', ')} + runtime — ${chunks.length} chunks\n`);

  let total = 0;
  for (const [i, name] of chunks.entries()) {
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${chunks.length}] ${name.slice(0, 12)}… `);
    total += await download(name);
    process.stdout.write(`${mb(total)}\r`);
    process.stdout.write('\n');
  }

  await fs.writeFile(
    path.join(OUT, 'resources.json'),
    JSON.stringify(Object.fromEntries(keep.map((k) => [k, resources[k]])), null, 2)
  );

  console.log(`\nDone — ${mb(total)} in ./models. The app will now load models locally.`);
}

main().catch((err) => {
  console.error(`\nVendoring failed: ${err.message}`);
  process.exit(1);
});
