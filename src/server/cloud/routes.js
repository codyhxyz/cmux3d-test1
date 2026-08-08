// The three JSON endpoints a browser needs to reach an AgentCore runtime, with no
// opinion about who is allowed to call them. Two surfaces mount these: the product
// gateway (gateway.js, gated by the pairing code) and the standalone spike server
// (standalone.js, gated by loopback). Keeping the bodies here is what stops the two
// from drifting.

import { AWS_LOGIN_REQUIRED } from './mint.js';

export const CLOUD_PATHS = new Set(['/session', '/prepare', '/mint']);

export function createCloudRoutes({ minter }) {
  return async function handleCloudRequest(request, response, url, origin) {
    if (url.pathname === '/session') {
      send(response, 200, minter.session(), origin);
      return true;
    }
    if (url.pathname === '/prepare') {
      try {
        send(response, 200, await minter.prepare({
          sessionId: url.searchParams.get('sessionId'),
          op: url.searchParams.get('op') ?? 'state',
          // How many faces the browser wants. Absent means the default six, so a
          // client that never learned about the setting is unaffected.
          faces: url.searchParams.get('faces'),
        }), origin);
      } catch (error) {
        sendFailure(response, error, origin, 502);
      }
      return true;
    }
    if (url.pathname === '/mint') {
      try {
        send(response, 200, await minter.mint({
          shellId: url.searchParams.get('shellId'),
          face: url.searchParams.get('face'),
          sessionId: url.searchParams.get('sessionId'),
        }), origin);
      } catch (error) {
        sendFailure(response, error, origin, 400);
      }
      return true;
    }
    return false;
  };
}

// Chrome gates a request from a public page to a private address behind PNA. Sending
// the header only where we already decided to echo an origin makes that a decision
// rather than a browser-by-browser accident.
export function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-private-network': 'true',
    vary: 'Origin',
  };
}

export function send(response, status, body, origin) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...corsHeaders(origin),
  });
  response.end(payload);
}

// AWS_LOGIN_REQUIRED is a human-action state, not a failure to retry: the browser
// stops reconnecting and shows Retry instead of hammering an expired token.
export function sendFailure(response, error, origin, fallbackStatus = 502) {
  if (error?.code === AWS_LOGIN_REQUIRED) {
    send(response, 503, { code: AWS_LOGIN_REQUIRED, error: error.message }, origin);
    return;
  }
  send(response, error?.status ?? fallbackStatus, { error: error.message }, origin);
}
