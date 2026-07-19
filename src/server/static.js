import fs from 'node:fs/promises';
import path from 'node:path';
import { allowCors, hostedRequestAuthorized } from './origin.js';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.task', 'application/octet-stream'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

export function createStaticResponder(publicRoot, readHerdrState, watchHerdrState, webOrigin, token) {
  const root = path.resolve(publicRoot);
  const modules = path.resolve(root, '..', 'node_modules');
  const mediapipe = path.join(modules, '@mediapipe/tasks-vision');
  const mediapipeWasm = [
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_module_internal.js',
    'vision_wasm_module_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
  ];
  const vendorFiles = new Map([
    ['/vendor/xterm.css', path.join(modules, '@xterm/xterm/css/xterm.css')],
    ['/vendor/xterm.mjs', path.join(modules, '@xterm/xterm/lib/xterm.mjs')],
    ['/vendor/addon-attach.mjs', path.join(modules, '@xterm/addon-attach/lib/addon-attach.mjs')],
    ['/vendor/addon-fit.mjs', path.join(modules, '@xterm/addon-fit/lib/addon-fit.mjs')],
    ['/vendor/addon-webgl.mjs', path.join(modules, '@xterm/addon-webgl/lib/addon-webgl.mjs')],
    ['/vendor/mediapipe/vision_bundle.mjs', path.join(mediapipe, 'vision_bundle.mjs')],
    ...mediapipeWasm.map((file) => [`/vendor/mediapipe/wasm/${file}`, path.join(mediapipe, 'wasm', file)]),
  ]);

  return async function serveStatic(req, res) {
    const corsAllowed = allowCors(req, res, webOrigin);
    if (req.headers.origin && !corsAllowed) {
      sendText(res, 403, 'origin not allowed');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, HEAD, OPTIONS' });
      res.end();
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      sendText(res, 405, 'method not allowed');
      return;
    }

    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!hostedRequestAuthorized(req, requestUrl, webOrigin, token)) {
      sendText(res, 401, 'pairing required');
      return;
    }
    if (requestUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'cmux3d' });
      return;
    }

    if (requestUrl.pathname === '/api/herdr/state') {
      if (!readHerdrState) {
        sendJson(res, 503, { error: 'Herdr is disabled' });
        return;
      }
      try {
        sendJson(res, 200, await readHerdrState());
      } catch (error) {
        sendJson(res, 502, { error: error.message });
      }
      return;
    }

    if (requestUrl.pathname === '/api/herdr/events') {
      if (!watchHerdrState) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let closed = false;
      let unsubscribe = () => {};
      req.on('close', () => {
        closed = true;
        unsubscribe();
      });

      try {
        unsubscribe = await watchHerdrState(
          () => {
            if (!closed) res.write('data: change\n\n');
          },
          () => res.end(),
        );
        if (closed) unsubscribe();
        else res.write('data: ready\n\n');
      } catch {
        if (!closed) res.end();
      }
      return;
    }

    const pathname = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname);
    const filePath = vendorFiles.get(pathname) || path.resolve(root, `.${pathname}`);

    if (!vendorFiles.has(pathname) && !isInside(root, filePath)) {
      sendText(res, 403, 'forbidden');
      return;
    }

    try {
      const file = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': contentTypes.get(path.extname(filePath)) || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      if (req.method !== 'HEAD') res.end(file);
      else res.end();
    } catch {
      sendText(res, 404, 'not found');
    }
  };
}

function isInside(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
