// Loopback presigned-URL minter for the spike browser page.
//
// THIS IS NOT THE PRODUCTION CONTROL PLANE. It authorizes nobody: any process that can
// reach 127.0.0.1:8787 gets a signed URL for any shell on the runtime. It exists because
// a browser cannot authenticate to AgentCore at all — SigV4 needs headers a WebSocket
// upgrade cannot carry, and presigned URLs live at most 300 seconds — so something
// server-side has to mint one per face per reconnect. In production that is Cognito ->
// Lambda -> a mint bound to a session the Lambda has verified belongs to the caller.
// The JWT alternative (customJWTAuthorizer + base64UrlBearerAuthorization) is NOT a
// substitute: AgentCore enforces no session-to-user mapping and there is no IAM
// condition key for runtimeSessionId, so any valid token could name any session and
// attach to another user's workspace. Only the presign path binds identity to
// (sessionId, shellId) at mint time.
//
// "Any process on this machine" is the accepted blast radius. "Any web page in the
// developer's browser" is not, and that is why this server also serves the harness page:
// a page it serves is same-origin, so the browser sends no Origin header at all and the
// CORS response never has to name a third party. Everything else is refused.

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_ASSETS } from '../src/vendor-assets.js';
import {
  buildInvocationsUrl,
  faceShellId,
  newSessionId,
  presignShellUrl,
  resolveCredentials,
  signRequest,
  validateSessionId,
  validateShellId,
} from './harness/shell-client.mjs';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const REFRESH_MARGIN_SECONDS = 30;
const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const INVOKE_TIMEOUT_MS = 120_000;
const INVOKE_ATTEMPTS = 4;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGE = path.join(REPO_ROOT, 'spike', 'browser', 'index.html');
const APP_DIR = path.join(REPO_ROOT, 'public', 'app');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const MODULES = path.join(REPO_ROOT, 'node_modules');
const vendorFiles = new Map(VENDOR_ASSETS.map(([route, source]) => [route, path.join(MODULES, source)]));
const contentTypes = new Map([
  ['.wasm', 'application/wasm'],
  ['.task', 'application/octet-stream'],
  ['.webmanifest', 'application/manifest+json'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
]);

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=');
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (inline !== undefined) options[key] = inline;
    else if (next && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else options[key] = true;
  }
  return options;
}

function flag(value) {
  return value === true || value === 'true';
}

const options = parseArgs(process.argv.slice(2));
const runtimeArn = options.runtimeArn ?? process.env.CUBE_RUNTIME_ARN;
if (!runtimeArn) {
  process.stderr.write(
    'error: --runtime-arn (or CUBE_RUNTIME_ARN) is required.\n' +
      'Usage: node spike/mint-server.mjs --runtime-arn <arn> [--region us-east-1] [--session <id>]\n' +
      '         [--pin-session] [--port 8787] [--origin https://example.test] [--allow-file-origin]\n' +
      'Then open http://127.0.0.1:8787/ — the harness page is served from here so it is\n' +
      'same-origin with the minter. Pages served from anywhere else must be named with --origin.\n',
  );
  process.exit(2);
}

const region = options.region ?? runtimeArn.split(':')[3] ?? process.env.AWS_REGION ?? 'us-east-1';
const qualifier = options.qualifier ?? 'DEFAULT';
const port = Number(options.port ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`error: --port ${options.port} is not a port number\n`);
  process.exit(2);
}
const expiresIn = Math.min(Number(options.expires ?? 300), 300);
const signer = options.signer ?? 'aws-sdk';
// One session id per minter run: all six faces must land in the same microVM, and the
// browser has no business choosing it.
const sessionId = options.session ? validateSessionId(options.session) : newSessionId();
// The browser page mints its own session id and keeps it in localStorage, so by default
// the caller names the session. --pin-session refuses anything but this process's own,
// which is the shape production must take.
const pinSession = flag(options.pinSession);
// Opting in to the opaque origin is opting in to "any sandboxed iframe on any site can
// read a root shell URL". It exists only for someone deliberately testing a file:// page.
const allowFileOrigin = flag(options.allowFileOrigin);
// Exactly the origins this server answers on, plus whatever the operator names. NOT
// "any loopback port": every other dev server the developer happens to be running is a
// third party as far as these URLs are concerned.
const allowedOrigins = new Set([`http://${HOST}:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
for (const value of String(options.origin === true ? '' : (options.origin ?? '')).split(',')) {
  if (value.trim()) allowedOrigins.add(value.trim());
}
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

// A same-origin GET carries no Origin header, so absence means "not a cross-site fetch"
// (or not a browser at all, which is the accepted blast radius above). A present Origin
// is always a third party and must be on the list. 'null' is NOT a synonym for file://:
// a sandboxed iframe on any site sends it too, so echoing access-control-allow-origin:
// null hands every site on the internet a readable, repeatable root shell.
function originAllowed(origin) {
  if (!origin) return true;
  if (origin === 'null') return allowFileOrigin;
  return allowedOrigins.has(origin);
}

const AWS_LOGIN_REQUIRED = 'AWS_LOGIN_REQUIRED';

function awsLoginRequired(cause) {
  const error = new Error('AWS login required. Run `aws login`, then choose Retry.');
  error.code = AWS_LOGIN_REQUIRED;
  error.cause = cause;
  return error;
}

// The AWS provider owns caching, concurrent refresh coalescing, and aws-login token
// refresh. Recreating or wrapping that cache is how the old path spawned one CLI per
// face instead of sharing one credential resolution.
async function currentCredentials({ force = false } = {}) {
  try {
    return await resolveCredentials(force ? { forceRefresh: true } : undefined);
  } catch (error) {
    throw awsLoginRequired(error);
  }
}

function isExpiredCredentials(result) {
  return result.statusCode === 403 && /expired|InvalidSignature|security token/i.test(result.body || '');
}

// Chrome gates requests from a public page to a private address behind PNA. Sending the
// header only where we already decided to echo an origin makes that behaviour a decision
// rather than a browser-by-browser accident: Chrome, Firefox and Safari now agree.
function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  };
}

function send(response, status, body, origin) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  });
  response.end(payload);
}

function sendFailure(response, error, origin, status = 502) {
  if (error?.code === AWS_LOGIN_REQUIRED) {
    send(response, 503, { code: AWS_LOGIN_REQUIRED, error: error.message }, origin);
    return;
  }
  send(response, status, { error: error.message }, origin);
}

// The Cube is served from here, same-origin with the minter, on purpose. Chrome 151
// refuses an https page's fetch to loopback outright — "Permission was denied for this
// request to access the `loopback` address space" — and the older
// Access-Control-Allow-Private-Network header no longer buys an exemption. Serving the
// app beside the thing it calls means there is no address-space boundary to be denied.
const API_PATHS = new Set(['/session', '/prepare', '/mint']);

function staticTarget(pathname) {
  // The API comes first: the catch-all below resolves any path under public/, which
  // would otherwise turn GET /mint into a 404 for a file that was never meant to exist.
  if (API_PATHS.has(pathname)) return null;
  if (pathname === '/' || pathname === '/index.html') return path.join(PUBLIC_DIR, 'index.html');
  if (pathname === '/harness') return PAGE;
  if (vendorFiles.has(pathname)) return vendorFiles.get(pathname);
  if (pathname.startsWith('/app/')) {
    // path.join collapses '..', so containment is checked after resolution rather than
    // trusting the prefix the request arrived with.
    const file = path.join(APP_DIR, pathname.slice('/app/'.length));
    if (file.startsWith(`${APP_DIR}${path.sep}`)) return file;
  }
  // styles.css, icons, manifest, hand-tracking models: the rest of what index.html pulls.
  const asset = path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (asset.startsWith(`${PUBLIC_DIR}${path.sep}`)) return asset;
  return null;
}

async function sendFile(response, filePath, origin) {
  let body;
  try {
    body = await fs.readFile(filePath);
  } catch {
    send(response, 404, { error: 'not found' }, origin);
    return;
  }
  response.writeHead(200, {
    'content-type': contentTypes.get(path.extname(filePath)) ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  });
  response.end(body);
}

// Measured: /mnt/workspace does not exist for a session whose only activity is a shell
// connection — it materialises on the first /invocations call. The browser cannot make
// that call itself (SigV4 needs headers and a body hash), so the minter makes it, and
// the transport blocks every face on the answer. Without this route the six faces come
// up on ephemeral storage and lose everything at the 60 s idle timeout, silently.
async function invokeRuntime(sessionId, payload) {
  const url = buildInvocationsUrl({ region, runtimeArn, qualifier });
  const body = JSON.stringify(payload);
  let refreshedCredentials = false;
  for (let attempt = 0; ; attempt += 1) {
    const headers = await signRequest({
      method: 'POST',
      url,
      region,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: sessionId },
      body,
      credentials: await currentCredentials(),
    });
    const result = await httpsRequest(url, { ...headers, 'content-length': Buffer.byteLength(body) }, body);
    // A token can die between resolution and the request (clock skew or revocation).
    // Force one refresh; another auth rejection is a human-action state, not a retry.
    if (isExpiredCredentials(result)) {
      if (refreshedCredentials) throw awsLoginRequired(new Error(result.body));
      refreshedCredentials = true;
      process.stdout.write('credentials expired mid-flight; refreshing once\n');
      await currentCredentials({ force: true });
      continue;
    }
    // RetryableConflictException is documented as brief and expected while the service
    // provisions or tears down a session, so a first 409 is not an answer.
    const retryable = result.statusCode === 409 || result.statusCode === 429 || result.statusCode >= 500;
    if (!retryable || attempt + 1 >= INVOKE_ATTEMPTS) return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)));
  }
}

function httpsRequest(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      { method: 'POST', hostname: target.hostname, path: `${target.pathname}${target.search}`, headers },
      (result) => {
        const chunks = [];
        result.on('data', (chunk) => chunks.push(chunk));
        result.on('end', () => resolve({ statusCode: result.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.setTimeout(INVOKE_TIMEOUT_MS, () => request.destroy(new Error(`invocation timed out after ${INVOKE_TIMEOUT_MS}ms`)));
    request.on('error', reject);
    request.end(body);
  });
}

// Signing a caller-named session is precisely the hole production must close: with no
// session-to-user mapping in AgentCore, whoever names the session owns the workspace.
// Here the caller is the developer's own browser, so it is allowed — but validated,
// logged, and switchable off with --pin-session.
function requestedSession(url) {
  const requested = url.searchParams.get('sessionId');
  if (requested && pinSession && requested !== sessionId) {
    throw new Error('--pin-session: this minter only signs its own sessionId; call GET /session to read it');
  }
  return requested ? validateSessionId(requested) : sessionId;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Every request, with its Origin, so a browser's calls are distinguishable from a
// curl in the same log. Without this "it just retries" is unfalsifiable from here.
function logRequest(request) {
  const origin = request.headers.origin || 'no-origin';
  const agent = /Mozilla/.test(request.headers['user-agent'] || '') ? 'browser' : 'cli';
  process.stdout.write(`<- ${request.method} ${request.url} from ${origin} (${agent})\n`);
}

const server = http.createServer(async (request, response) => {
  logRequest(request);
  // Belt and braces: the listener is already loopback-only, but a page in the developer's
  // browser can still reach it, and a rebound DNS name can still resolve to 127.0.0.1.
  if (!LOOPBACK_HOST.test(request.headers.host ?? '')) {
    send(response, 403, { error: 'this minter answers on loopback names only' });
    return;
  }
  const origin = request.headers.origin;
  if (!originAllowed(origin)) {
    const hint = origin === 'null'
      ? 'an opaque origin (sandboxed iframe or file:// page); open http://127.0.0.1:' + port + '/ instead, or start with --allow-file-origin if you meant it'
      : `start with --origin ${origin} if you meant it`;
    send(response, 403, { error: `origin ${origin} not allowed; ${hint}` });
    return;
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...corsHeaders(origin),
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
    });
    response.end();
    return;
  }

  const url = new URL(request.url, `http://${HOST}:${port}`);
  const asset = request.method === 'GET' || request.method === 'HEAD' ? staticTarget(url.pathname) : null;
  if (asset) {
    await sendFile(response, asset, origin);
    return;
  }
  if (url.pathname === '/session') {
    send(response, 200, { sessionId, runtimeArn, region, qualifier, expiresIn, refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS }, origin);
    return;
  }
  if (url.pathname === '/prepare') {
    try {
      const target = requestedSession(url);
      const op = url.searchParams.get('op') ?? 'state';
      const startedAt = Date.now();
      const result = await invokeRuntime(target, { op });
      const json = safeJson(result.body);
      if (result.statusCode >= 400) {
        process.stdout.write(`prepare ${target} FAILED HTTP ${result.statusCode}\n`);
        send(response, 502, { error: json?.message ?? result.body.slice(0, 400), statusCode: result.statusCode, sessionId: target }, origin);
        return;
      }
      const state = json?.state ?? 'unknown';
      process.stdout.write(`prepare ${target} op=${op} state=${state} in ${Date.now() - startedAt}ms\n`);
      send(response, 200, {
        sessionId: target,
        state,
        phase: json?.phase ?? null,
        elapsedMs: json?.elapsedMs ?? null,
        // The face -> terminal_id map the transport needs anyway, from the same call
        // that creates the mount. One call, both obligations.
        faces: Array.isArray(json?.faces) ? json.faces : [],
        persistence: json?.persistence ?? null,
        invokedInMs: Date.now() - startedAt,
      }, origin);
    } catch (error) {
      sendFailure(response, error, origin);
    }
    return;
  }
  if (url.pathname !== '/mint') {
    send(response, 404, { error: 'try GET / for the harness page, GET /prepare, GET /mint?shellId=face-1, or GET /session' }, origin);
    return;
  }

  try {
    const face = url.searchParams.get('face');
    const shellId = url.searchParams.get('shellId') ?? (face === null ? null : faceShellId(Number(face)));
    if (!shellId) throw new Error('pass ?shellId=face-1 or ?face=0');
    validateShellId(shellId);
    const target = requestedSession(url);

    const mintedAt = Date.now();
    const wsUrl = await presignShellUrl({ region, runtimeArn, shellId, sessionId: target, qualifier, expiresIn, credentials: await currentCredentials(), signer });
    process.stdout.write(`mint ${shellId} session=${target} expires=${expiresIn}s\n`);
    send(response, 200, { url: wsUrl, shellId, sessionId: target, expiresIn, expiresAt: mintedAt + expiresIn * 1000, refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS }, origin);
  } catch (error) {
    sendFailure(response, error, origin, 400);
  }
});

server.listen(port, HOST, () => {
  process.stdout.write(
    `mint server on http://${HOST}:${port} (loopback only — NOT production auth)\n` +
      `  harness : http://${HOST}:${port}/  ← open this; serving it here is what gives it a real origin\n` +
      `  runtime : ${runtimeArn}\n` +
      `  region  : ${region} (qualifier ${qualifier}, signer ${signer})\n` +
      `  session : ${sessionId}${pinSession ? ' (pinned)' : ' (default; callers may name their own)'}\n` +
      `  origins : ${[...allowedOrigins].join(' ')}${allowFileOrigin ? ' null (--allow-file-origin)' : ''}\n` +
      `  prepare : GET /prepare?sessionId=… — one /invocations call; without it /mnt/workspace never mounts\n` +
      `  faces   : ${[0, 1, 2, 3, 4, 5].map(faceShellId).join(' ')}\n` +
      `  expiry  : ${expiresIn}s — the browser must re-mint before every reconnect\n`,
  );
});
