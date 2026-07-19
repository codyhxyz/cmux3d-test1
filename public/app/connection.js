import { DEFAULT_COMPANION_HOST, DEFAULT_COMPANION_PORT, isLoopbackHostname } from './connection-config.js';

export const hosted = !isLoopbackHostname(location.hostname);
const origin = hosted ? `http://${DEFAULT_COMPANION_HOST}:${DEFAULT_COMPANION_PORT}` : location.origin;
const fragment = new URLSearchParams(location.hash.slice(1));
let token = fragment.get('token') || '';

if (hosted) {
  if (token) sessionStorage.setItem('cmux3d-token', token);
  else token = sessionStorage.getItem('cmux3d-token') || '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

export function companionHttp(path) {
  return companionUrl(path).href;
}

export function companionWebSocket(path) {
  const url = companionUrl(path);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function companionUrl(path) {
  const url = new URL(path, origin);
  if (hosted && token) url.searchParams.set('token', token);
  return url;
}
