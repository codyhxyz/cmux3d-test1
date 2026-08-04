import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const FALLBACK_BINARIES = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/bin/tailscale'];
// `tailscale serve --bg <port>` landed in 1.56; older releases need the long form.
const SERVE_BG_MINIMUM = [1, 56];

export function findTailscale() {
  for (const candidate of FALLBACK_BINARIES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'tailscale';
}

// Warnings go to stderr, so every parser reads stdout only.
async function json(binary, args) {
  const raw = await text(binary, args, 3000);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function text(binary, args, timeout = 20_000) {
  try {
    const { stdout } = await run(binary, args, { timeout, maxBuffer: 4 << 20 });
    return stdout;
  } catch (error) {
    // `tailscale serve` reports "not enabled" on a non-zero exit in some versions.
    return error.stdout || '';
  }
}

export function parseStatus(envelope) {
  if (!envelope) return null;
  const dnsName = String(envelope.Self?.DNSName || '').replace(/\.$/, '');
  const ip = (envelope.Self?.TailscaleIPs || []).find((address) => address.includes('.')) || null;
  return {
    running: envelope.BackendState === 'Running',
    dnsName: dnsName || null,
    ip,
    // Null until the tailnet enables HTTPS certificates, which `tailscale serve` requires.
    certDomains: Array.isArray(envelope.CertDomains) ? envelope.CertDomains : [],
    magicDns: envelope.CurrentTailnet?.MagicDNSEnabled !== false,
  };
}

// Binding straight to the tailnet address needs no certificate and no serve rule.
// It is the shortest path to real shells on a phone, so it runs before listen().
export async function tailnetAddress() {
  const status = parseStatus(await json(findTailscale(), ['status', '--json']));
  return status?.running && status.ip ? { ip: status.ip, dnsName: status.dnsName } : null;
}

export function parseWhois(envelope) {
  if (!envelope?.Node?.Name) return null;
  return {
    node: String(envelope.Node.Name).replace(/\.$/, ''),
    login: envelope.UserProfile?.LoginName || null,
  };
}

// `tailscale whois` is Tailscale's own answer to "who is this peer", so identity
// comes from tailscaled rather than from us matching addresses ourselves. Cached
// briefly because it is a subprocess on the request path.
export function createTailnetIdentity({ ttlMs = 60_000 } = {}) {
  const binary = findTailscale();
  const cache = new Map();

  return {
    async identify(address) {
      const ip = String(address || '').replace(/^::ffff:/, '');
      if (!ip) return null;

      const cached = cache.get(ip);
      if (cached && Date.now() - cached.at < ttlMs) return cached.profile;

      const profile = parseWhois(await json(binary, ['whois', '--json', ip]));
      cache.set(ip, { at: Date.now(), profile });
      return profile;
    },
  };
}

export function parseServeStatus(envelope, port) {
  if (!envelope?.Web) return { tsOrigin: null, funnel: false };
  const suffix = `:${port}`;
  for (const [hostPort, config] of Object.entries(envelope.Web)) {
    const proxy = config?.Handlers?.['/']?.Proxy;
    if (!proxy || !String(proxy).endsWith(suffix)) continue;
    return {
      tsOrigin: `https://${hostPort.replace(/:443$/, '')}`,
      funnel: Boolean(envelope.AllowFunnel?.[hostPort]),
    };
  }
  return { tsOrigin: null, funnel: false };
}

export function parseVersion(stdout) {
  const match = /^(\d+)\.(\d+)/.exec(String(stdout || '').trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function supportsServeBackground(version) {
  if (!version) return false;
  const [major, minor] = version;
  return major > SERVE_BG_MINIMUM[0] || (major === SERVE_BG_MINIMUM[0] && minor >= SERVE_BG_MINIMUM[1]);
}

// Returns the exposure the browser can actually reach, plus everything the CLI told us
// so index.js can print accurate guidance instead of a raw error.
// `tailscale serve --bg` blocks for ~30s when Serve is off for the tailnet, so it
// never runs before listen(). Returns the TLS origin, or the one-click URL that
// turns Serve on — Tailscale gates it behind a single visit.
export async function offerServe(port) {
  const binary = findTailscale();
  const existing = parseServeStatus(await json(binary, ['serve', 'status', '--json']), port);
  if (existing.tsOrigin) return { tsOrigin: existing.tsOrigin, funnel: existing.funnel, enableUrl: null };

  const attempt = await text(binary, ['serve', '--bg', String(port)], 30_000);
  const enableUrl = /https:\/\/login\.tailscale\.com\/f\/serve\?\S+/.exec(attempt || '')?.[0] || null;
  if (enableUrl) return { tsOrigin: null, funnel: false, enableUrl };

  const served = parseServeStatus(await json(binary, ['serve', 'status', '--json']), port);
  return { tsOrigin: served.tsOrigin, funnel: served.funnel, enableUrl: null };
}

export async function detectExposure({ optIn = false, port } = {}) {
  const binary = findTailscale();
  const status = parseStatus(await json(binary, ['status', '--json']));
  if (!status?.running) return { active: false, tsOrigin: null, dnsName: null, status, serveCommand: null };

  const serveCommand = `tailscale serve --bg ${port}`;
  let served = parseServeStatus(await json(binary, ['serve', 'status', '--json']), port);

  if (!served.tsOrigin && optIn) {
    const version = parseVersion((await run(binary, ['version'], { timeout: 3000 }).catch(() => ({ stdout: '' }))).stdout);
    if (!status.certDomains.length) {
      console.log('tailscale: enable HTTPS certificates for this tailnet before exposing (admin console → DNS → HTTPS Certificates)');
    } else if (!supportsServeBackground(version)) {
      console.log(`tailscale: version too old for --bg; run this yourself: ${serveCommand}`);
    } else {
      try {
        await run(binary, ['serve', '--bg', String(port)], { timeout: 15_000 });
        served = parseServeStatus(await json(binary, ['serve', 'status', '--json']), port);
      } catch (error) {
        console.log(`tailscale: could not expose port ${port} (${error.message.split('\n')[0]}); run this yourself: ${serveCommand}`);
      }
    }
  }

  return {
    active: Boolean(served.tsOrigin),
    tsOrigin: served.tsOrigin,
    funnel: served.funnel,
    dnsName: status.dnsName,
    status,
    serveCommand,
  };
}
