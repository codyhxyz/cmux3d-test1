import {
  DEFAULT_CLOUD_HOST_ORIGIN,
  DEFAULT_HOST_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  isLoopbackHostname,
  mixedContentBlocked,
  normalizeHostOrigin,
  parseFragment,
} from './connection-config.js';

const STORE_KEY = 'cmux3d.hosts.v1';
const LEGACY_TOKEN_KEY = 'cmux3d-token';
const BUILT_IN_HOSTS = {
  [DEFAULT_CLOUD_HOST_ORIGIN]: { origin: DEFAULT_CLOUD_HOST_ORIGIN, name: 'Cloud Agent', token: '', builtIn: true },
  [DEFAULT_HOST_ORIGIN]: { origin: DEFAULT_HOST_ORIGIN, name: 'This computer', token: '', builtIn: true },
};

export const hosted = location.origin === DEFAULT_WEB_ORIGIN;

const store = readStore();
adoptFragment();

export function activeHost() {
  const origin = store.activeOrigin || defaultOrigin();
  return store.hosts[origin] || { origin, name: hostName(origin), token: '', lastConnected: 0 };
}

export function listHosts() {
  return Object.values(store.hosts).sort((a, b) => (b.lastConnected || 0) - (a.lastConnected || 0));
}

export function setActiveHost(input, { token, name } = {}) {
  const origin = normalizeHostOrigin(input);
  if (!origin) return null;
  const existing = store.hosts[origin];
  store.hosts[origin] = {
    ...existing,
    origin,
    name: name || existing?.name || hostName(origin),
    token: token ?? existing?.token ?? '',
    addedAt: existing?.addedAt || Date.now(),
    lastConnected: existing?.lastConnected || 0,
  };
  store.activeOrigin = origin;
  writeStore();
  return store.hosts[origin];
}

export function removeHost(origin) {
  if (store.hosts[origin]?.builtIn) return;
  delete store.hosts[origin];
  if (store.activeOrigin === origin) store.activeOrigin = listHosts()[0]?.origin || defaultOrigin();
  writeStore();
}

export function markConnected() {
  const host = setActiveHost(activeHost().origin);
  if (!host) return;
  host.lastConnected = Date.now();
  writeStore();
}

export function isLoopbackHost(origin = activeHost().origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

// An https page can only reach loopback over http. Anything else has to be opened
// on the host's own origin, where the page and the shells are same-origin.
export function connectionPlan() {
  const host = activeHost();
  if (!mixedContentBlocked(location.protocol, host.origin)) return { type: 'ok', host };
  const direct = new URL(host.origin);
  direct.hash = host.token ? `token=${encodeURIComponent(host.token)}` : '';
  return { type: 'mixed-content', host, directUrl: direct.href };
}

export function hostHttp(path) {
  return hostUrl(path).href;
}

export function hostWebSocket(path) {
  const url = hostUrl(path);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function hostUrl(path) {
  const host = activeHost();
  const url = new URL(path, host.origin);
  if (host.token) url.searchParams.set('token', host.token);
  return url;
}

function defaultOrigin() {
  return hosted ? DEFAULT_CLOUD_HOST_ORIGIN : location.origin;
}

function hostName(origin) {
  if (isLoopbackHost(origin)) return 'This computer';
  try {
    return new URL(origin).hostname.split('.')[0];
  } catch {
    return origin;
  }
}

// `#host=…&token=…` fully configures a phone from one scanned or pasted link.
function adoptFragment() {
  const { host, token } = parseFragment(location.hash);
  if (host || token) {
    setActiveHost(host || activeHost().origin || defaultOrigin(), { token: token || undefined });
    history.replaceState(null, '', location.pathname + location.search);
  }
  migrateLegacyToken();
}

function migrateLegacyToken() {
  let legacy = '';
  try {
    legacy = sessionStorage.getItem(LEGACY_TOKEN_KEY) || '';
    if (legacy) sessionStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    return;
  }
  if (legacy && !store.hosts[DEFAULT_HOST_ORIGIN]?.token) setActiveHost(DEFAULT_HOST_ORIGIN, { token: legacy });
}

function readStore() {
  const empty = { version: 1, activeOrigin: '', hosts: { ...BUILT_IN_HOSTS } };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '');
    if (parsed?.version !== 1 || !parsed.hosts) return empty;
    const hosts = { ...BUILT_IN_HOSTS, ...parsed.hosts };
    for (const [origin, builtIn] of Object.entries(BUILT_IN_HOSTS)) hosts[origin] = { ...builtIn, ...hosts[origin], builtIn: true };
    return { ...empty, ...parsed, hosts };
  } catch {
    return empty;
  }
}

function writeStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Private browsing; the session still works, it just will not be remembered.
  }
}
