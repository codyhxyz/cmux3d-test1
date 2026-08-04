import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_ASSETS } from '../vendor-assets.js';
import { allowCors, requestAuthorized, trustedForSecrets } from './origin.js';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.task', 'application/octet-stream'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.sh', 'text/x-shellscript; charset=utf-8'],
]);

// The shell is public code, and a phone opening a `#token=` link cannot present the
// fragment on its document request. Only capability routes require pairing.
function needsPairing(pathname) {
  return pathname === '/health' || pathname.startsWith('/api/');
}

export function createStaticResponder(publicRoot, readHerdrState, watchHerdrState, webOrigin, token, exposure, tailnet) {
  const root = path.resolve(publicRoot);
  const modules = path.resolve(root, '..', 'node_modules');
  const vendorFiles = new Map(VENDOR_ASSETS.map(([route, source]) => [route, path.join(modules, source)]));

  return async function serveStatic(req, res) {
    const corsAllowed = allowCors(req, res, webOrigin, exposure);
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
    if (needsPairing(requestUrl.pathname) && !(await requestAuthorized(req, requestUrl, { webOrigin, token, exposure, tailnet }))) {
      sendText(res, 401, 'pairing required');
      return;
    }
    if (requestUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'cmux3d' });
      return;
    }

    if (requestUrl.pathname === '/api/host/info') {
      res.setHeader('cache-control', 'no-store');
      // The pairing code only leaves the machine for the QR, and only to a caller
      // that is same-origin or has already proved it holds the code.
      const shareToken = Boolean(exposure?.active) && trustedForSecrets(req, requestUrl, { token });
      sendJson(res, 200, {
        service: 'cmux3d',
        webOrigin,
        exposed: Boolean(exposure?.active),
        tsOrigin: exposure?.tsOrigin || null,
        token: shareToken ? token : null,
      });
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
      // Proxies (tailscale serve among them) drop idle streams; a comment keeps it warm.
      const heartbeat = setInterval(() => {
        if (!closed) res.write(':hb\n\n');
      }, 25_000);
      heartbeat.unref?.();
      req.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
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
