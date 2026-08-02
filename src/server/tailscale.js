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
  try {
    const { stdout } = await run(binary, args, { timeout: 3000, maxBuffer: 4 << 20 });
    return JSON.parse(stdout);
  } catch {
    return null;
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
