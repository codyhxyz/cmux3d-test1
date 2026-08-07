// Mounts the minter on the product gateway so `http://127.0.0.1:8064/` is the whole
// product: the Cube and the thing that signs its shells, on one origin.
//
// One origin is not a convenience. Chrome 151 refuses an https page's fetch to
// loopback outright — "Permission was denied for this request to access the
// `loopback` address space" — and Access-Control-Allow-Private-Network no longer buys
// an exemption. Serving the app beside the API it calls means there is no
// address-space boundary left to deny.

import { allowCors, requestAuthorized } from '../origin.js';
import { createMinter } from './mint.js';
import { CLOUD_PATHS, corsHeaders, createCloudRoutes, send } from './routes.js';

/**
 * @param {import('node:http').Server} server  the loopback listener only — see mount()
 * @returns the minter, so the caller can print what it is bound to
 */
export function attachCloud(server, { cloud, webOrigin, token, exposure, tailnet, log } = {}) {
  const minter = createMinter({ ...cloud, log });
  const routes = createCloudRoutes({ minter });
  // Origins the operator named explicitly. Everything else goes through the same
  // allowlist the rest of the gateway uses, so a stray dev server on another loopback
  // port is a third party here exactly as it is for /api/.
  const extraOrigins = new Set(cloud.origins ?? []);

  mount(server, async (request, response, url) => {
    const origin = request.headers.origin;
    const allowed = origin && extraOrigins.has(origin)
      ? echoOrigin(response, origin)
      : allowCors(request, response, webOrigin, exposure);
    if (origin && !allowed) {
      send(response, 403, { error: `origin ${origin} not allowed` }, undefined);
      return;
    }
    const echo = allowed ? origin : undefined;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        ...corsHeaders(echo),
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, { error: 'method not allowed' }, echo);
      return;
    }
    // A signed shell URL is a root terminal on the operator's cloud machine, so it is
    // gated exactly like /api/: same-origin loopback is free, anything else presents
    // the pairing code or a Tailscale identity.
    if (!(await requestAuthorized(request, url, { webOrigin, token, exposure, tailnet }))) {
      send(response, 401, { error: 'pairing required' }, echo);
      return;
    }
    await routes(request, response, url, echo);
  });

  return minter;
}

function echoOrigin(response, origin) {
  for (const [name, value] of Object.entries(corsHeaders(origin))) response.setHeader(name, value);
  return true;
}

// The gateway already owns this server's single 'request' listener, and a second
// listener cannot stop the first from answering. So the cloud routes take the
// listener and hand every path they do not own straight back — synchronously, before
// any await, so a request body still has its reader attached in the same tick.
//
// Deliberately mounted on the loopback listener only. With --expose the tailnet gets
// its own server, and a presigned URL good for a root shell has no business being
// mintable from a second address that never sees the pairing gate's loopback branch.
function mount(server, handle) {
  const downstream = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (!CLOUD_PATHS.has(url.pathname)) {
      for (const listener of downstream) listener.call(server, request, response);
      return;
    }
    handle(request, response, url).catch((error) => {
      if (response.headersSent) response.end();
      else send(response, 500, { error: error.message }, undefined);
    });
  });
}
