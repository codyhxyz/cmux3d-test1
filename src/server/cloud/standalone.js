// The minter as its own loopback server, which is what `spike/mint-server.mjs` starts.
//
// `npm start` is now the supported way to run the cloud path — it serves the Cube and
// these endpoints on one origin. This surface stays because the spike README's
// two-process flow and the T-16 harness page both point at it, and because a second
// port is occasionally the quickest way to test a second runtime.
//
// It authorizes nobody: any process that can reach this port gets a signed URL for any
// shell on the runtime. "Any process on this machine" is the accepted blast radius.
// "Any web page in the operator's browser" is not, and that is why this server also
// serves the app: a page it serves is same-origin, so the browser sends no Origin
// header at all and the CORS response never has to name a third party.

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VENDOR_ASSETS } from '../../vendor-assets.js';
import { readCloudOptions } from '../config.js';
import { createMinter } from './mint.js';
import { CLOUD_PATHS, corsHeaders, createCloudRoutes, send } from './routes.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const HARNESS = path.join(REPO_ROOT, 'spike', 'browser', 'index.html');
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

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const USAGE = 'Usage: node spike/mint-server.mjs --runtime-arn <arn> [--region us-east-1] [--session <id>]\n'
  + '         [--pin-session] [--port 8787] [--origin https://example.test] [--allow-file-origin]\n'
  + 'Then open http://127.0.0.1:8787/ — the Cube is served from here so it is same-origin\n'
  + 'with the minter. Pages served from anywhere else must be named with --origin.\n'
  + '\nOr just run `npm start` with CUBE_RUNTIME_ARN set: one process, one origin, port 8064.\n';

export function parseArgs(argv) {
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

export async function main(argv = [], env = process.env) {
  const options = parseArgs(argv);
  const cloud = readCloudOptions(env, argv, { force: true });
  if (!cloud) {
    process.stderr.write(`error: --runtime-arn (or CUBE_RUNTIME_ARN) is required.\n${USAGE}`);
    process.exit(2);
  }
  const port = Number(options.port ?? env.CUBE_MINT_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`error: --port ${options.port} is not a port number\n`);
    process.exit(2);
  }
  // Opting in to the opaque origin is opting in to "any sandboxed iframe on any site
  // can read a root shell URL". It exists only for someone deliberately testing a
  // file:// page.
  const allowFileOrigin = flag(options.allowFileOrigin);
  // Exactly the origins this server answers on, plus whatever the operator names. NOT
  // "any loopback port": every other dev server the operator happens to be running is
  // a third party as far as these URLs are concerned.
  const allowedOrigins = new Set([`http://${HOST}:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...cloud.origins]);

  const minter = createMinter(cloud);
  const routes = createCloudRoutes({ minter });

  // A same-origin GET carries no Origin header, so absence means "not a cross-site
  // fetch" (or not a browser at all, which is the blast radius above). A present
  // Origin is always a third party and must be on the list. 'null' is NOT a synonym
  // for file://: a sandboxed iframe on any site sends it too, so echoing
  // access-control-allow-origin: null hands every site on the internet a readable,
  // repeatable root shell.
  const originAllowed = (origin) => {
    if (!origin) return true;
    if (origin === 'null') return allowFileOrigin;
    return allowedOrigins.has(origin);
  };

  const server = http.createServer(async (request, response) => {
    logRequest(request);
    // Belt and braces: the listener is already loopback-only, but a page in the
    // operator's browser can still reach it, and a rebound DNS name can still resolve
    // to 127.0.0.1.
    if (!LOOPBACK_HOST.test(request.headers.host ?? '')) {
      send(response, 403, { error: 'this minter answers on loopback names only' });
      return;
    }
    const origin = request.headers.origin;
    if (!originAllowed(origin)) {
      const hint = origin === 'null'
        ? `an opaque origin (sandboxed iframe or file:// page); open http://${HOST}:${port}/ instead, or start with --allow-file-origin if you meant it`
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
    if (await routes(request, response, url, origin)) return;
    send(response, 404, { error: 'try GET / for the Cube, GET /prepare, GET /mint?shellId=face-1, or GET /session' }, origin);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });

  process.stdout.write(
    `mint server on http://${HOST}:${port} (loopback only)\n`
      + `  cube    : http://${HOST}:${port}/  ← open this; serving it here is what gives it a real origin\n`
      + `  runtime : ${minter.runtimeArn}\n`
      + `  region  : ${minter.region} (qualifier ${minter.qualifier})\n`
      + `  session : ${minter.sessionId}${minter.pinSession ? ' (pinned)' : ' (default; callers may name their own)'}\n`
      + `  aws     : ${minter.profile ? `profile ${minter.profile}` : 'default credential chain'}\n`
      + `  origins : ${[...allowedOrigins].join(' ')}${allowFileOrigin ? ' null (--allow-file-origin)' : ''}\n`
      + `  prepare : GET /prepare?sessionId=… — one /invocations call; without it /mnt/workspace never mounts\n`
      + `  faces   : ${minter.faces.join(' ')}\n`
      + `  expiry  : ${minter.expiresIn}s — the browser must re-mint before every reconnect\n`,
  );
  return { server, minter, port };
}

function staticTarget(pathname) {
  // The API comes first: the catch-all below resolves any path under public/, which
  // would otherwise turn GET /mint into a 404 for a file that was never meant to exist.
  if (CLOUD_PATHS.has(pathname)) return null;
  if (pathname === '/' || pathname === '/index.html') return path.join(PUBLIC_DIR, 'index.html');
  if (pathname === '/harness') return HARNESS;
  if (vendorFiles.has(pathname)) return vendorFiles.get(pathname);
  if (pathname.startsWith('/app/')) {
    // path.join collapses '..', so containment is checked after resolution rather
    // than trusting the prefix the request arrived with.
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

// Every request, with its Origin, so a browser's calls are distinguishable from a curl
// in the same log. Without this "it just retries" is unfalsifiable from here.
function logRequest(request) {
  const origin = request.headers.origin || 'no-origin';
  const agent = /Mozilla/.test(request.headers['user-agent'] || '') ? 'browser' : 'cli';
  process.stdout.write(`<- ${request.method} ${request.url} from ${origin} (${agent})\n`);
}
