import { createHash, timingSafeEqual } from 'node:crypto';
import { isLoopbackAddress, isLoopbackHostname } from '../../public/app/connection-config.js';

// `tailscale serve` proxies from loopback, so the forwarded header is the only
// signal that a request crossed the tailnet. Browsers cannot forge it: it is not
// CORS-safelisted, so setting it forces a preflight the origin allowlist rejects.
export function requestIsRemote(req) {
  if ('x-forwarded-for' in req.headers) return true;
  return !isLoopbackAddress(req.socket?.remoteAddress);
}

export function browserOriginAllowed(origin, options = {}) {
  if (!origin) return true;
  const { webOrigin, exposure, requestHost, remote } = typeof options === 'string' ? { webOrigin: options } : options;
  try {
    const url = new URL(origin);
    if (isLoopbackHostname(url.hostname)) return true;
    if (webOrigin && origin === webOrigin) return true;
    if (exposure?.tsOrigin && origin === exposure.tsOrigin) return true;
    // The Host header is attacker-controlled, so it may only widen access for
    // requests that already have to present a pairing code. Trusting it on a
    // loopback socket would let any site reach the shells by rebinding its DNS.
    return Boolean(remote && requestHost) && url.host === requestHost;
  } catch {
    return false;
  }
}

export function requestAuthorized(req, requestUrl, options = {}) {
  const { webOrigin, token, tailnet } = options;
  if (!token) return true;

  const origin = req.headers.origin;
  // Local tools and the locally served page share the shell's trust domain already.
  if (!requestIsRemote(req) && (!origin || isLoopbackOrigin(origin)) && origin !== webOrigin) return true;
  // A device in your tailnet was already authenticated by Tailscale itself, which
  // is stronger than a code in a URL. Requires a real peer address, not a header.
  if (tailnet?.has(req.socket?.remoteAddress) && origin !== webOrigin) return true;
  return tokensMatch(requestUrl.searchParams.get('token'), token);
}

// The pairing code is the one credential that unlocks this host from anywhere, so
// it is never handed to a cross-origin page that has not already presented it.
export function trustedForSecrets(req, requestUrl, options = {}) {
  const { token } = options;
  if (req.headers.origin) return tokensMatch(requestUrl.searchParams.get('token'), token);
  return !requestIsRemote(req);
}

export function allowCors(req, res, webOrigin, exposure) {
  const origin = req.headers.origin;
  const allowed = browserOriginAllowed(origin, {
    webOrigin,
    exposure,
    requestHost: req.headers.host,
    remote: requestIsRemote(req),
  });
  if (!origin || !allowed) return false;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-private-network', 'true');
  res.setHeader('vary', 'Origin');
  return true;
}

function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function tokensMatch(candidate, token) {
  if (!candidate) return false;
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(candidate), digest(token));
}
