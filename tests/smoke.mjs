import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HandController, handSample } from '../public/app/hand-tracking.js';
import { herdrMetadata } from '../public/app/herdr.js';
import { accessoryKeyInput, commandKeyInput, commandPromptDirection, ctrlCode, promptLine } from '../public/app/terminal-keys.js';
import { DEFAULT_AGENTCORE_ORIGIN, DEFAULT_WEB_ORIGIN, mixedContentBlocked, normalizeHostOrigin, pairingUrl, parseFragment } from '../public/app/connection-config.js';
import {
  encodeResize as encodeProtocolResize,
  encodeStdin as encodeProtocolStdin,
  parseStatusFrame as parseProtocolStatus,
  SHELL_CHANNEL,
} from '../public/app/agentcore-protocol.js';
import {
  clampFaceCount as canonicalClampFaceCount,
  DEFAULT_FACE_COUNT as CANONICAL_DEFAULT_FACE_COUNT,
  MAX_FACE_COUNT as CANONICAL_MAX_FACE_COUNT,
  MIN_FACE_COUNT as CANONICAL_MIN_FACE_COUNT,
} from '../public/app/face-count.js';
import { MAX_FACES } from '../public/app/facets.js';
import {
  createWorkspaceLifecycle,
  deriveWorkspaceState,
  describeActivity,
  formatElapsed,
  sleepPolicy,
  STUCK_AFTER_MS,
  workingPanes,
} from '../public/app/workspace.js';
import qrcode from 'qrcode-generator';
import {
  DAMPING,
  DRAG_DAMPING,
  DRAG_STOP_SPEED,
  dragVelocity,
  integrateDamped,
  MAX_ANGULAR_SPEED,
  MAX_DRAG_ANGULAR_SPEED,
  MAX_SETTLE_SECONDS,
  momentumDuration,
  momentumSliderValue,
  SETTLE_SECONDS,
  SpaceController,
  STOP_SPEED,
} from '../public/app/space.js';
import { VENDOR_ASSETS } from '../src/vendor-assets.js';
import { readCloudOptions, readServerOptions } from '../src/server/config.js';
import { createCloudRoutes } from '../src/server/cloud/routes.js';
import { parseArgs as parseStandaloneArgs } from '../src/server/cloud/standalone.js';
import {
  clampFaceCount,
  countCubeFaces,
  cubePaneIds,
  cubeSetupPlan,
  DEFAULT_FACE_COUNT,
  ensureCubeWorkspace,
  MAX_FACE_COUNT,
  MIN_FACE_COUNT,
  selectCubeFaces,
} from '../src/server/herdr-state.js';
import { browserOriginAllowed } from '../src/server/origin.js';
import { createRuntime } from '../src/server/runtime.js';
import { createTailnetIdentity, parseServeIdentity, parseServeStatus, parseStatus, parseWhois } from '../src/server/tailscale.js';
import { loadOrCreateToken, rotateToken } from '../src/server/token-store.js';
import {
  encodeResize as encodeHarnessResize,
  encodeStdin as encodeHarnessStdin,
  parseStatusFrame as parseHarnessStatus,
} from '../spike/harness/shell-client.mjs';

await checkHerdrStateEndpoint();
await checkGatewayOnly();
await checkRenamedBrowserStore();
await checkAwsLoginFailStop();
await checkRuntimeProvisioningHelper();
await checkFaceCount();

assert.equal(commandKeyInput({ key: 'ArrowLeft', metaKey: true }), '\x01', 'command-left should move to the start of the shell input');
assert.equal(commandKeyInput({ key: 'ArrowRight', metaKey: true }), '\x05', 'command-right should move to the end of the shell input');
assert.equal(commandKeyInput({ key: 'Backspace', metaKey: true }), '\x15', 'command-backspace should delete to the start of the shell input');
assert.equal(commandPromptDirection({ key: 'ArrowUp', metaKey: true }), -1, 'command-up should jump to the previous prompt');
assert.equal(commandPromptDirection({ key: 'ArrowDown', metaKey: true }), 1, 'command-down should jump to the next prompt');
assert.equal(promptLine([3, 11, 27], 20, -1), 11, 'previous prompt navigation should choose the nearest earlier prompt');
assert.equal(promptLine([3, 11, 27], 20, 1), 27, 'next prompt navigation should choose the nearest later prompt');
assert.equal(commandKeyInput({ key: 'a', metaKey: true }), undefined, 'xterm should retain its working command-A behavior');
assert.equal(commandKeyInput({ key: 'ArrowLeft', altKey: true }), undefined, 'xterm should retain its working option-arrow behavior');

assert.equal(accessoryKeyInput('escape'), '\x1b', 'the key row should send escape where phones have no key for it');
assert.equal(accessoryKeyInput('tab'), '\t', 'the key row should send tab');
assert.equal(accessoryKeyInput('up'), '\x1b[A', 'arrows should use normal cursor keys by default');
assert.equal(accessoryKeyInput('up', { applicationCursorKeys: true }), '\x1bOA', 'arrows should follow the application cursor mode');
assert.equal(ctrlCode('c'), '\x03', 'sticky ctrl should interrupt');
assert.equal(ctrlCode('C'), '\x03', 'sticky ctrl should ignore the shift state of a soft keyboard');
assert.equal(ctrlCode('1'), undefined, 'sticky ctrl should pass through characters with no control code');

assert.equal(browserOriginAllowed('https://cube.example', 'https://cube.example'), true, 'the configured hosted UI should reach the host');
assert.equal(browserOriginAllowed('https://evil.example', 'https://cube.example'), false, 'other hosted origins must not reach local shells');
assert.equal(
  browserOriginAllowed('https://mymac.tail47c266.ts.net', { webOrigin: 'https://cube.example', exposure: { tsOrigin: 'https://mymac.tail47c266.ts.net' } }),
  true,
  'an exposed tailnet address should reach its own host',
);
assert.equal(
  browserOriginAllowed('https://mymac.tail47c266.ts.net', { webOrigin: 'https://cube.example', exposure: { tsOrigin: null } }),
  false,
  'a tailnet origin should not be trusted before exposure is detected',
);
assert.equal(
  browserOriginAllowed('http://mymac.local:8064', { webOrigin: 'https://cube.example', requestHost: 'mymac.local:8064', remote: true }),
  true,
  'a phone browsing the host directly should be same-origin',
);
assert.equal(
  browserOriginAllowed('http://evil.example', { webOrigin: 'https://cube.example', requestHost: 'evil.example', remote: false }),
  false,
  'a site that rebinds its DNS to loopback must not be trusted by its own Host header',
);

const tokenDir = await mkdtemp(path.join(os.tmpdir(), 'coding-cube-token-'));
const tokenEnv = { CODING_CUBE_STATE_DIR: tokenDir };
assert.equal(readServerOptions(tokenEnv, []).herdr, null, 'a clean install should start ordinary shells without Herdr setup');
assert.equal(readServerOptions({ ...tokenEnv, CODING_CUBE_HERDR: 'herdr' }, []).herdr, 'herdr', 'Herdr attachment should remain an explicit option');
assert.equal(readServerOptions(tokenEnv, []).expose, false, 'exposing the cube to a tailnet should stay opt-in');
assert.equal(readServerOptions({ ...tokenEnv, CODING_CUBE_GATEWAY_ONLY: '1' }, []).gatewayOnly, true, 'the cloud host should expose terminals without serving a second cube');
assert.equal(readServerOptions(tokenEnv, ['--expose']).expose, true, '--expose should opt in to tailnet exposure');
assert.equal(readServerOptions({ ...tokenEnv, CODING_CUBE_TAILSCALE: 'serve' }, []).serveOnly, true, 'a cloud gateway should use Tailscale Serve without binding to the tailnet IP');
const parsedCloud = readCloudOptions({}, [
  '--runtime-arn=arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
  '--region', 'us-west-2', '--origin=https://first.example', '--origin', 'https://second.example', '--pin-session',
]);
assert.equal(parsedCloud.region, 'us-west-2', 'cloud options should accept both inline and spaced values');
assert.deepEqual(parsedCloud.origins, ['https://first.example'], 'repeated --origin remains first-value-wins');
assert.equal(parsedCloud.pinSession, true, 'a bare boolean flag should remain accepted');
assert.equal(readCloudOptions({}, ['--runtime-arn']), null, 'a bare value option must not become a truthy runtime ARN');
assert.doesNotThrow(() => readServerOptions(tokenEnv, ['--unknown-option']), 'unknown server options were historically ignored');
assert.deepEqual(
  parseStandaloneArgs(['--port=9000', '--allow-file-origin', '--origin', 'https://one.example', '--origin=https://two.example']),
  { port: '9000', allowFileOrigin: true, origin: 'https://two.example' },
  'the standalone minter keeps inline/spaced values, bare flags and last-value-wins repeats',
);
assert.deepEqual(
  readServerOptions({ ...tokenEnv, CODING_CUBE_TAILSCALE_USERS: 'me@example.com, other@example.com ' }, []).tailscaleUsers,
  ['me@example.com', 'other@example.com'],
  'the optional Tailscale identity allowlist should be configuration, not another login flow',
);
const firstToken = loadOrCreateToken(tokenEnv);
assert.equal(loadOrCreateToken(tokenEnv), firstToken, 'pairing should survive a restart so phones stay paired');
assert.equal((await stat(path.join(tokenDir, 'token'))).mode & 0o777, 0o600, 'the pairing code should not be world readable');
assert.notEqual(rotateToken(tokenEnv), firstToken, 'rotating should invalidate the old pairing code');
assert.equal(readServerOptions({ ...tokenEnv, CODING_CUBE_TOKEN: 'from-env' }, []).token, 'from-env', 'an explicit token should win over the stored one');
await rm(tokenDir, { recursive: true, force: true });

// The cloud is served from the hosted origin itself, as Pages Functions, so from the hosted
// page it is same-origin. That is the whole property: an https page cannot fetch loopback at
// all, so any cloud address on 127.0.0.1 makes the website a decoration and the real cube
// something you have to start a process to reach.
assert.equal(DEFAULT_AGENTCORE_ORIGIN, DEFAULT_WEB_ORIGIN, 'the hosted cube must reach its cloud on its own origin, never through a process on somebody’s machine');
assert.doesNotMatch(await readFile('public/app/connection.js', 'utf8'), /tail47c266/, 'the always-on box AgentCore replaced must not come back as a second cloud');
// `npm start` with CUBE_RUNTIME_ARN serves the Cube and the minter on one origin, so a
// page it served must ask itself. Measured: without this the page on :8064 fetched
// :8787 and Chrome refused it for CORS, silently against whichever runtime was there.
const mainSource = await readFile('public/app/main.js', 'utf8');
assert.match(
  mainSource,
  /resolveCloudBase[\s\S]{0,1600}location\.origin/,
  'a Cube served by the minter must mint from its own origin, not the standalone port',
);
// The other half, and the one MULTI_USER.md warns about: the probe must not outvote an
// operator who pointed the cloud at a specific API. Only the built-in default gets
// superseded by a minter answering here, or deploying the multi-user mint endpoint would
// silently keep using whatever serves the page.
assert.match(
  mainSource,
  /fallback !== DEFAULT_AGENTCORE_ORIGIN/,
  'an explicitly configured cloud origin must win over the same-origin probe',
);
// …and the constant it names has to actually be in scope. The assertion above passed for a
// week while DEFAULT_AGENTCORE_ORIGIN was used but never imported: the string was there,
// the binding was not, so every cloud connect died on a ReferenceError and painted
// "Cloud unavailable: DEFAULT_AGENTCORE_ORIGIN is not defined" over the cube. A browser
// module cannot be imported here to catch that, so read the bindings instead.
for (const name of (await readdir('public/app')).filter((file) => file.endsWith('.js'))) {
  const source = stripLiterals(await readFile(`public/app/${name}`, 'utf8'));
  const bound = new Set(['JSON']);
  for (const clause of source.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?[^;]*?from/g)) {
    if (clause[1]) bound.add(clause[1]);
    for (const specifier of (clause[2] || '').split(',')) {
      const local = specifier.trim().split(/\s+as\s+/).pop()?.trim();
      if (local) bound.add(local);
    }
  }
  for (const declared of source.matchAll(/(?:export\s+)?(?:const|let|var|function|class)\s+([\w$]+)/g)) bound.add(declared[1]);
  // `export { X as Y } from …` never binds Y locally, but naming it is not a reference either.
  for (const clause of source.matchAll(/export\s*\{([^}]*)\}\s*from/g)) {
    for (const specifier of clause[1].split(',')) {
      for (const part of specifier.split(/\s+as\s+/)) bound.add(part.trim());
    }
  }
  // Not after a dot: HTMLMediaElement.HAVE_CURRENT_DATA is the platform's constant, not ours.
  for (const [used] of source.matchAll(/(?<![.\w$])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    assert.ok(bound.has(used), `public/app/${name} uses ${used} without importing or declaring it`);
  }
}

// Comments and string literals are full of SCREAMING_SNAKE that is prose or a wire value —
// 'AWS_LOGIN_REQUIRED' is a code the server sends, not an identifier this file needs.
//
// One pass, one alternation, deliberately: stripping quotes in separate passes lets an
// apostrophe inside a double-quoted string ("Couldn't read the clipboard") open a phantom
// string, and from there every pairing is off by one — the code is eaten and the literals
// survive, which is precisely backwards. Left to right, whichever delimiter opens first wins.
function stripLiterals(source) {
  return source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g,
    ' ',
  );
}
// Pinning the session server-side is only safe if the client adopts the id the 409 carries;
// without this every call 409s forever and cloud mode is simply broken.
assert.match(
  mainSource,
  /status === 409[\s\S]{0,200}adoptSessionId/,
  'a 409 from a pinned minter must be adopted, not just reported',
);
// faces[].paneId is the join key the browser uses against busy.panes; a minter that
// drops one half leaves "Agent working — sleep paused" permanently unreachable.
assert.match(
  await readFile('src/server/cloud/mint.js', 'utf8'),
  /busy: json\?\.busy/,
  '/prepare must forward the container busy block or the Working state can never fire',
);
assert.equal(normalizeHostOrigin('mymac.tailnet.ts.net'), 'https://mymac.tailnet.ts.net', 'a bare address needs TLS to be reachable from the hosted page');
assert.equal(normalizeHostOrigin('127.0.0.1:8064'), 'http://127.0.0.1:8064', 'loopback stays plain http');
assert.equal(normalizeHostOrigin('https://mymac.ts.net/'), 'https://mymac.ts.net', 'a pasted URL should reduce to its origin');
assert.equal(normalizeHostOrigin('not a host'), null, 'unparseable input should be rejected rather than guessed at');
assert.deepEqual(parseFragment('#token=abc'), { host: null, token: 'abc' }, 'the original pairing link should keep working');
assert.deepEqual(
  parseFragment(`#host=${encodeURIComponent('https://mymac.ts.net')}&token=abc`),
  { host: 'https://mymac.ts.net', token: 'abc' },
  'one link should carry both the address and the pairing code',
);
assert.equal(mixedContentBlocked('https:', 'http://mymac.ts.net:8064'), true, 'an https page cannot reach a plain remote host');
assert.equal(mixedContentBlocked('https:', 'http://127.0.0.1:8064'), false, 'browsers exempt loopback from mixed content');
assert.equal(mixedContentBlocked('http:', 'http://mymac.ts.net:8064'), false, 'a plain page can reach a plain host');
assert.match(pairingUrl('https://cube.example', 'https://mymac.ts.net', 'abc'), /#host=https%3A%2F%2Fmymac\.ts\.net&token=abc$/, 'the printed pairing link should configure a phone in one step');

// A workspace waking from sleep and a workspace that is broken produce the same picture
// — six terminals retrying — unless something says which one is happening.
assert.equal(deriveWorkspaceState({ connection: 'unpaired' }).state, null, 'a computer you own has no sleep cycle to report');
const asleep = deriveWorkspaceState({ cloud: true, connection: 'unpaired' });
assert.equal(asleep.state, 'sleeping', 'a cloud workspace that has never started is asleep, not broken');
assert.equal(asleep.action, 'Wake', 'every lifecycle state must name a way out');

const waking = deriveWorkspaceState({ cloud: true, preparing: true, workspace: { state: 'booting', phase: 'restore' } });
assert.equal(waking.state, 'waking');
assert.equal(waking.detail, 'Restoring files…', 'a wake should say which step is running rather than spin');
assert.equal(waking.action, 'Cancel', 'a wake nobody can see the end of has to be refusable');
assert.equal(
  deriveWorkspaceState({ cloud: true, connection: 'connected', faces: 4, workspace: { state: 'ready' } }).detail,
  'Opening terminals…',
  'four of six faces attached is still waking, and saying Ready then would be a lie',
);
assert.equal(
  deriveWorkspaceState({ cloud: true, connection: 'connected', faces: 6, faceCount: 10, workspace: { state: 'ready' } }).state,
  'waking',
  'six open sockets must not make a configured ten-face workspace Ready',
);
const tenAttached = deriveWorkspaceState({ cloud: true, connection: 'connected', faces: 10, faceCount: 10, workspace: { state: 'ready' } });
assert.equal(tenAttached.state, 'ready', 'a ten-face workspace becomes Ready only at 10/10');
assert.equal(tenAttached.detail, 'All 10 terminals are attached.', 'Ready copy must follow the served count rather than hard-code six');
assert.equal(
  deriveWorkspaceState({ cloud: true, preparing: true, elapsedMs: STUCK_AFTER_MS }).state,
  'attention',
  'a wake that never lands must stop calling itself Waking; cold start was measured at 1.3s',
);
assert.equal(deriveWorkspaceState({ cloud: true, workspace: { state: 'saving' } }).detail, 'Saving your workspace before sleep');
assert.equal(
  deriveWorkspaceState({ cloud: true, error: { message: 'AWS login required' } }).action,
  'Reconnect',
  'expired credentials need the provider named, not a retry loop',
);

const cubeFaces = [{ face: 0, label: 'Face 1', paneId: 'pane-a' }, { face: 1, label: 'Face 2', paneId: 'pane-b' }];
const attached = { cloud: true, connection: 'connected', faces: 6, workspace: { state: 'ready', faces: cubeFaces } };
assert.equal(deriveWorkspaceState(attached).state, 'ready');
assert.equal(
  deriveWorkspaceState({ ...attached, preparing: true }).state,
  'ready',
  'the detail refresh is an /invocations call on a live workspace; painting it as a wake made an open popover flap every 15s',
);
assert.equal(deriveWorkspaceState(attached).note, null, 'nothing may claim an agent is working without a pane saying so');
const busyCube = deriveWorkspaceState({
  ...attached,
  busy: { busy: true, reason: 'pane', panes: { 'pane-a': { status: 'working', busy: true }, 'pane-b': { status: 'blocked' } } },
});
assert.equal(busyCube.state, 'working');
assert.equal(busyCube.note, 'Agent working — sleep paused', 'the sleep guarantee is the promise users most need to trust');
assert.match(busyCube.detail, /Face 1/, 'a working agent should be named by the face it is in');
// agent_status is idle, working, blocked, done, unknown. `blocked` is an agent waiting on
// a human, which is exactly when sleeping the microVM is correct.
assert.equal(
  workingPanes({ panes: { a: { status: 'blocked' }, b: { status: 'unknown' }, c: { status: 'idle' }, d: { status: 'done' } } }).length,
  0,
  'only `working` may pause sleep, or a cube with an idle agent never sleeps at all',
);

assert.equal(formatElapsed(4999), '0:04');
assert.equal(formatElapsed(65_000), '1:05', 'elapsed time should read as a clock, not milliseconds');
const activityNow = Date.parse('2026-08-04T12:00:00Z');
assert.equal(describeActivity({ cloud: true, connection: 'connected' }), 'active now');
assert.equal(describeActivity({ cloud: false, connection: 'idle', lastConnected: activityNow - 5_000, now: activityNow }), 'just now');
assert.equal(describeActivity({ cloud: false, connection: 'idle', lastConnected: activityNow - 120_000, now: activityNow }), '2m ago');
assert.equal(describeActivity({ cloud: true, connection: 'unpaired' }), 'never started');
assert.equal(describeActivity({ cloud: true, connection: 'unpaired', lastConnected: activityNow - 7_200_000, now: activityNow }), 'slept 2h ago');
assert.equal(
  describeActivity({ cloud: true, connection: 'unpaired', lastConnected: activityNow - 5_000, now: activityNow }),
  'slept just now',
  'a workspace that has only just stopped should not report "slept just now ago"',
);
assert.equal(sleepPolicy(600), 'Sleeps after 10 minutes with no terminal or agent activity.');
assert.match(sleepPolicy(), /^Sleeps on its own/, 'an unknown idle timeout must not be reported as a number we cannot read');

// The elapsed clock, on an injected one so the assertion is about behaviour and not timing.
let lifecycleClock = 0;
const lifecycleTicks = [];
const lifecycleSeen = [];
const lifecycleProbe = createWorkspaceLifecycle({
  onChange: (snapshot, meta) => lifecycleSeen.push({ ...snapshot, ...meta }),
  now: () => lifecycleClock,
  schedule: (fn) => lifecycleTicks.push(fn),
  cancel: () => {},
});
lifecycleProbe.update({ cloud: true, preparing: true });
assert.equal(lifecycleSeen.at(-1).stateChanged, true, 'entering a state is what a screen reader should hear');
assert.equal(lifecycleProbe.snapshot().elapsed, null, 'a two-second cold start needs no stopwatch');
lifecycleClock += 5000;
lifecycleTicks.at(-1)();
assert.equal(lifecycleSeen.at(-1).elapsed, '0:05', 'past five seconds the wait must show how long it has been');
assert.equal(lifecycleSeen.at(-1).stateChanged, false, 'the ticking clock must not re-announce itself over terminal input');
lifecycleProbe.dispose();

// The clock is an input, not decoration: a wake nothing ever finishes has to escalate on
// its own, and must not reset that clock and flip straight back to Waking.
let stuckClock = 0;
const stuckTicks = [];
const stuckProbe = createWorkspaceLifecycle({ now: () => stuckClock, schedule: (fn) => stuckTicks.push(fn), cancel: () => {} });
stuckProbe.update({ cloud: true, preparing: true });
assert.equal(stuckProbe.snapshot().state, 'waking');
stuckClock += STUCK_AFTER_MS;
stuckTicks.at(-1)();
assert.equal(stuckProbe.snapshot().state, 'attention', 'a wake with no end in sight must stop calling itself Waking');
assert.equal(stuckProbe.snapshot().elapsed, '1:30', 'the escalated state keeps the clock the wait earned');
stuckClock += 2000;
stuckTicks.at(-1)();
assert.equal(stuckProbe.snapshot().state, 'attention', 'escalation must be stable, not a flip-flop once a tick resets it');
stuckProbe.update({ preparing: false, connection: 'connected', faces: 6, workspace: { state: 'ready' } });
assert.equal(stuckProbe.snapshot().state, 'ready', 'a wake that finally lands clears the escalation and the clock');
assert.equal(stuckProbe.snapshot().elapsed, null);
stuckProbe.dispose();

// Refreshing costs an /invocations call, and an /invocations call resets the very idle
// timer it reports on. It happens when the user asks for details, and not otherwise.
let lifecycleRefreshes = 0;
const gatedProbe = createWorkspaceLifecycle({ refresh: () => { lifecycleRefreshes += 1; }, schedule: () => 1, cancel: () => {} });
gatedProbe.setDetailInterest(true);
assert.equal(lifecycleRefreshes, 1, 'opening workspace details should ask once, immediately');
gatedProbe.setDetailInterest(true);
assert.equal(lifecycleRefreshes, 1, 'an already-open panel must not stack refresh loops on itself');
gatedProbe.setDetailInterest(false);
assert.equal(lifecycleRefreshes, 1, 'a closed panel must stop asking, or no workspace ever sleeps');
gatedProbe.dispose();

assert.deepEqual(
  parseStatus({
    BackendState: 'Running',
    Self: { DNSName: 'mymac.tail47c266.ts.net.', TailscaleIPs: ['100.117.81.83', 'fd7a:115c:a1e0::f801:51aa'] },
    CertDomains: null,
    CurrentTailnet: { MagicDNSEnabled: true },
  }),
  { running: true, dnsName: 'mymac.tail47c266.ts.net', ip: '100.117.81.83', certDomains: [], magicDns: true },
  'the trailing dot in a MagicDNS name should not reach the browser',
);
// Binding to the tailnet address is the no-certificate path to shells on a phone.
assert.equal(
  parseStatus({ BackendState: 'Running', Self: { DNSName: 'm.ts.net.', TailscaleIPs: ['fd7a:115c::1', '100.64.0.2'] } }).ip,
  '100.64.0.2',
  'the IPv4 tailnet address is the one to bind',
);
assert.deepEqual(parseServeStatus({}, 8064), { tsOrigin: null, funnel: false }, 'an idle tailscale serve reports nothing to expose');
assert.deepEqual(
  parseServeStatus({
    Web: { 'mymac.tail47c266.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8064' } } } },
    AllowFunnel: { 'mymac.tail47c266.ts.net:443': true },
  }, 8064),
  { tsOrigin: 'https://mymac.tail47c266.ts.net', funnel: true },
  'an active serve rule should be recognised, funnel included',
);
assert.deepEqual(parseServeStatus({ Web: { 'mymac.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }, 8064).tsOrigin, null, 'a serve rule for another port is not our exposure');
// Identity comes from `tailscale whois`, so a device Tailscale vouches for needs
// no second pairing code and an unknown address gets nothing.
assert.deepEqual(
  parseWhois({ Node: { Name: 'mymac.tail47c266.ts.net.' }, UserProfile: { LoginName: 'me@example.com' } }),
  { node: 'mymac.tail47c266.ts.net', login: 'me@example.com' },
  'a tailnet peer should be identified by tailscaled, not by matching addresses ourselves',
);
assert.equal(parseWhois(null), null, 'an address tailscale does not know is not a peer');
assert.equal(parseWhois({}), null, 'an empty whois answer is not a peer');
assert.deepEqual(
  parseServeIdentity({ 'tailscale-user-login': 'me@example.com' }),
  { node: null, login: 'me@example.com' },
  'the cloud gateway should consume the identity authenticated by Tailscale Serve',
);
assert.equal(parseServeIdentity({}), null, 'ordinary proxy headers must not invent a Tailscale identity');
const privateTailnet = createTailnetIdentity({ allowedLogins: ['me@example.com'] });
assert.equal(privateTailnet.identifyHeaders({ 'tailscale-user-login': 'ME@example.com' })?.login, 'ME@example.com', 'the configured Tailscale user should pass without another prompt');
assert.equal(privateTailnet.identifyHeaders({ 'tailscale-user-login': 'random@example.com' }), null, 'other tailnet users must stay outside the terminal gateway');

// QR encoding is qrcode-generator's job; this pins that a real pairing link fits
// and that the vendored module is the one the browser will load.
const pairingCode = qrcode(0, 'M');
pairingCode.addData(pairingUrl('https://codingcube.codyh.xyz', 'https://mymac.tail47c266.ts.net', 'K'.repeat(32)));
pairingCode.make();
assert.equal((pairingCode.getModuleCount() - 17) % 4, 0, 'a QR symbol should have a valid version size');
assert.ok(pairingCode.isDark(0, 0), 'the finder pattern should anchor the symbol');
assert.ok(VENDOR_ASSETS.some(([route]) => route === '/vendor/qrcode.mjs'), 'the QR encoder must be vendored for the browser');

assert.deepEqual(
  herdrMetadata({
    result: {
      snapshot: {
        focused_workspace_id: 'w2',
        focused_tab_id: 'w2:t2',
        focused_pane_id: 'w2:p2',
        workspaces: [{ workspace_id: 'w2', label: 'coding-cube', agent_status: 'idle' }],
        tabs: [{ tab_id: 'w2:t2', label: 'Tests', agent_status: 'blocked' }],
        panes: [{ pane_id: 'w2:p2', agent_status: 'working' }],
      },
    },
  }),
  { label: 'Tests', status: 'working' },
  'focused HerdR metadata should drive each face',
);

const handFixtures = JSON.parse(await readFile(new URL('./hand-landmarks.json', import.meta.url), 'utf8'));
const openHand = trackedHand('open');
const pinchedHand = trackedHand('pinch');
const fistHand = trackedHand('fist');
const openSample = handSample(openHand);
const pinchSample = handSample(pinchedHand);
const fistSample = handSample(fistHand);
assert.ok(openSample.pinch > 1.5 && openSample.eligible, 'a recorded open hand should be a release posture');
assert.ok(pinchSample.pinch < 0.8 && pinchSample.eligible, 'a recorded thumb-index pinch should be grabbable');
assert.ok(Math.abs(handSample(trackedHand('pinch', 0.2, 0.1, 0.5)).pinch - pinchSample.pinch) < 1e-6, '3D pinch strength should be independent of camera position and hand size');
const distortedPinch = trackedHand('pinch');
distortedPinch.landmarks[8].x += 0.3;
assert.equal(handSample(distortedPinch).pinch, pinchSample.pinch, 'pinch should prefer MediaPipe world landmarks over the 2D projection');
assert.equal(fistSample.eligible, false, 'a closed fist should not masquerade as a pinch');

const actions = [];
const controller = new HandController({ id: 'hand-left', onAction: (action) => actions.push(action) });
for (const time of [0, 40, 80, 120]) controller.update(openHand, time);
controller.update(trackedHand('open', 0.001), 140);
controller.update(fistHand, 180);
controller.update(fistHand, 280);
assert.equal(actions.length, 0, 'open-hand jitter and a fist should never start a drag');
controller.update(pinchedHand, 320);
controller.update(pinchedHand, 400);
controller.update(trackedHand('pinch', 0.02), 440);
controller.update(null, 470);
controller.update(null, 650);
const actionsBeforeReacquire = actions.length;
controller.update(trackedHand('pinch', 0.1), 655);
assert.equal(actions.length, actionsBeforeReacquire, 'short-dropout reacquisition should rebase without jumping');
controller.update(trackedHand('pinch', 0.12), 690);
controller.update(trackedHand('open', 0.12), 720);
controller.update(trackedHand('open', 0.12), 780);
assert.equal(actions[0].type, 'start', 'a held pinch should start a drag');
assert.ok(actions.every(({ id }) => id === 'hand-left'), 'each controller should preserve its hand identity');
assert.ok(actions.some(({ type }) => type === 'move'), 'filtered palm movement should move the drag');
assert.equal(actions.at(-1).type, 'end', 'a sustained release should end the drag');

const lostActions = [];
const lostController = new HandController({ onAction: (action) => lostActions.push(action) });
for (const time of [0, 40, 80, 120]) lostController.update(openHand, time);
lostController.update(pinchedHand, 160);
lostController.update(pinchedHand, 240);
lostController.update(null, 260);
lostController.update(null, 461);
lostController.update(pinchedHand, 500);
lostController.update(pinchedHand, 700);
assert.deepEqual(lostActions.map(({ type }) => type), ['start', 'cancel'], 'a long dropout should cancel and require an open hand before rearming');

const settled = integrateDamped(0, MAX_ANGULAR_SPEED, SETTLE_SECONDS);
assert.equal(SETTLE_SECONDS, 10, 'momentum should damp for ten seconds by default');
assert.equal(MAX_SETTLE_SECONDS, 300, 'momentum slider should still reach five minutes');
assert.ok(Math.abs(settled.velocity - STOP_SPEED) < 1e-10, 'maximum drift should reach the stop threshold smoothly');
assert.ok(Math.abs(DAMPING - Math.log(600) / 10) < 1e-12, 'ambient drift should use ten-second damping by default');
assert.deepEqual([momentumDuration(0), momentumDuration(50), momentumDuration(100)], [0, 30, 300], 'momentum slider should use a hyperbolic scale');
assert.ok(Math.abs(momentumDuration(momentumSliderValue(10)) - 10) < 1e-10, 'slider should represent the ten-second default');

const fling = dragVelocity(12, -6, 16);
assert.ok(Math.abs(fling.x - 105) < 1e-10 && Math.abs(fling.y - 210) < 1e-10, 'drag velocity should preserve gesture direction and timing');
assert.ok(Math.hypot(...Object.values(dragVelocity(1000, 1000, 8))) - MAX_DRAG_ANGULAR_SPEED < 1e-10, 'drag velocity should be capped');
const dragSettled = integrateDamped(0, MAX_DRAG_ANGULAR_SPEED, SETTLE_SECONDS, DRAG_DAMPING);
assert.ok(Math.abs(dragSettled.velocity - DRAG_STOP_SPEED) < 1e-10, 'drag inertia should settle in ten seconds by default');
checkTwoInputSpace();

const webOrigin = 'https://cube.example';
const token = 'test-pairing-token';
const runtime = createRuntime({
  host: '127.0.0.1',
  port: 0,
  shell: '/bin/sh',
  webOrigin,
  token,
  tailnet: {
    identifyHeaders: (headers) => headers['tailscale-user-login'] === 'me@example.com' ? { login: 'me@example.com' } : null,
    identify: async () => null,
  },
});

try {
  const { host, port } = await runtime.start();
  const httpBase = `http://${host}:${port}`;
  const wsBase = `ws://${host}:${port}`;

  assert.equal((await fetch(`${httpBase}/health`, { headers: { origin: webOrigin } })).status, 401, 'the hosted UI must pair before reaching the host');
  const allowedOrigin = await fetch(`${httpBase}/health?token=${token}`, { headers: { origin: webOrigin } });
  assert.equal(allowedOrigin.status, 200);
  assert.equal(allowedOrigin.headers.get('access-control-allow-origin'), webOrigin, 'the paired hosted UI should receive CORS access');
  assert.equal((await fetch(`${httpBase}/health`, { headers: { origin: 'https://evil.example' } })).status, 403, 'unconfigured sites must be rejected');
  const preflight = await fetch(`${httpBase}/health`, { method: 'OPTIONS', headers: { origin: webOrigin } });
  assert.equal(preflight.status, 204, 'private-network preflights should succeed for the configured UI');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');

  // Anything arriving over a tailnet is remote even though the proxy dials from loopback.
  const forwarded = { 'x-forwarded-for': '100.64.0.5' };
  assert.equal((await fetch(`${httpBase}/health`, { headers: forwarded })).status, 401, 'a forwarded request must pair even without an Origin header');
  assert.equal((await fetch(`${httpBase}/api/herdr/state`, { headers: forwarded })).status, 401, 'forwarded API access must pair');
  assert.equal(
    (await fetch(`${httpBase}/health`, { headers: { ...forwarded, origin: webOrigin, 'tailscale-user-login': 'me@example.com' } })).status,
    200,
    'the hosted cube should work immediately for the identity authenticated by Tailscale Serve',
  );
  assert.equal(
    (await fetch(`${httpBase}/health`, { headers: { ...forwarded, origin: webOrigin, 'tailscale-user-login': 'random@example.com' } })).status,
    401,
    'an unapproved identity must not gain a shell merely by knowing the gateway address',
  );
  assert.equal((await fetch(`${httpBase}/health?token=${token}`, { headers: forwarded })).status, 200, 'a paired phone should reach the host over the tailnet');
  assert.equal((await fetch(`${httpBase}/`, { headers: forwarded })).status, 200, 'the app shell must load before a phone can present its pairing code');
  assert.equal((await fetch(`${httpBase}/health`)).status, 200, 'local tools share the trust domain of the shells they open');

  const hostInfo = await fetch(`${httpBase}/api/host/info?token=${token}`, { headers: forwarded });
  assert.equal(hostInfo.status, 200);
  assert.equal(hostInfo.headers.get('cache-control'), 'no-store', 'pairing details must never be cached');
  assert.equal((await hostInfo.json()).exposed, false, 'a loopback-only host should not advertise a tailnet address');

  // A page on any other origin — including another localhost port — must not be
  // able to read the pairing code, which is the one credential for remote access.
  const leaked = await (await fetch(`${httpBase}/api/host/info`, { headers: { origin: 'http://localhost:3000' } })).json();
  assert.equal(leaked.token, null, 'a cross-origin page must not be handed the pairing code');

  // DNS rebinding: a remote site resolving to loopback controls only its own
  // Origin and Host headers, and neither may grant it access.
  const rebound = await rawRequest(host, port, { Host: 'evil.example', Origin: 'http://evil.example' }, '/api/host/info');
  assert.match(rebound, /^HTTP\/1\.1 403/, 'a rebound origin must not reach the host by claiming its own Host header');
  assert.doesNotMatch(rebound, new RegExp(token), 'a rebound origin must never see the pairing code');
  const reboundSocket = await rawRequest(host, port, {
    Host: 'evil.example',
    Origin: 'http://evil.example',
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
  }, '/ws/pty?face=0&slot=0');
  assert.doesNotMatch(reboundSocket, /101 Switching Protocols/, 'a rebound origin must never open a terminal');

  const home = await fetch(`${httpBase}/`);
  assert.equal(home.status, 200, 'index should be served');
  const homeSource = await home.text();
  assert.match(homeSource, /Coding Cube/, 'index should contain the app shell');
  assert.match(homeSource, /momentum-duration/, 'settings should expose the momentum slider');
  assert.match(homeSource, /zero-gravity/, 'settings should expose the zero-gravity toggle');
  assert.match(homeSource, /hand-control/, 'settings should expose the opt-in hand control');
  assert.match(homeSource, /No computer attached/, "an unattached cube should say so plainly");
  assert.match(homeSource, /install\.sh \| sh/, "onboarding should be one pasteable line, not a build procedure");
  assert.doesNotMatch(homeSource, /npm install|npm start/, "a visitor has not cloned a repo, so do not tell them to build one");
  assert.match(homeSource, /id="connect-panel" popover/, 'the connect flow should be light-dismiss, never a blocking gate');
  assert.match(homeSource, /id="connect-host"[^>]*placeholder="[^"]*ts\.net[^"]*"/, 'the connect form should ask for a computer address');
  assert.match(homeSource, /id="host-list"/, 'the panel should list the computers you can switch between');
  assert.match(homeSource, /id="host-add"/, 'adding a computer should be an explicit action');
  assert.match(homeSource, /id="connect-token"/, 'the connect form should ask for a pairing code');
  assert.match(homeSource, /id="key-row"/, 'phones need keys a soft keyboard cannot produce');
  assert.match(homeSource, /data-key="ctrl"[^>]*aria-pressed/, 'the sticky ctrl key should report its armed state');
  assert.match(homeSource, /rel="manifest" href="\/manifest\.webmanifest"/, 'the cube should be installable on a phone');
  assert.match(homeSource, /id="desktop-shells" href="http:\/\/127\.0\.0\.1:8064\/"/, 'the desktop-shells action should open the local workspace');
  assert.match(homeSource, /viewport-fit=cover/, 'mobile layout should respect device safe areas');
  assert.doesNotMatch(homeSource, /<dialog|companion-gate/, 'a missing host must not block the cube with a menu');
  assert.match(homeSource, /id="wake"[^>]*hidden/, 'wake progress belongs inside the cube, and starts out of the way');
  assert.match(homeSource, /id="wake-elapsed"/, 'a wait with no elapsed time is the endless spinner the plan forbids');
  assert.match(homeSource, /id="wake-action"/, 'a state with no recovery action is a dead end');
  assert.match(homeSource, /id="workspace-live"[^>]*aria-live="polite"/, 'lifecycle changes must be announced without interrupting terminal input');
  assert.match(homeSource, /id="host-policy"/, 'when a workspace sleeps should be stated, not discovered');
  assert.doesNotMatch(homeSource, /HerdR, Pi, terminals/, 'the connection UI should not explain internal architecture');
  assert.doesNotMatch(homeSource, /companion|Interactive preview/i, 'the product should speak of a computer you own, not a companion');
  assert.equal(homeSource.match(/class="hand-cursor"/g)?.length, 2, 'the UI should expose one marker per tracked hand');

  const manifest = await fetch(`${httpBase}/manifest.webmanifest`);
  assert.equal(manifest.status, 200, 'the manifest should be served');
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/, 'the manifest needs its own media type to install');
  assert.equal((await manifest.json()).display, 'standalone', 'an installed cube should not render browser chrome');
  const icon = await fetch(`${httpBase}/icons/icon-192.png`);
  assert.equal(icon.headers.get('content-type'), 'image/png', 'icons must not be served as a download');

  const styles = await (await fetch(`${httpBase}/styles.css`)).text();
  assert.match(styles, /\(max-height: 520px\) and \(pointer: coarse\)/, 'short landscape phones should use the mobile controls');
  assert.match(styles, /\.hand-cursor\[data-state="ineligible"\]::after[^}]*content:\s*"Open fingers"/s, 'a rejected pinch should explain how to become eligible');
  assert.match(styles, /@media \(hover: hover\)/, 'hover states must not stick after a tap');
  assert.match(styles, /\.wake \{[^}]*pointer-events: none/s, 'the progress surface must not swallow taps meant for the cube behind it');
  assert.match(styles, /\.wake \{[^}]*width: min\(280px, calc\(100% - 32px\)\)/s, 'wake progress has to stay usable at 320px');
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[^@]*animation: none/s, 'a wake should become a state swap when motion is not wanted');
  assert.match(styles, /\.host-list i\[data-tone="bad"\]/, 'a workspace row should carry its own state dot');
  assert.match(styles, /\.host-list small b \{/, 'state is named in words, never encoded by the dot alone');

  // Deploys are invisible to returning visitors if the app can be cached without
  // revalidating, and these filenames carry no content hash.
  const headers = await readFile(new URL('../site/dist/_headers', import.meta.url), 'utf8');
  assert.match(headers, /^\/\*\n(?:.*\n)*?  Cache-Control: no-cache$/m, 'app assets must revalidate so a deploy reaches people');
  assert.match(styles, /\.panel\.is-focused \.terminal-surface[^{]*\{[^}]*touch-action: pan-y/s, 'scrollback should pan under a finger on the focused face');
  assert.match(styles, /body\.is-keyboard\s*\{[^}]*--cube:/s, 'the cube should shrink to fit above the soft keyboard');
  assert.doesNotMatch(styles, /max-height: calc\(100vh/, 'panel heights should follow the dynamic viewport on phones');

  const script = await fetch(`${httpBase}/app/terminals.js`);
  assert.equal(script.status, 200, 'terminal client should be served');
  const terminalSource = await script.text();
  assert.match(terminalSource, /AttachAddon/, 'official attach addon should be used');
  assert.match(terminalSource, /WebglAddon/, 'official WebGL addon should be used');
  assert.match(terminalSource, /attachCustomKeyEventHandler/, 'terminal should install the command-key bindings');
  assert.match(terminalSource, /Math\.min\(1000 \* 2 \*\* entry\.failures\+\+, 60_000\)/, 'terminal retries should back off to a one-minute ceiling');
  assert.match(terminalSource, /AWS login required; run `aws login`, then choose Retry/, 'expired AWS login should require explicit recovery instead of reconnecting');
  const windowActivity = terminalSource.match(/setWindowActive\(active\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.doesNotMatch(windowActivity, /ws\.close\(\)/, 'switching tabs should preserve terminal sockets and screen state');
  assert.match(
    terminalSource,
    /focus\(face\) \{[^}]*entry\.term\.focus\(\);/s,
    'focus must run inside the tap gesture or iOS will not raise the keyboard',
  );
  assert.match(terminalSource, /beforeinput/, 'sticky ctrl must also work with Android input methods');

  const main = await fetch(`${httpBase}/app/main.js`);
  assert.equal(main.status, 200, 'main client should be served');
  const mainSource = await main.text();
  assert.match(mainSource, /new EventSource\(hostHttp\('\/api\/herdr\/events'\)\)/, 'the UI should subscribe to HerdR events');
  assert.match(mainSource, /space\.bind\(\);\s*connectHost\(\);/, 'every device should try to reach a host');
  assert.doesNotMatch(mainSource, /pointer: fine/, 'phones must not be excluded from pairing');
  assert.match(mainSource, /await fleet\.transport\.probe\(\)/, 'main should delegate reachability to the selected transport');
  const transportSource = await (await fetch(`${httpBase}/app/transport.js`)).text();
  assert.match(transportSource, /AbortSignal\.timeout\(3000\)/, 'an unreachable origin should stop background pairing quickly');
  assert.match(mainSource, /function setConnectionState\(/, 'the UI should track one connection state rather than a preview flag');
  assert.match(mainSource, /desktopShells\.href = hostHttp\('\/'\)/, 'desktop shells should use the shared host URL');
  assert.match(mainSource, /if \(active\) connectHost\(\)/, 'returning to the tab should re-check the host');
  assert.match(mainSource, /if \(!isPageActive\(\)\) return;/, 'sockets closed by backgrounding must not read as a lost host');
  assert.match(mainSource, /location\.href = plan\.directUrl/, 'a host with no secure address should be opened for the user, not described to them');
  // connectHost() runs while this module evaluates, so anything it reads has to be
  // declared above it or the temporal dead zone turns into a silently caught error.
  const handoffWindow = mainSource.indexOf('const HANDOFF_WINDOW_MS');
  assert.ok(handoffWindow > 0 && handoffWindow < mainSource.indexOf('connectHost();'), 'handoff constants must be initialised before the first connect');
  assert.doesNotMatch(mainSource, /companion|showModal/i, 'connection failure should never open a blocking gate');
  assert.doesNotMatch(mainSource, /setInterval/, 'HerdR state should not be polled');
  assert.match(mainSource, /lifecycle\.update\(\{ faces: open \}\)/, 'how many faces are live is the difference between waking and ready');
  assert.match(mainSource, /setDetailInterest\(event\.newState === 'open'/, 'workspace details are refreshed when asked for, never in the background');
  assert.match(mainSource, /if \(stateChanged && snapshot\.state\)/, 'only a state change reaches the live region');
  assert.match(mainSource, /if \(cloud && cloudCancelled\) return;/, 'a cancelled wake must survive a tab switch');

  const lifecycleModule = await fetch(`${httpBase}/app/workspace.js`);
  assert.equal(lifecycleModule.status, 200, 'the lifecycle module should be served');

  const shader = await fetch(`${httpBase}/app/shader.js`);
  assert.equal(shader.status, 200, 'custom shader should be served');
  const shaderSource = await shader.text();
  assert.match(shaderSource, /gl_FragColor/, 'custom fragment shader should compile in the browser');
  assert.doesNotMatch(shaderSource, /u_time|devicePixelRatio|prefers-reduced-motion/, 'shader should only redraw on events at DPR 1');

  for (const asset of ['xterm.mjs', 'addon-attach.mjs', 'addon-webgl.mjs']) {
    const response = await fetch(`${httpBase}/vendor/${asset}`);
    assert.equal(response.status, 200, `${asset} should be served locally`);
  }
  const handWorker = await fetch(`${httpBase}/app/hand-worker.js`);
  assert.equal(handWorker.status, 200, 'hand inference worker should be served');
  const handWorkerSource = await handWorker.text();
  assert.match(handWorkerSource, /HandLandmarker/, 'the worker should use landmark-only hand inference');
  assert.match(handWorkerSource, /detectForVideo/, 'hand inference should process video frames in the worker');
  assert.match(handWorkerSource, /numHands: 2/, 'the existing model should expose both hands');
  assert.match(handWorkerSource, /worldLandmarks: result\.worldLandmarks/, 'the worker should preserve MediaPipe 3D landmarks');
  assert.match(handWorkerSource, /handedness: result\.handedness/, 'hand identity should come from MediaPipe');
  assert.doesNotMatch(handWorkerSource, /result\.landmarks\[0\]/, 'the worker should not discard the second hand');
  assert.doesNotMatch(handWorkerSource, /GestureRecognizer/, 'unused canned gesture classification should not run');
  assert.match(handWorkerSource, /forVisionTasks\('\/vendor\/mediapipe\/wasm', true\)/, 'module workers should load the ES module WASM runtime');

  for (const asset of [
    '/vendor/mediapipe/vision_bundle.mjs',
    '/vendor/mediapipe/wasm/vision_wasm_module_internal.js',
    '/models/hand_landmarker.task',
  ]) {
    const response = await fetch(`${httpBase}${asset}`, { method: 'HEAD' });
    assert.equal(response.status, 200, `${asset} should be served locally`);
  }
  const mediapipeWasm = await fetch(`${httpBase}/vendor/mediapipe/wasm/vision_wasm_module_internal.wasm`, { method: 'HEAD' });
  assert.equal(mediapipeWasm.status, 200, 'MediaPipe WASM should be served locally');
  assert.equal(mediapipeWasm.headers.get('content-type'), 'application/wasm', 'MediaPipe WASM should use its native content type');

  await rejectsWebSocketOrigin(wsBase);
  const slot0 = await openPty(wsBase, 0, 0);
  const slot1 = await openPty(wsBase, 0, 1);
  const face4 = await openPty(wsBase, 4, 2);

  slot0.input('stty size\r');
  await slot0.waitFor('24 80');

  slot0.input('CODING_CUBE_PROBE=alpha; printf "probe:%s:%s:%s\\n" "$CODING_CUBE_FACE" "$CODING_CUBE_SLOT" "$CODING_CUBE_PROBE"\r');
  await slot0.waitFor('probe:0:0:alpha');
  const replay = await openPty(wsBase, 0, 0);
  await replay.waitFor('probe:0:0:alpha');

  slot1.input('printf "probe:%s:%s:%s\\n" "$CODING_CUBE_FACE" "$CODING_CUBE_SLOT" "${CODING_CUBE_PROBE-empty}"\r');
  await slot1.waitFor('probe:0:1:empty');

  face4.input('printf "probe:%s:%s\\n" "$CODING_CUBE_FACE" "$CODING_CUBE_SLOT"\r');
  await face4.waitFor('probe:4:2');

  // A ten-face cube addresses faces 0..9. Before this the grid clamped anything past
  // 5 onto face 5, so faces 7 through 10 would all have shared one terminal.
  const face9 = await openPty(wsBase, 9, 0);
  face9.input('printf "probe:%s:%s\\n" "$CODING_CUBE_FACE" "$CODING_CUBE_SLOT"\r');
  await face9.waitFor('probe:9:0');
  // An eleventh face is clamped onto the tenth rather than opening an eleventh shell:
  // it lands in face 9's existing session and is handed its scrollback.
  const face10 = await openPty(wsBase, 10, 0);
  await face10.waitFor('probe:9:0');

  await rejectsInvalidResize(wsBase);

  slot0.close();
  replay.close();
  slot1.close();
  face4.close();
  face9.close();
  face10.close();
  await waitUntil(() => runtime.terminalGrid.sessions.size === 0);
  assert.equal(runtime.terminalGrid.sessions.size, 0, 'closing the last browser client should detach its proxy');
  console.log('smoke ok');
} finally {
  await runtime.stop();
}

// transport.js pulls in connection.js, which reads location while it evaluates.
async function importTransport() {
  const previous = globalThis.location;
  try {
    globalThis.location = { origin: 'http://127.0.0.1', protocol: 'http:', hash: '', pathname: '/', search: '' };
    return await import('../public/app/transport.js');
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
}

// Six faces is a default, not a shape. Everything below is the count being adjustable
// 6..10 without a user who never touches the setting seeing any difference.
async function checkFaceCount() {
  assert.equal(DEFAULT_FACE_COUNT, 6, 'the shipped cube is six faces and stays six for anyone who never asks');
  assert.equal(MIN_FACE_COUNT, 6, 'below six the shape stops being a cube at all');
  assert.equal(DEFAULT_FACE_COUNT, CANONICAL_DEFAULT_FACE_COUNT);
  assert.equal(MIN_FACE_COUNT, CANONICAL_MIN_FACE_COUNT);
  // Measured, not read off a docs page: spike/RESULTS.md T-10 opened twelve shells
  // across two sessions on one runtime, which is what proved the cap is per SESSION.
  // One workspace is one session, so ten is the hard ceiling on faces.
  assert.equal(MAX_FACE_COUNT, 10, 'AgentCore allows ten concurrent shells per runtime session (spike/RESULTS.md T-10)');
  assert.equal(MAX_FACE_COUNT, CANONICAL_MAX_FACE_COUNT);
  assert.equal(MAX_FACES, MAX_FACE_COUNT, 'geometry imports the canonical measured ceiling');
  assert.equal(clampFaceCount, canonicalClampFaceCount, 'the server re-exports the canonical clamp instead of implementing another one');
  assert.deepEqual(clampFaceCount(undefined), { faces: 6, requested: null, clamped: false }, 'a client that never mentions faces must get exactly today\'s cube');
  assert.deepEqual(clampFaceCount('8'), { faces: 8, requested: 8, clamped: false }, 'the count arrives as a query string and must survive the trip');
  assert.deepEqual(clampFaceCount(11), { faces: 10, requested: 11, clamped: true }, 'past the ceiling the gateway clamps and says so rather than failing');
  assert.deepEqual(clampFaceCount(2), { faces: 6, requested: 2, clamped: true }, 'under the floor clamps the same way');

  assert.equal(parseHarnessStatus, parseProtocolStatus, 'the harness consumes the production status parser without duplicating it');
  assert.equal(encodeHarnessResize, encodeProtocolResize, 'the harness consumes the production resize codec without duplicating it');
  assert.equal(encodeHarnessStdin, encodeProtocolStdin, 'the harness consumes the production stdin codec without duplicating it');
  const statusCases = [
    { payload: '{not-json', type: 'unparsed' },
    { payload: JSON.stringify({ metadata: { shellId: 'face-1', reconnected: true, bytesDropped: 4 } }), type: 'confirmation' },
    { payload: JSON.stringify({ details: { causes: [{ reason: 'ExitCode', message: '7' }] } }), type: 'exit' },
    { payload: JSON.stringify({ status: 'Failure', reason: 'Nope', code: 'Bad' }), type: 'error' },
  ];
  for (const { payload, type } of statusCases) {
    assert.equal(parseProtocolStatus(new TextEncoder().encode(payload)).type, type, `${type} status frames must classify consistently`);
  }
  const stdin = encodeProtocolStdin(new Uint8Array(65_536));
  assert.equal(stdin.length, 2, 'stdin beyond one payload is split before it reaches the service');
  assert.ok(stdin.every((frame) => frame[0] === SHELL_CHANNEL.STDIN && frame.length <= 65_536));

  const { clampFaceCount: clampInBrowser, createShellTransport, MAX_FACE_COUNT: BROWSER_MAX } = await importTransport();
  assert.equal(BROWSER_MAX, MAX_FACE_COUNT, 'the browser imports the canonical measured ceiling');
  assert.equal(clampInBrowser, canonicalClampFaceCount, 'the browser transport re-exports the canonical clamp');
  const transport = createShellTransport({
    sessionId: 'cube-test-12345678-1234-1234-1234-123456789012',
    scrollback: null,
    mintUrl: async () => 'wss://example.test/',
    ensureWorkspace: async () => ({ state: 'ready', faces: [] }),
  });
  assert.equal(transport.faces, 6, 'a transport nobody configured is a six-face cube');
  assert.deepEqual(
    [...transport.encodeResize(79.9, 24.8)],
    [...encodeProtocolResize(79.9, 24.8)],
    'the production transport uses the shared resize codec',
  );
  assert.equal(transport.shellIdFor(0), 'face-1', 'the faceOffset 1 rule is unchanged');
  assert.equal(transport.shellIdFor(9), 'face-10', 'the tenth face is face-10, not a new id scheme');
  assert.throws(
    () => transport.openTerminal(10),
    /10 concurrent shells/,
    'the eleventh shell must be refused here with the real reason, not left to fail at the WebSocket handshake',
  );
  assert.equal(createShellTransport({
    sessionId: 'cube-test-12345678-1234-1234-1234-123456789012',
    scrollback: null,
    faces: 12,
    mintUrl: async () => 'wss://example.test/',
    ensureWorkspace: async () => ({ state: 'ready', faces: [] }),
  }).faces, 10, 'a transport asked for twelve faces settles at the ceiling instead of throwing');
  assert.throws(
    () => createShellTransport({ mintUrl: async () => 'wss://example.test/' }),
    /mnt\/workspace/,
    'ensureWorkspace stays REQUIRED: a shell opened before the mount exists loses all work at idle timeout',
  );

  // The browser asks for a count on the one call it already makes, and the gateway
  // hands it to the container. A dropped parameter here is a cube that silently
  // refuses to widen.
  const asked = [];
  const routes = createCloudRoutes({ minter: { prepare: async (options) => { asked.push(options); return { ok: true }; } } });
  await routes({}, collectResponse(), new URL('http://gateway.test/prepare?sessionId=s&faces=9'), undefined);
  assert.equal(asked[0].faces, '9', '/prepare must forward the requested face count to the minter');
  await routes({}, collectResponse(), new URL('http://gateway.test/prepare?sessionId=s'), undefined);
  assert.equal(asked[1].faces, null, 'a /prepare with no faces parameter must stay exactly the call it is today');
  const mintSource = await readFile('src/server/cloud/mint.js', 'utf8');
  assert.match(mintSource, /invokeRuntime\(target, \{ op, faces: request\.faces \}\)/, 'the clamped count must reach the container in the invocation body');
  assert.match(mintSource, /facesClamped/, 'a clamp the user did not ask for must be reported in the response');
  assert.match(
    await readFile('src/server/agentcore.js', 'utf8'),
    /stateResponse\(op, body\?\.faces\)/,
    'the container gateway must honour the count the invocation carries',
  );
  assert.match(
    await readFile('src/server/terminal-grid.js', 'utf8'),
    /FACE_MAX = MAX_FACE_COUNT - 1/,
    'the grid bound must follow the measured ceiling rather than keep a second copy of it',
  );

  // Growing and shrinking against a herdr that really mutates its snapshot, so "never
  // removes" is measured rather than reviewed.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coding-cube-faces-'));
  try {
    const herdr = await writeFakeHerdr(directory);
    const six = await ensureCubeWorkspace(herdr.executable, 'Coding Cube', directory);
    assert.equal(six.length, 6, 'the default is still six tabs and six faces');

    const ten = await ensureCubeWorkspace(herdr.executable, 'Coding Cube', directory, 10);
    assert.equal(ten.length, 10, 'asking for ten faces must produce ten');
    assert.deepEqual(ten.slice(0, 6).map(({ paneId }) => paneId), six.map(({ paneId }) => paneId), 'growing must not disturb the faces that were already open');

    const shrunk = await ensureCubeWorkspace(herdr.executable, 'Coding Cube', directory, 6);
    assert.equal(shrunk.length, 6, 'shrinking renders six faces');
    // The whole point: Face 9 may hold an agent mid-task. Hiding it is a rendering
    // decision; closing its tab would destroy work with no way back.
    assert.equal(await herdr.tabCount(), 10, 'shrinking the cube must never remove a tab');
    assert.deepEqual(await herdr.creations(), ['1', ...Array.from({ length: 9 }, (_, face) => `Face ${face + 2}`)], 'nothing may be created twice and nothing may be closed');

    const regrown = await ensureCubeWorkspace(herdr.executable, 'Coding Cube', directory, 10);
    assert.deepEqual(regrown.map(({ paneId }) => paneId), ten.map(({ paneId }) => paneId), 'growing back must reattach the same panes, not fresh ones');

    const envelope = { result: { snapshot: JSON.parse(await readFile(herdr.statePath, 'utf8')) } };
    assert.equal(countCubeFaces(envelope), 10, 'the tabs that exist are what the workspace holds, whatever is being rendered');
    assert.equal(selectCubeFaces(envelope, 'Coding Cube', 6).length, 6, 'a rendered cube is exactly the count asked for');
    // /ping judges panes, and a hidden pane can still hold a working agent. Scoping
    // sleep to the visible faces would make shrinking the cube a way to sleep a
    // microVM out from under an agent that is mid-task.
    assert.equal(cubePaneIds(envelope).length, 10, 'hidden faces must stay inside the scope that keeps the machine awake');
    // One hidden face whose pane died must not take the six visible ones down with it.
    const broken = { result: { snapshot: { ...envelope.result.snapshot, panes: envelope.result.snapshot.panes.filter(({ tab_id }) => tab_id !== 'w1:t8') } } };
    assert.equal(countCubeFaces(broken), 7, 'a face missing its pane ends the count instead of poisoning the snapshot');
    assert.equal(selectCubeFaces(broken, 'Coding Cube', 6).length, 6, 'a six-face cube must keep rendering while a hidden face is broken');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.deepEqual(
    cubeSetupPlan({ result: { snapshot: { workspaces: [], tabs: [] } } }, 'Coding Cube', 10),
    { workspaceId: null, renameTabId: null, createFaces: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    'a ten-face cube provisions ten tabs on a machine that has never had one',
  );
  assert.doesNotMatch(
    await readFile('src/server/herdr-state.js', 'utf8'),
    /'tab',\s*'close'/,
    'nothing in the workspace layer may close a tab: the count is what is rendered, not what exists',
  );
}

// A herdr that keeps state, so growing, shrinking and growing back are real
// transitions rather than three independent snapshots.
async function writeFakeHerdr(directory) {
  const statePath = path.join(directory, 'snapshot.json');
  const logPath = path.join(directory, 'created.log');
  const scriptPath = path.join(directory, 'herdr.mjs');
  await writeFile(statePath, JSON.stringify({ workspaces: [], tabs: [], panes: [], agents: [] }));
  await writeFile(logPath, '');
  await writeFile(scriptPath, `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const STATE = ${JSON.stringify(statePath)};
const LOG = ${JSON.stringify(logPath)};
const args = process.argv.slice(2).filter((value, index) => !(index < 2 && (value === '--session' || value === 'default')));
const snapshot = JSON.parse(readFileSync(STATE, 'utf8'));
const save = () => writeFileSync(STATE, JSON.stringify(snapshot));
const option = (name) => args[args.indexOf(name) + 1];
const addTab = (workspaceId, label) => {
  const index = snapshot.tabs.length + 1;
  const tab = { tab_id: 'w1:t' + index, workspace_id: workspaceId, label };
  snapshot.tabs.push(tab);
  snapshot.panes.push({ pane_id: 'w1:p' + index, tab_id: tab.tab_id, workspace_id: workspaceId, terminal_id: 'term-' + index });
  appendFileSync(LOG, label + '\\n');
  return tab;
};
if (args[0] === 'api' && args[1] === 'snapshot') {
  process.stdout.write(JSON.stringify({ result: { snapshot } }));
} else if (args[0] === 'workspace' && args[1] === 'create') {
  const workspace = { workspace_id: 'w1', label: option('--label') };
  snapshot.workspaces.push(workspace);
  const tab = addTab('w1', '1');
  save();
  process.stdout.write(JSON.stringify({ result: { workspace, tab } }));
} else if (args[0] === 'tab' && args[1] === 'create') {
  addTab(option('--workspace'), option('--label'));
  save();
  process.stdout.write('{}');
} else if (args[0] === 'tab' && args[1] === 'rename') {
  snapshot.tabs.find(({ tab_id }) => tab_id === args[2]).label = args[3];
  save();
  process.stdout.write('{}');
} else {
  process.stderr.write('unsupported: ' + args.join(' '));
  process.exit(2);
}
`);
  const executable = path.join(directory, 'herdr');
  await writeFile(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)} "$@"\n`);
  await chmod(executable, 0o755);
  return {
    executable,
    statePath,
    async tabCount() {
      return JSON.parse(await readFile(statePath, 'utf8')).tabs.length;
    },
    async creations() {
      return (await readFile(logPath, 'utf8')).split('\n').filter(Boolean);
    },
  };
}

// The cloud routes write to a node:http response; these tests only need it not to throw.
function collectResponse() {
  return { writeHead() {}, end() {}, setHeader() {} };
}

async function checkRuntimeProvisioningHelper() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coding-cube-runtime-lib-'));
  const attempts = path.join(directory, 'attempts');
  const calls = path.join(directory, 'calls');
  await writeFile(attempts, '0');
  const helper = fileURLToPath(new URL('../spike/aws/runtime-lib.sh', import.meta.url));

  const runHelper = (body) => new Promise((resolve) => {
    const child = spawn('sh', ['-c', body], {
      env: { ...process.env, RUNTIME_LIB: helper, ATTEMPTS: attempts, CALLS: calls },
    });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.once('close', (code) => resolve({ code, output }));
  });

  try {
    const ready = await runHelper(`
      set -eu
      . "$RUNTIME_LIB"
      die() { printf '%s\\n' "$1" >&2; exit 7; }
      aws_() { printf 'READY\\n'; }
      sleep() { :; }
      runtime_wait_ready runtime-ready
    `);
    assert.equal(ready.code, 0, `READY should settle provisioning: ${ready.output}`);

    const failed = await runHelper(`
      set -eu
      . "$RUNTIME_LIB"
      die() { printf '%s\\n' "$1" >&2; exit 7; }
      aws_() { case "$*" in *failureReason*) printf 'bad image\\n' ;; *) printf 'CREATE_FAILED\\n' ;; esac; }
      sleep() { :; }
      runtime_wait_ready runtime-failed
    `);
    assert.equal(failed.code, 7, 'a terminal AgentCore status must use the caller\'s failure path');
    assert.match(failed.output, /CREATE_FAILED \(bad image\)/);

    const retried = await runHelper(`
      set -eu
      . "$RUNTIME_LIB"
      die() { printf '%s\\n' "$1" >&2; exit 7; }
      say() { :; }
      warn() { printf '%s\\n' "$1" >&2; }
      run() { "$@"; }
      sleep() { :; }
      METADATA='{"requireMMDSV2":true}'
      aws_() {
        case "$*" in
          *create-agent-runtime*)
            count=$(cat "$ATTEMPTS"); count=$((count + 1)); printf '%s' "$count" > "$ATTEMPTS"
            [ "$count" -gt 1 ] || return 1
            printf 'runtime-retried\\n'
            ;;
          *update-agent-runtime*) printf '%s\\n' "$*" >> "$CALLS" ;;
          *get-agent-runtime*) printf 'READY\\n' ;;
        esac
      }
      runtime_create_with_retry cube_test --agent-runtime-artifact artifact --role-arn role
      runtime_enable_mmdsv2 "$RUNTIME_ID" --agent-runtime-artifact artifact --role-arn role
    `);
    assert.equal(retried.code, 0, `an IAM propagation retry should recover: ${retried.output}`);
    assert.equal(await readFile(attempts, 'utf8'), '2', 'runtime creation should retry once after a propagation failure');
    const update = await readFile(calls, 'utf8');
    assert.match(update, /--agent-runtime-artifact artifact/);
    assert.match(update, /--metadata-configuration \{"requireMMDSV2":true\}/, 'the shared update remains a full replacement with MMDSv2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checkAwsLoginFailStop() {
  const { createShellTransport } = await importTransport();
  const authError = Object.assign(new Error('AWS login required'), { code: 'AWS_LOGIN_REQUIRED' });
  let prepareAttempts = 0;
  const transport = createShellTransport({
    sessionId: 'cube-test-12345678-1234-1234-1234-123456789012',
    scrollback: null,
    mintUrl: async () => { throw authError; },
    ensureWorkspace: async () => {
      prepareAttempts += 1;
      throw authError;
    },
  });
  const closes = await Promise.all(Array.from({ length: 6 }, (_, face) => {
    const socket = transport.openTerminal(face);
    return new Promise((resolve) => socket.addEventListener('close', resolve));
  }));
  assert.equal(prepareAttempts, 1, 'six faces should share one credential-dependent workspace attempt');
  assert.ok(closes.every(({ code }) => code === 1011), 'expired AWS login must be a permanent close, not an automatic retry');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(prepareAttempts, 1, 'expired AWS login must stay stopped until explicit user action');

  const directory = await mkdtemp(path.join(os.tmpdir(), 'coding-cube-aws-auth-'));
  const bin = path.join(directory, 'bin');
  const awsCalls = path.join(directory, 'aws-calls');
  await mkdir(bin);
  const fakeAws = path.join(bin, 'aws');
  await writeFile(fakeAws, `#!/bin/sh\nprintf x >> "$AWS_CALLS"\nsleep 1\nexit 1\n`);
  await chmod(fakeAws, 0o755);

  const env = {
    ...process.env,
    HOME: directory,
    PATH: `${bin}:${process.env.PATH}`,
    AWS_CALLS: awsCalls,
    AWS_CONFIG_FILE: path.join(directory, 'config'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(directory, 'credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_LOGIN_CACHE_DIRECTORY',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  ]) delete env[key];

  const port = await unusedPort();
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../spike/mint-server.mjs', import.meta.url)),
    '--runtime-arn',
    'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test',
    '--port',
    String(port),
  ], { env });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    await waitUntil(() => output.includes('mint server on'), 5000);
    assert.equal(child.exitCode, null, `minter should stay up without credentials:\n${output}`);
    const sessionId = 'cube-test-12345678-1234-1234-1234-123456789012';
    const replies = await Promise.all(Array.from({ length: 6 }, async (_, face) => {
      const response = await fetch(`http://127.0.0.1:${port}/mint?face=${face}&sessionId=${sessionId}`);
      return { status: response.status, body: await response.json() };
    }));
    assert.ok(replies.every(({ status, body }) => status === 503 && body.code === 'AWS_LOGIN_REQUIRED'), 'all concurrent faces should receive an explicit AWS login stop signal');
    assert.equal(await readFile(awsCalls, 'utf8').catch(() => ''), '', 'credential failure must never spawn the AWS CLI');
    assert.equal(child.exitCode, null, 'credential failure should not kill the minter needed for manual recovery');
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function checkRenamedBrowserStore() {
  const data = new Map();
  let writes = 0;
  const storage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      writes += 1;
      data.set(key, value);
    },
    removeItem: (key) => data.delete(key),
  };
  const legacyKey = `${['cmux', '3d'].join('')}.hosts.v1`;
  data.set(legacyKey, JSON.stringify({
    version: 1,
    activeOrigin: 'https://saved.example',
    hosts: { 'https://saved.example': { origin: 'https://saved.example', name: 'Saved', token: 'secret' } },
  }));
  const previous = Object.fromEntries(['location', 'localStorage', 'sessionStorage', 'history'].map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, {
    location: { origin: 'https://codingcube.codyh.xyz', protocol: 'https:', hash: '', pathname: '/', search: '' },
    localStorage: storage,
    sessionStorage: storage,
    history: { replaceState() {} },
  });
  try {
    const connection = await import(`../public/app/connection.js?rename-test=${Date.now()}`);
    assert.equal(connection.activeHost().token, 'secret', 'the product rename must preserve paired computers');
    assert.equal(data.has(legacyKey), false, 'the old browser key should be removed after migration');
    const beforeConnected = writes;
    connection.markConnected();
    assert.equal(writes, beforeConnected + 1, 'markConnected should persist the active host and timestamp in one write');
    assert.ok(data.has('coding-cube.hosts.v1'), 'the renamed browser key should be written');

    // A browser that used the Tailscale box, then the cloud back when it was called
    // "Cloud (AgentCore)". Both are stale identities that must not outlive an update.
    data.set('coding-cube.hosts.v1', JSON.stringify({
      version: 1,
      activeOrigin: 'https://cloud-agent.tail47c266.ts.net',
      hosts: {
        'https://cloud-agent.tail47c266.ts.net': { origin: 'https://cloud-agent.tail47c266.ts.net', name: 'Cloud Agent', token: '', builtIn: true },
        'http://127.0.0.1:8787': { origin: 'http://127.0.0.1:8787', name: 'Cloud (AgentCore)', token: '', kind: 'agentcore', builtIn: true },
        'http://127.0.0.1:8064': { origin: 'http://127.0.0.1:8064', name: 'This computer', token: 'kept', builtIn: true },
        'https://mymac.tailnet.ts.net': { origin: 'https://mymac.tailnet.ts.net', name: 'mymac', token: 'mine' },
      },
    }));
    const migrated = await import(`../public/app/connection.js?retired-test=${Date.now()}`);
    const names = migrated.listHosts().map((host) => host.name);
    assert.equal(names.includes('Cloud Agent'), false, 'a built-in retired by an update must not linger as a second cloud');
    assert.equal(names.filter((name) => /cloud/i.test(name)).length, 1, 'there should be exactly one cloud');
    assert.ok(!names.some((name) => /agentcore/i.test(name)), 'the runtime AgentCore is an implementation detail and must never reach the UI');
    assert.ok(names.includes('mymac'), 'a computer the user paired themselves must survive');
    assert.equal(migrated.listHosts().find((host) => host.origin === 'http://127.0.0.1:8064')?.token, 'kept', 'a stale name must not cost the user their pairing code');
    assert.notEqual(migrated.activeHost().origin, 'https://cloud-agent.tail47c266.ts.net', 'the active host must move off a retired built-in');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

async function checkGatewayOnly() {
  const runtime = createRuntime({ host: '127.0.0.1', port: 0, gatewayOnly: true });
  try {
    const { host, port } = await runtime.start();
    assert.equal((await fetch(`http://${host}:${port}/health`)).status, 200, 'the terminal gateway should keep its health route');
    assert.equal((await fetch(`http://${host}:${port}/`)).status, 404, 'the terminal gateway must not serve another copy of the hosted cube');
  } finally {
    await runtime.stop();
  }
}

async function checkHerdrStateEndpoint() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'coding-cube-herdr-'));
  const executable = path.join(directory, 'herdr');
  const statePath = path.join(directory, 'state.json');
  const socketPath = path.join(directory, 'herdr.sock');
  const snapshot = {
    workspaces: [{ workspace_id: 'w9', label: 'Coding Cube' }],
    tabs: Array.from({ length: 6 }, (_, face) => ({
      tab_id: `w9:t${face + 1}`,
      workspace_id: 'w9',
      label: `Face ${face + 1}`,
      number: face + 1,
      agent_status: 'unknown',
    })),
    panes: Array.from({ length: 6 }, (_, face) => ({
      pane_id: `w9:p${face + 1}`,
      tab_id: `w9:t${face + 1}`,
      workspace_id: 'w9',
      terminal_id: `term-${face}`,
      agent_status: 'unknown',
    })),
    layouts: Array.from({ length: 6 }, (_, face) => ({
      tab_id: `w9:t${face + 1}`,
      workspace_id: 'w9',
      focused_pane_id: `w9:p${face + 1}`,
    })),
    agents: [],
  };
  const clients = new Set();
  const eventServer = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('data', (raw) => {
      const request = JSON.parse(String(raw).trim());
      assert.equal(request.method, 'events.subscribe');
      assert.ok(request.params.subscriptions.some(({ type }) => type === 'tab.renamed'));
      assert.equal(request.params.subscriptions.filter(({ type }) => type === 'pane.agent_status_changed').length, 6);
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    eventServer.once('error', reject);
    eventServer.listen(socketPath, resolve);
  });

  const previousSocket = process.env.CODING_CUBE_TEST_HERDR_SOCKET;
  const previousState = process.env.CODING_CUBE_TEST_HERDR_STATE;
  process.env.CODING_CUBE_TEST_HERDR_SOCKET = socketPath;
  process.env.CODING_CUBE_TEST_HERDR_STATE = statePath;
  let runtime;

  try {
    await writeFile(statePath, JSON.stringify({ result: { snapshot } }));
    await writeFile(executable, `#!/bin/sh
if [ "$1:$2:$3:$4" = "--session:default:status:server" ]; then
  printf 'status: running\\nsocket: %s\\n' "$CODING_CUBE_TEST_HERDR_SOCKET"
elif [ "$1:$2:$3:$4" = "--session:default:api:snapshot" ]; then
  cat "$CODING_CUBE_TEST_HERDR_STATE"
elif [ "$1:$2:$3:$4" = "--session:default:terminal:attach" ]; then
  printf 'attached:%s:%s\\n' "$5" "$6"
  while IFS= read -r line; do printf 'echo:%s:size:%s\\n' "$line" "$(stty size)"; done
else
  exit 2
fi
`);
    await chmod(executable, 0o755);
    runtime = createRuntime({ host: '127.0.0.1', port: 0, herdr: executable });
    const { host, port } = await runtime.start();
    const httpBase = `http://${host}:${port}`;
    const wsBase = `ws://${host}:${port}`;
    const response = await fetch(`${httpBase}/api/herdr/state`);
    assert.equal(response.status, 200, 'canonical Herdr state should be exposed');
    const state = await response.json();
    assert.deepEqual(
      state.map(({ face, session, workspace, tabId, paneId, terminalId, snapshot: envelope }) => ({
        face,
        session,
        workspace,
        tabId,
        paneId,
        terminalId,
        focusedTab: envelope.result.snapshot.focused_tab_id,
      })),
      Array.from({ length: 6 }, (_, face) => ({
        face,
        session: 'default',
        workspace: 'Coding Cube',
        tabId: `w9:t${face + 1}`,
        paneId: `w9:p${face + 1}`,
        terminalId: `term-${face}`,
        focusedTab: `w9:t${face + 1}`,
      })),
      'each face should be derived from one canonical workspace',
    );

    const face = await openPty(wsBase, 2, 0);
    // The id must come first and --takeover must be present. Both halves are
    // load-bearing against the real binary: the flag before the id makes herdr exit
    // 2 with "unknown option", and no flag at all makes a reconnect fail with
    // "already has an attached client", which is what a browser reload does.
    await face.waitFor('attached:term-2:--takeover');
    face.input('cube-probe\r');
    await face.waitFor('echo:cube-probe:size:24 80');

    const events = await fetch(`${httpBase}/api/herdr/events`);
    assert.equal(events.status, 200, 'HerdR event stream should be exposed');
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: ready/, 'event stream should subscribe before bootstrapping state');
    assert.equal(clients.size, 1, 'the cube should watch one canonical HerdR session');
    clients.values().next().value.write('{"event":"tab_renamed","data":{}}\n');
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: change/, 'HerdR events should invalidate UI state');
    clients.values().next().value.write('{"event":"pane_moved","data":{}}\n');
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: change/, 'replayed topology events should be harmless notifications');
    assert.equal(runtime.terminalGrid.sessions.size, 1, 'an event alone should not close a working terminal');

    const changedSnapshot = {
      ...snapshot,
      panes: snapshot.panes.map((pane, index) => index === 2 ? { ...pane, terminal_id: 'term-2-replaced' } : pane),
    };
    await writeFile(statePath, JSON.stringify({ result: { snapshot: changedSnapshot } }));
    assert.equal((await fetch(`${httpBase}/api/herdr/state`)).status, 200);
    await waitUntil(() => runtime.terminalGrid.sessions.size === 0);
    assert.equal(runtime.terminalGrid.sessions.size, 0, 'a verified terminal replacement should detach only its stale proxy');
    await reader.cancel();
    face.close();

    assert.equal(
      selectCubeFaces({
        result: {
          snapshot: {
            ...snapshot,
            tabs: [...snapshot.tabs, { tab_id: 'w9:notes', workspace_id: 'w9', label: 'Notes' }],
          },
        },
      }).length,
      6,
      'unrelated tabs should not prevent the six named cube faces from attaching',
    );
    assert.deepEqual(
      cubeSetupPlan({ result: { snapshot: { workspaces: [], tabs: [] } } }),
      { workspaceId: null, renameTabId: null, createFaces: [1, 2, 3, 4, 5, 6] },
      'a missing cube workspace should be provisioned instead of requiring setup instructions',
    );
    assert.deepEqual(
      cubeSetupPlan({
        result: {
          snapshot: {
            workspaces: [{ workspace_id: 'fresh', label: 'Coding Cube' }],
            tabs: [{ tab_id: 'fresh:t1', workspace_id: 'fresh', label: '1' }],
          },
        },
      }),
      { workspaceId: 'fresh', renameTabId: 'fresh:t1', createFaces: [1, 2, 3, 4, 5, 6] },
      'a pristine Herdr workspace should reuse its first tab rather than leave junk behind',
    );
    assert.throws(
      () => selectCubeFaces({ result: { snapshot: { ...snapshot, workspaces: [] } } }),
      /expected exactly one HerdR workspace/,
      'missing identity must fail closed instead of creating replacement sessions',
    );
  } finally {
    await runtime?.stop();
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => eventServer.close(resolve));
    if (previousSocket === undefined) delete process.env.CODING_CUBE_TEST_HERDR_SOCKET;
    else process.env.CODING_CUBE_TEST_HERDR_SOCKET = previousSocket;
    if (previousState === undefined) delete process.env.CODING_CUBE_TEST_HERDR_STATE;
    else process.env.CODING_CUBE_TEST_HERDR_STATE = previousState;
    await rm(directory, { recursive: true, force: true });
  }
}

function checkTwoInputSpace() {
  const previousDocument = globalThis.document;
  const previousMatchMedia = globalThis.matchMedia;
  const previousWindow = globalThis.window;
  const listeners = new Map();
  const classes = classList();
  const panelClasses = classList();
  const panel = {
    dataset: { face: '0' },
    classList: panelClasses,
    addEventListener() {},
  };
  const terminal = {};
  const target = {
    closest(selector) {
      if (selector === '.terminal-surface') return terminal;
      if (selector === '.panel') return panel;
      if (selector === '.panel.is-focused .terminal-surface') return panelClasses.contains('is-focused') ? terminal : null;
      return null;
    },
  };
  const linkTarget = {
    closest(selector) {
      return selector === 'a, button, input, select, textarea' ? {} : null;
    },
  };
  let pointerCaptures = 0;
  let releases = 0;
  globalThis.document = {
    hidden: false,
    hasFocus: () => true,
    body: { classList: classes },
    addEventListener() {},
  };
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.window = { addEventListener() {} };

  try {
    const space = new SpaceController({
      viewport: {
        addEventListener(type, listener) { listeners.set(type, listener); },
        setPointerCapture() { pointerCaptures += 1; },
      },
      rig: {
        classList: classes,
        querySelectorAll: () => [panel],
        style: { setProperty() {}, transition: '' },
      },
      onRelease() { releases += 1; },
    });
    space.bind();
    space.setZeroGravity(false);
    const initialY = space.rotation.y;

    assert.equal(space.dragInput({ type: 'start', id: 'hand-left', x: 0, y: 0, time: 0 }), true);
    assert.equal(space.dragInput({ type: 'start', id: 'hand-right', x: 100, y: 0, time: 10 }), true);
    space.dragInput({ type: 'move', id: 'hand-right', x: 120, y: 0, time: 20 });
    assert.ok(Math.abs(space.zoom - 1.2) < 1e-12, 'two-hand span should scale the existing zoom');
    assert.ok(Math.abs(space.rotation.y - initialY - 2.8) < 1e-12, 'two-hand midpoint should use the existing orbit math');

    space.dragInput({ type: 'end', id: 'hand-left', time: 30 });
    assert.equal(space.drag.id, 'hand-right', 'the remaining hand should continue without a jump');
    space.dragInput({ type: 'move', id: 'hand-right', x: 130, y: 0, time: 40 });
    assert.ok(Math.abs(space.rotation.y - initialY - 5.6) < 1e-12, 'one-hand orbit should resume after rebaselining');
    space.dragInput({ type: 'end', id: 'hand-right', time: 50 });
    assert.equal(space.drag, null);

    space.focus(0);
    panelClasses.remove('is-focused');
    const focusedZoom = space.zoom;
    assert.equal(focusedZoom, 1.08, 'focusing should reset oversized cube zoom so the terminal fits the viewport');
    let prevented = false;
    listeners.get('wheel')({ target, deltaY: 100, preventDefault() { prevented = true; } });
    assert.equal(space.zoom, focusedZoom, 'focused terminal state should own wheel input even when its DOM class is stale');
    assert.equal(prevented, false, 'focused wheel input should remain available to the terminal');

    listeners.get('pointerdown')({ target, pointerId: 1, clientX: 20, clientY: 20, timeStamp: 60 });
    assert.equal(space.drag, null, 'focused terminal state should own pointer input even when its DOM class is stale');
    assert.equal(pointerCaptures, 0, 'terminal pointer input should not be captured by the cube');

    listeners.get('pointerdown')({ target: linkTarget, pointerId: 2, clientX: 20, clientY: 20, timeStamp: 64 });
    assert.equal(pointerCaptures, 0, 'links inside the viewport should retain native click behavior');

    // Terminals are live whether or not a computer is attached, so a drag inside
    // a focused one selects text and never rotates the cube.
    classes.add('is-unpaired');
    listeners.get('pointerdown')({ target, pointerId: 2, clientX: 20, clientY: 20, timeStamp: 65 });
    assert.equal(pointerCaptures, 0, 'dragging inside a focused terminal should select text, not orbit');
    classes.remove('is-unpaired');

    space.dragInput({ type: 'start', id: 'hand-left', x: 0, y: 0, time: 70 });
    space.dragInput({ type: 'move', id: 'hand-left', x: 10, y: 0, time: 80 });
    assert.equal(space.focused, null, 'orbiting should release terminal focus');
    assert.equal(releases, 1, 'orbiting should use the shared focus release transition');
    space.dragInput({ type: 'cancel', id: 'hand-left', time: 90 });

    listeners.get('wheel')({ target, deltaY: 100, preventDefault() { prevented = true; } });
    assert.ok(space.zoom < focusedZoom, 'unfocused wheel input should still control cube depth');
    assert.equal(prevented, true, 'cube depth input should prevent page scrolling');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = previousMatchMedia;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function classList() {
  const classes = new Set();
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      if (force === undefined ? !classes.has(name) : force) classes.add(name);
      else classes.delete(name);
    },
  };
}

function trackedHand(name, dx = 0, dy = 0, scale = 1) {
  return {
    landmarks: handFixtures[name].map((point) => ({ ...point, x: point.x * scale + dx, y: point.y * scale + dy, z: point.z * scale })),
    worldLandmarks: handFixtures[name].map(({ x, y, z }) => ({ x: x * scale, y: y * scale, z: z * scale })),
  };
}

// fetch() will not let us forge a Host header, and forging one is exactly how a
// DNS-rebinding attack reaches a loopback server.
function rawRequest(host, port, headers, path) {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.write(`GET ${path} HTTP/1.1\r\n${lines}\r\nConnection: close\r\n\r\n`));
    let response = '';
    socket.setTimeout(4000, () => socket.destroy());
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('close', () => resolve(response));
    socket.on('error', reject);
  });
}

function rejectsWebSocketOrigin(wsBase) {
  const ws = new WebSocket(`${wsBase}/ws/pty?face=0&slot=0`, { headers: { origin: 'https://evil.example' } });
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      assert.equal(response.statusCode, 403, 'unconfigured sites must not open local terminals');
      response.resume();
      resolve();
    });
  });
}

function openPty(wsBase, face, slot) {
  const ws = new WebSocket(`${wsBase}/ws/pty?face=${face}&slot=${slot}`);
  let buffer = '';
  const waiters = new Set();

  ws.on('message', (raw, isBinary) => {
    buffer += isBinary ? '\nERROR:binary PTY output\n' : String(raw);
    for (const waiter of [...waiters]) waiter();
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout opening face ${face} slot ${slot}`)), 4000);
    ws.once('error', reject);
    ws.once('open', () => {
      clearTimeout(timeout);
      ws.send(sizeFrame(80, 24));
      resolve({
        input(data) {
          ws.send(data);
        },
        waitFor(needle, ms = 5000) {
          return waitForNeedle({ get buffer() { return buffer; }, waiters }, needle, ms);
        },
        close() {
          ws.close();
        },
      });
    });
  });
}

function sizeFrame(cols, rows) {
  const frame = Buffer.allocUnsafe(8);
  frame.write('CUBE', 0, 'ascii');
  frame.writeUInt16BE(cols, 4);
  frame.writeUInt16BE(rows, 6);
  return frame;
}

function rejectsInvalidResize(wsBase) {
  const ws = new WebSocket(`${wsBase}/ws/pty?face=5&slot=3`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('invalid resize frame was not rejected')), 4000);
    ws.once('error', reject);
    ws.once('open', () => ws.send(sizeFrame(10, 5)));
    ws.once('close', (code) => {
      clearTimeout(timeout);
      assert.equal(code, 1003, 'malformed resize frame should close the socket');
      resolve();
    });
  });
}

async function waitUntil(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

function waitForNeedle(state, needle, ms) {
  if (state.buffer.includes(needle)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.waiters.delete(check);
      reject(new Error(`timeout waiting for ${needle}; saw:\n${state.buffer}`));
    }, ms);

    const check = () => {
      if (!state.buffer.includes(needle)) return;
      clearTimeout(timeout);
      state.waiters.delete(check);
      resolve();
    };

    state.waiters.add(check);
  });
}
