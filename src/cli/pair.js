// `coding-cube pair` — the whole handoff to a phone in one command. Print a QR, scan it,
// the phone is on the cube. Nothing gets typed on the phone, which was the entire problem:
// the pairing code is 32 random characters and the only way onto a phone used to be typing
// it into a URL bar behind a `#token=`.
//
// The link it prints already contains the pairing code, so the QR is a bearer credential and
// whoever photographs this terminal gets shells. That is the same blast radius the pairing
// code has always had (site/README.md) — it was already sitting in a browser's localStorage
// — and `--new-code` is how you take it back.
//
// The order is deliberate: the cloud first, this computer second. The cloud keeps working
// after the laptop closes and on cellular; a QR pointing at this machine is only as good as
// this machine staying awake and reachable.
//
// Every address is probed before it is printed. A QR that pairs a phone to a refused
// connection is worse than no QR at all, because it fails over on the phone, where there is
// nothing to read and nothing to try.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pairingUrl } from '../../public/app/connection-config.js';
import { paths, readServerOptions } from '../server/config.js';
import { tailnetAddress } from '../server/tailscale.js';
import { loadCloudToken, newToken, saveCloudToken } from '../server/token-store.js';
import { qrBlock } from './terminal-qr.js';

const PROBE_MS = 6000;
const LABEL_WIDTH = 16;

const argv = process.argv.slice(2);
const options = readServerOptions();
const asked = (name) => argv.includes(`--${name}`);
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

if (asked('help') || asked('h')) usage();
else if (asked('new-code')) await mintCloudCode();
else await pair();

// --cloud and --local each pin the answer to one place: "it silently picked the other one"
// is a confusing way to find out that the one you wanted is down.
async function pair() {
  const onlyCloud = asked('cloud');
  const onlyLocal = asked('local') || asked('here');
  const attempts = [onlyLocal ? null : cloudTarget, onlyCloud ? null : localTarget].filter(Boolean);

  const blocked = [];
  for (const attempt of attempts) {
    const outcome = await attempt();
    if (outcome.target) {
      present(outcome.target);
      return;
    }
    blocked.push(outcome.blocked);
  }
  nothingToPair(blocked);
}

// ── The cloud ────────────────────────────────────────────────────────────────────────────

async function cloudTarget() {
  // Prompting only when the operator named the cloud: a bare `pair` that would have fallen
  // through to this machine must not stop and ask a question first.
  const code = loadCloudToken() || (asked('cloud') && interactive ? await askForCode() : '');
  if (!code) {
    return {
      blocked: {
        what: 'The cloud',
        why: `this computer does not know ${options.webOrigin}'s pairing code.`,
        hints: [
          'coding-cube pair --cloud       paste the code you already have',
          'coding-cube pair --new-code    mint a new one, here and on the site',
        ],
      },
    };
  }

  const verdict = await askCloud(code);
  if (verdict.state === 'rejected') {
    return {
      blocked: {
        what: 'The cloud',
        why: `${options.webOrigin} refused the code this computer holds.`,
        hints: ['coding-cube pair --new-code    mint a new one, here and on the site'],
      },
    };
  }
  if (verdict.state === 'broken') {
    return {
      blocked: {
        what: 'The cloud',
        why: `${options.webOrigin} answered: ${verdict.message}`,
        hints: ['The code is fine; the deployment is not. site/README.md lists its secrets.'],
      },
    };
  }

  // Saved only after it worked. A code the cloud refuses never displaces a good one on disk.
  saveCloudToken(code);
  return {
    target: {
      url: `${options.webOrigin}/#token=${encodeURIComponent(code)}`,
      headline: 'Cloud',
      note: verdict.state === 'offline'
        ? 'Could not reach the cloud from here to check the code — the link is still the right one.'
        : 'Any network, cellular included. Nothing has to keep running on this computer.',
    },
  };
}

// /session is the cheapest of the three routes and it authorises before it reads any
// configuration at all (site/lib/cloud.js), so a 401 here means the code is wrong and
// nothing else. Anything neither 200 nor 401 is a deployment problem worth naming rather
// than a pairing problem to blame on the operator's code.
async function askCloud(code) {
  try {
    const response = await fetch(`${options.webOrigin}/session`, {
      headers: { 'x-cube-token': code },
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (response.status === 401) return { state: 'rejected' };
    if (response.ok) return { state: 'accepted' };
    const body = await response.json().catch(() => null);
    return { state: 'broken', message: body?.error || `HTTP ${response.status}` };
  } catch {
    // Offline, or a captive portal. Not a reason to withhold a link that is correct.
    return { state: 'offline' };
  }
}

async function askForCode() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    say('');
    say('This computer does not know the cloud\'s pairing code yet. It is the');
    say('CUBE_PAIRING_TOKEN secret on the Pages project — paste it below, or press');
    say('return and run `coding-cube pair --new-code` to mint a fresh one everywhere.');
    return (await prompt.question('\n  pairing code: ')).trim();
  } finally {
    prompt.close();
  }
}

// Cloudflare will not hand a secret back, so a machine that never had the code — or has lost
// it — has exactly one way forward: replace it. Loud about the cost, because it unpairs every
// phone and browser at once.
async function mintCloudCode() {
  const project = projectName();
  say('');
  say(`A new pairing code replaces the one on ${project}.`);
  say('Every browser and phone already paired stops working until it scans again.');

  if (interactive && !(await confirm())) {
    say('Left alone.');
    return;
  }

  const code = newToken();
  const pushed = await putSecret(project, code);
  if (!pushed.ok) {
    // Nothing is saved locally on failure. A code this machine believes in and the site does
    // not is worse than no code at all: the QR looks right and pairs a phone to a 401.
    say('');
    say(`Could not set the secret: ${pushed.message}`);
    say('Set one by hand, then run `coding-cube pair --cloud`:');
    say(`  npx wrangler pages secret put CUBE_PAIRING_TOKEN --project-name ${project}`);
    process.exitCode = 1;
    return;
  }

  saveCloudToken(code);
  say('');
  say('New pairing code set on the site and saved here.');
  present({
    url: `${options.webOrigin}/#token=${encodeURIComponent(code)}`,
    headline: 'Cloud',
    note: 'Any network, cellular included. Every device has to scan again, this one included.',
  });
}

// wrangler reads the value from stdin when stdin is not a terminal, which keeps the code out
// of the process arguments — `ps` shows those to every user on the machine.
function putSecret(project, code) {
  return new Promise((resolve) => {
    const wrangler = spawn(
      'npx',
      ['--yes', 'wrangler', 'pages', 'secret', 'put', 'CUBE_PAIRING_TOKEN', '--project-name', project],
      { cwd: path.join(paths.root, 'site'), stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    wrangler.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    wrangler.on('error', (error) => resolve({ ok: false, message: error.message }));
    wrangler.on('close', (status) => resolve(status === 0
      ? { ok: true }
      : { ok: false, message: lastLine(stderr) || `wrangler exited ${status}` }));
    wrangler.stdin.end(`${code}\n`);
  });
}

// The deployment names itself; hardcoding it here would be a second place to be wrong.
function projectName() {
  try {
    const toml = fs.readFileSync(path.join(paths.root, 'site', 'wrangler.toml'), 'utf8');
    return /^\s*name\s*=\s*"([^"]+)"/m.exec(toml)?.[1] || 'coding-cube';
  } catch {
    return 'coding-cube';
  }
}

// ── This computer ────────────────────────────────────────────────────────────────────────

async function localTarget() {
  const { port, token, webOrigin } = options;
  const notRunning = {
    blocked: {
      what: 'This computer',
      why: `nothing is answering on 127.0.0.1:${port}.`,
      hints: ['coding-cube                    start it, then run this again'],
    },
  };

  const info = await fetchJson(`http://127.0.0.1:${port}/api/host/info?token=${encodeURIComponent(token)}`);
  if (!info) return notRunning;

  if (info.tsOrigin) {
    return {
      target: {
        url: pairingUrl(webOrigin, info.tsOrigin, info.token || token),
        headline: 'This computer, over Tailscale',
        note: 'Any network your phone is on, as long as this computer stays awake.',
      },
    };
  }

  // The server binds loopback unless it was started with --expose or HOST, so most of these
  // refuse the connection. Whichever one answers is the one a phone can reach.
  const tailnet = await tailnetAddress().catch(() => null);
  for (const address of [tailnet?.dnsName, tailnet?.ip, ...lanAddresses()].filter(Boolean)) {
    const origin = `http://${address}:${port}`;
    if (!(await answers(`${origin}/health?token=${encodeURIComponent(token)}`))) continue;
    // A tailnet address follows the phone onto cellular; a Wi-Fi one does not, and saying so
    // is the difference between a QR that still works tomorrow and one that mysteriously
    // stopped.
    const overTailnet = address === tailnet?.dnsName || address === tailnet?.ip;
    return {
      target: {
        url: `${origin}/#token=${encodeURIComponent(token)}`,
        headline: overTailnet ? 'This computer, over Tailscale' : 'This computer, on your Wi-Fi',
        note: overTailnet
          ? 'Any network your phone is on, as long as this computer stays awake.'
          : 'The same Wi-Fi only, and only while this computer is awake.',
      },
    };
  }

  return {
    blocked: {
      what: 'This computer',
      why: 'it is running, but only on 127.0.0.1, which a phone cannot reach.',
      hints: ['coding-cube --expose           put it on your tailnet, then run this again'],
    },
  };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry?.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

// ── Saying it ────────────────────────────────────────────────────────────────────────────

function present(target) {
  process.stdout.write('\n');
  for (const line of qrBlock(target.url).split('\n')) process.stdout.write(`  ${line}\n`);
  say('');
  say('Point your phone\'s camera at that, and tap the link it offers.');
  say('');
  say(`\x1b[1m${target.headline}\x1b[0m — ${target.note}`);
  say(`\x1b[2m${target.url}\x1b[0m`);
  say('');
}

function nothingToPair(blocked) {
  const pad = (text) => text.padEnd(LABEL_WIDTH);
  say('');
  say('Nothing to pair with yet.');
  for (const reason of blocked) {
    say('');
    say(`  ${pad(reason.what)}${reason.why}`);
    for (const hint of reason.hints) say(`  ${pad('')}${hint}`);
  }
  say('');
  process.exitCode = 1;
}

function usage() {
  say('');
  say('  coding-cube pair              a QR for the best place your phone can reach');
  say('  coding-cube pair --cloud      the hosted cube only');
  say('  coding-cube pair --local      this computer only');
  say('  coding-cube pair --new-code   replace the cloud\'s pairing code everywhere');
  say('');
}

async function confirm() {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question('\n  Type yes to continue: ')).trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function answers(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })).ok;
  } catch {
    return false;
  }
}

function lastLine(text) {
  return String(text).trim().split('\n').pop()?.trim() || '';
}

function say(line) {
  console.log(line ? `  ${line}` : '');
}
