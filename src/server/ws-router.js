import { WebSocketServer } from 'ws';
import { browserOriginAllowed, requestAuthorized, requestIsRemote } from './origin.js';

// /ws is the mount path AgentCore's WebSocket passthrough proxies to; /ws/pty is
// the cube's own path and keeps behaving exactly as it always has.
const TERMINAL_PATHS = new Set(['/ws/pty', '/ws']);
const HELLO_TIMEOUT_MS = 10_000;
const HELLO_FRAME_LIMIT = 8;
// ws defaults maxPayload to 100 MB, so one frame from an unauthenticated-shaped
// client — or a confused proxy — could have the gateway buffer 100 MB before it
// looked at a byte of it. Nothing this socket carries is large: the browser
// sends keystrokes, 8-byte resize frames, and pastes that transport.js already
// chunks at SHELL_FRAME_MAX = 64 KiB (32 KiB on the passthrough path). 1 MiB is
// 16x the largest frame the real client can produce, so no ordinary local or
// Tailscale terminal session can reach it, while a hostile one is capped two
// orders of magnitude lower than the default.
const MAX_PAYLOAD = 1024 * 1024;
// waitForHello bounded its pending buffer at 8 frames, which is 8 x maxPayload
// of memory — the frame count was never the resource being spent. Bound the
// bytes as well. 64 KiB is one full SHELL_FRAME_MAX paste arriving before the
// hello, which is already more than the protocol expects.
const HELLO_BYTE_LIMIT = 64 * 1024;

export function mountTerminalSocket(httpServer, terminalGrid, webOrigin, token, exposure, tailnet) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  httpServer.on('upgrade', async (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const allowed = browserOriginAllowed(req.headers.origin, {
      webOrigin,
      exposure,
      requestHost: req.headers.host,
      remote: requestIsRemote(req),
    });
    if (!allowed) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!(await requestAuthorized(req, requestUrl, { webOrigin, token, exposure, tailnet }))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!TERMINAL_PATHS.has(requestUrl.pathname)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, requestUrl);
    });
  });

  wss.on('connection', (ws, req, requestUrl) => {
    // 'error' on an EventEmitter with no listener throws, and a throw here takes
    // down the whole gateway — every other face with it. ws raises it on any
    // protocol violation, and capping maxPayload makes one of those reachable by
    // a single frame from any client. ws has already failed the connection by the
    // time this runs; there is nothing to do but not die.
    ws.on('error', (error) => console.error(`terminal socket error: ${error.message}`));

    const attach = (face, slot) => terminalGrid.attach(face, slot, ws).catch((error) => {
      console.error('terminal attach failed:', error);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
      ws.close(1011, 'terminal attach failed');
    });

    const face = routeValue(req, requestUrl, 'face');
    if (requestUrl.pathname === '/ws/pty' || face !== null) {
      attach(face, routeValue(req, requestUrl, 'slot'));
      return;
    }
    // Only X-Amzn-Bedrock-AgentCore-Runtime-Custom-* params are documented to
    // survive the passthrough proxy, so a client that cannot set them names its
    // face in a first text frame instead.
    waitForHello(ws, attach);
  });

  return wss;
}

function routeValue(req, requestUrl, name) {
  const custom = `X-Amzn-Bedrock-AgentCore-Runtime-Custom-${name[0].toUpperCase()}${name.slice(1)}`;
  return requestUrl.searchParams.get(name)
    ?? requestUrl.searchParams.get(custom)
    ?? req.headers[custom.toLowerCase()]
    ?? null;
}

function waitForHello(ws, attach) {
  const pending = [];
  let settled = false;
  let pendingBytes = 0;

  const finish = (target) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ws.off('message', onMessage);
    // terminal-grid registers its own message listener inside attach(), so replay
    // only once that listener exists and only if the attach actually succeeded.
    attach(target?.face ?? null, target?.slot ?? null).then((session) => {
      if (!session) return;
      for (const [raw, isBinary] of pending) ws.emit('message', raw, isBinary);
    });
  };

  const onMessage = (raw, isBinary) => {
    const hello = isBinary ? null : parseHello(String(raw));
    if (hello) {
      finish(hello);
      return;
    }
    pending.push([raw, isBinary]);
    pendingBytes += frameBytes(raw);
    // Either bound giving out means the same thing: this client is not going to
    // say hello. Attach it to the default face and replay what it has sent, so
    // the input is delivered rather than dropped.
    if (pending.length >= HELLO_FRAME_LIMIT || pendingBytes >= HELLO_BYTE_LIMIT) finish(null);
  };

  const timer = setTimeout(() => finish(null), HELLO_TIMEOUT_MS);
  timer.unref?.();
  ws.on('message', onMessage);
  ws.once('close', () => {
    settled = true;
    clearTimeout(timer);
  });
}

// ws hands a message as a Buffer, an array of Buffers when fragmented, or an
// ArrayBuffer, depending on binaryType — measure all three rather than trusting
// `.length`, which is a count on an array and a byte count on a Buffer.
function frameBytes(raw) {
  if (Array.isArray(raw)) return raw.reduce((total, part) => total + frameBytes(part), 0);
  if (Buffer.isBuffer(raw) || ArrayBuffer.isView(raw)) return raw.byteLength;
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return Buffer.byteLength(String(raw));
}

function parseHello(text) {
  try {
    const message = JSON.parse(text);
    if (message && typeof message === 'object' && ('face' in message || 'slot' in message)) {
      return { face: message.face ?? null, slot: message.slot ?? null };
    }
  } catch {
    // Not a hello frame; it is stdin for whichever face the defaults pick.
  }
  return null;
}
