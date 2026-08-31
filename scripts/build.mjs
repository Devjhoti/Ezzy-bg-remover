#!/usr/bin/env node
/**
 * Build a self-contained static site into ./dist.
 *
 * The app has no bundler: the browser resolves `onnxruntime-web` and
 * `@imgly/background-removal` through the import map in index.html. Those
 * specifiers have to point at files that actually ship, and `node_modules` is
 * not committed — so this copies the handful of ESM bundles the browser needs
 * into ./vendor, which both the dev server and the deployed site serve.
 *
 * Only the JS bundles are vendored. The ONNX weights and the ort `.wasm` are
 * fetched at runtime from the IMG.LY CDN (see js/engine.js), which is why this
 * output stays a couple of megabytes rather than a couple of hundred.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor');
const DIST = path.join(ROOT, 'dist');

/** [source in node_modules, destination under ./vendor] */
const BUNDLES = [
  ['@imgly/background-removal/dist/index.mjs', 'imgly/background-removal.js'],
  ['onnxruntime-web/dist/ort.bundle.min.mjs', 'onnxruntime-web/ort.js'],
  ['onnxruntime-web/dist/ort.webgpu.bundle.min.mjs', 'onnxruntime-web/ort.webgpu.js']
];

/** Files and directories copied verbatim into ./dist. */
const STATIC = ['index.html', 'styles.css', 'js', 'vendor'];

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

async function copyBundles() {
  await fs.rm(VENDOR, { recursive: true, force: true });
  let total = 0;

  for (const [from, to] of BUNDLES) {
    const src = path.join(ROOT, 'node_modules', from);
    const dest = path.join(VENDOR, to);
    let code;
    try {
      code = await fs.readFile(src, 'utf8');
    } catch {
      throw new Error(`Missing ${from}. Run \`npm install\` first.`);
    }
    // The .map files are not shipped, so drop the reference rather than
    // leaving the browser to 404 on it.
    code = code.replace(/^\/\/# sourceMappingURL=.*$/m, '');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, code);
    total += Buffer.byteLength(code);
  }
  return total;
}

async function copyStatic() {
  await fs.rm(DIST, { recursive: true, force: true });
  await fs.mkdir(DIST, { recursive: true });

  for (const entry of STATIC) {
    await fs.cp(path.join(ROOT, entry), path.join(DIST, entry), { recursive: true });
  }

  // The dev server answers /app-config.json dynamically; a static host needs a
  // real file, or engine.js gets a 404 on every load. Deployments always use
  // the CDN for weights — vendored models are far too large to ship.
  await fs.writeFile(
    path.join(DIST, 'app-config.json'),
    `${JSON.stringify({ modelsPath: null }, null, 2)}\n`
  );
}

async function directorySize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await directorySize(full) : (await fs.stat(full)).size;
  }
  return total;
}

async function main() {
  const vendored = await copyBundles();
  console.log(`  vendor/  ${BUNDLES.length} bundles, ${mb(vendored)}`);

  if (!process.argv.includes('--vendor-only')) {
    await copyStatic();
    console.log(`  dist/    ${mb(await directorySize(DIST))} ready to deploy`);
  }
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
