import fs from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_ASSETS } from '../vendor-assets.js';
import { allowCors, requestAuthorized, requestIsRemote, trustedForSecrets } from './origin.js';

const INVOCATION_LIMIT = 1024 * 1024;
const FACE_ROUTE = /^\/internal\/face\/(\d+)$/;

// agentcore.js installs these; index.js never does, so the local, --expose and
// Tailscale hosts keep exactly the surface they have today.
let agentCore = null;

export function setAgentCoreRoutes(routes) {
  agentCore = routes;
}

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

export function createStaticResponder(publicRoot, readHerdrState, watchHerdrState, webOrigin, token, exposure, tailnet, gatewayOnly = false) {
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
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const invocation = Boolean(agentCore) && req.method === 'POST' && requestUrl.pathname === '/invocations';
    if (!['GET', 'HEAD'].includes(req.method || 'GET') && !invocation) {
      sendText(res, 405, 'method not allowed');
      return;
    }

    // The AgentCore contract routes answer before the pairing gate on purpose: the
    // platform is the authenticator, and it cannot present a pairing code.
    if (agentCore && await serveAgentCore(req, res, requestUrl)) return;

    if (needsPairing(requestUrl.pathname) && !(await requestAuthorized(req, requestUrl, { webOrigin, token, exposure, tailnet }))) {
      sendText(res, 401, 'pairing required');
      return;
    }
    if (requestUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'coding-cube' });
      return;
    }

    if (requestUrl.pathname === '/api/host/info') {
      res.setHeader('cache-control', 'no-store');
      // The pairing code only leaves the machine for the QR, and only to a caller
      // that is same-origin or has already proved it holds the code.
      const shareToken = Boolean(exposure?.active) && trustedForSecrets(req, requestUrl, { token });
      sendJson(res, 200, {
        service: 'coding-cube',
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

    if (gatewayOnly) {
      sendText(res, 404, 'terminal gateway');
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

async function serveAgentCore(req, res, requestUrl) {
  const face = FACE_ROUTE.exec(requestUrl.pathname);
  if (requestUrl.pathname !== '/ping' && requestUrl.pathname !== '/invocations' && !face) return false;

  // A 500 keeps the microVM alive to be debugged; an unanswered request looks to
  // AgentCore like a container that has stopped responding at all.
  try {
    if (requestUrl.pathname === '/ping') sendJson(res, 200, agentCore.ping());
    else if (face) {
      // cube-wait-face runs inside this microVM. Nothing outside it gets to ask
      // where a face lives, so this route needs no credential of its own.
      if (requestIsRemote(req)) sendText(res, 403, 'forbidden');
      else sendJson(res, 200, await agentCore.face(Number(face[1])));
    } else {
      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      sendJson(res, 200, await agentCore.invoke(body));
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length <= INVOCATION_LIMIT) return;
      reject(new Error('invocation body too large'));
      req.destroy();
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invocation body is not JSON'));
      }
    });
  });
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
