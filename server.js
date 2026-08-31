#!/usr/bin/env node
/**
 * Zero-dependency static server for the Background Remover app.
 *
 * It exists for one reason beyond serving files: the ONNX runtime only gets
 * multi-threaded WASM (a large speedup) when the page is cross-origin isolated,
 * which requires the COOP/COEP header pair below.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

/** Cross-origin isolation plus a permissive CORP, applied to every response. */
const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin'
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Lets the client pick local models over the CDN without probing for a 404.
  if (pathname === '/app-config.json') {
    const vendored = fs.existsSync(path.join(ROOT, 'models', 'resources.json'));
    const body = JSON.stringify({ modelsPath: vendored ? '/models/' : null });
    res.writeHead(200, {
      'Content-Type': MIME['.json'],
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS
    }).end(body);
    return;
  }

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // Vendored model/runtime files are content-addressed, app files are not.
    const immutable = pathname.startsWith('/vendor/') || pathname.startsWith('/models/');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      // Required for SharedArrayBuffer -> multi-threaded ONNX inference.
      ...SECURITY_HEADERS
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Background Remover running at  http://${HOST}:${PORT}\n`);
});
