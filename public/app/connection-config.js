export const DEFAULT_HOST_ADDRESS = '127.0.0.1';
export const DEFAULT_HOST_PORT = 8064;
export const DEFAULT_HOST_ORIGIN = `http://${DEFAULT_HOST_ADDRESS}:${DEFAULT_HOST_PORT}`;
export const DEFAULT_WEB_ORIGIN = 'https://codingcube.codyh.xyz';
// The AgentCore minter is served from the hosted origin itself, as Cloudflare Pages
// Functions gated by Cloudflare Access. A browser still cannot hold AWS credentials, so
// something server-side still signs one short-lived shell URL per face per reconnect — but
// that something is no longer a process on the operator's machine, which is what made the
// hosted page a decoration: an https page cannot fetch loopback at all, so the real cube
// only ever existed at 127.0.0.1.
//
// Deliberately the same value as DEFAULT_WEB_ORIGIN rather than a second constant that
// happens to match. From the hosted page the cloud is same-origin, which is the property the
// whole arrangement rests on; a page served anywhere else reaches it cross-origin with the
// Access cookie. `npm start --cloud` still wins over this when it is running, because
// resolveCloudBase() prefers a minter on the page's own origin.
export const DEFAULT_AGENTCORE_ORIGIN = DEFAULT_WEB_ORIGIN;

export function isLoopbackHostname(hostname) {
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
}

export function isLoopbackAddress(address) {
  if (!address) return false;
  return isLoopbackHostname(address.replace(/^::ffff:/, ''));
}

// Accepts a bare hostname, a host:port pair, or a full URL. Bare input gets https
// because the only way to reach a non-loopback host from the hosted page is TLS.
export function normalizeHostOrigin(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${isLoopbackHostname(trimmed.split(':')[0]) ? 'http' : 'https'}://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseFragment(hash) {
  const fragment = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  return { host: normalizeHostOrigin(fragment.get('host')), token: fragment.get('token') || '' };
}

export function pairingUrl(webOrigin, hostOrigin, token) {
  return `${webOrigin}/#host=${encodeURIComponent(hostOrigin)}&token=${encodeURIComponent(token)}`;
}

// Browsers exempt loopback from mixed-content blocking, but nothing else.
export function mixedContentBlocked(pageProtocol, hostOrigin) {
  if (pageProtocol !== 'https:') return false;
  try {
    const url = new URL(hostOrigin);
    return url.protocol === 'http:' && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
