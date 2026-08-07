import {
  DEFAULT_AGENTCORE_ORIGIN,
  DEFAULT_HOST_ORIGIN,
  DEFAULT_WEB_ORIGIN,
  isLoopbackHostname,
  mixedContentBlocked,
  normalizeHostOrigin,
  parseFragment,
} from './connection-config.js';

const STORE_KEY = 'coding-cube.hosts.v1';
const LEGACY_PREFIX = ['cmux', '3d'].join('');
const LEGACY_STORE_KEY = `${LEGACY_PREFIX}.hosts.v1`;
const LEGACY_TOKEN_KEY = `${LEGACY_PREFIX}-token`;
// `kind` selects the transport, not the address: an agentcore host's origin is a local
// minter that signs shell URLs, so nothing about it is reachable the way the others are.
// There is exactly one cloud. The always-on Tailscale box it replaced is deliberately not
// built in any more — anyone who paired one still has it in their saved hosts.
const BUILT_IN_HOSTS = {
  [DEFAULT_AGENTCORE_ORIGIN]: { origin: DEFAULT_AGENTCORE_ORIGIN, name: 'Cloud', token: '', kind: 'agentcore', builtIn: true },
  [DEFAULT_HOST_ORIGIN]: { origin: DEFAULT_HOST_ORIGIN, name: 'This computer', token: '', kind: 'origin', builtIn: true },
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
  return hosted ? DEFAULT_AGENTCORE_ORIGIN : location.origin;
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
    const current = localStorage.getItem(STORE_KEY);
    const legacy = current ? null : localStorage.getItem(LEGACY_STORE_KEY);
    const parsed = JSON.parse(current || legacy || '');
    if (parsed?.version !== 1 || !parsed.hosts) return empty;
    const hosts = { ...BUILT_IN_HOSTS, ...parsed.hosts };
    // Identity comes from this build, not from a copy saved before a rename: a stored
    // "Cloud (AgentCore)" must not outlive the product deciding to call it "Cloud".
    // Only what the user earned — their token and history — survives from storage.
    for (const [origin, builtIn] of Object.entries(BUILT_IN_HOSTS)) {
      hosts[origin] = {
        ...hosts[origin],
        ...builtIn,
        token: hosts[origin]?.token || builtIn.token,
        addedAt: hosts[origin]?.addedAt || Date.now(),
        lastConnected: hosts[origin]?.lastConnected || 0,
      };
    }
    // A host that used to be built in and no longer is was retired by an update, not
    // added by hand. Drop it, or the box AgentCore replaced haunts the list forever.
    for (const [origin, host] of Object.entries(hosts)) {
      if (host.builtIn && !BUILT_IN_HOSTS[origin]) delete hosts[origin];
    }
    const migrated = { ...empty, ...parsed, hosts };
    if (!hosts[migrated.activeOrigin]) migrated.activeOrigin = '';
    if (legacy) {
      localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_STORE_KEY);
    }
    return migrated;
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
