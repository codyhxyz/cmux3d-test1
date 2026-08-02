import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { HandController, handSample } from '../public/app/hand-tracking.js';
import { herdrMetadata } from '../public/app/herdr.js';
import { accessoryKeyInput, commandKeyInput, commandPromptDirection, ctrlCode, promptLine } from '../public/app/terminal-keys.js';
import { mixedContentBlocked, normalizeHostOrigin, pairingUrl, parseFragment } from '../public/app/connection-config.js';
import { encodeQr } from '../public/app/qr.js';
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
import { readServerOptions } from '../src/server/config.js';
import { selectCubeFaces } from '../src/server/herdr-state.js';
import { browserOriginAllowed } from '../src/server/origin.js';
import { createRuntime } from '../src/server/runtime.js';
import { parseServeStatus, parseStatus, supportsServeBackground } from '../src/server/tailscale.js';
import { loadOrCreateToken, rotateToken } from '../src/server/token-store.js';

await checkHerdrStateEndpoint();

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

const tokenDir = await mkdtemp(path.join(os.tmpdir(), 'cmux3d-token-'));
const tokenEnv = { CMUX3D_STATE_DIR: tokenDir };
assert.equal(readServerOptions(tokenEnv, []).herdr, null, 'a clean install should start ordinary shells without Herdr setup');
assert.equal(readServerOptions({ ...tokenEnv, CMUX3D_HERDR: 'herdr' }, []).herdr, 'herdr', 'Herdr attachment should remain an explicit option');
assert.equal(readServerOptions(tokenEnv, []).expose, false, 'exposing the cube to a tailnet should stay opt-in');
assert.equal(readServerOptions(tokenEnv, ['--expose']).expose, true, '--expose should opt in to tailnet exposure');
const firstToken = loadOrCreateToken(tokenEnv);
assert.equal(loadOrCreateToken(tokenEnv), firstToken, 'pairing should survive a restart so phones stay paired');
assert.equal((await stat(path.join(tokenDir, 'token'))).mode & 0o777, 0o600, 'the pairing code should not be world readable');
assert.notEqual(rotateToken(tokenEnv), firstToken, 'rotating should invalidate the old pairing code');
assert.equal(readServerOptions({ ...tokenEnv, CMUX3D_TOKEN: 'from-env' }, []).token, 'from-env', 'an explicit token should win over the stored one');
await rm(tokenDir, { recursive: true, force: true });

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
assert.equal(supportsServeBackground([1, 56]), true, 'tailscale 1.56 introduced the background serve flag');
assert.equal(supportsServeBackground([1, 40]), false, 'older tailscale needs the manual serve command');

const pairingQr = encodeQr(pairingUrl('https://codingcube.codyh.xyz', 'https://mymac.tail47c266.ts.net', 'K'.repeat(32)));
assert.equal((pairingQr.size - 17) % 4, 0, 'a QR symbol should have a valid version size');
assert.equal(pairingQr.modules[0].slice(0, 7).join(''), '1111111', 'the finder pattern should anchor the symbol');
// Versions 7 and up need the version block, which a real pairing link reaches.
assert.ok(pairingQr.size >= 45, 'a full pairing link should need a version 7 or larger symbol');

assert.deepEqual(
  herdrMetadata({
    result: {
      snapshot: {
        focused_workspace_id: 'w2',
        focused_tab_id: 'w2:t2',
        focused_pane_id: 'w2:p2',
        workspaces: [{ workspace_id: 'w2', label: 'cmux3d', agent_status: 'idle' }],
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
const runtime = createRuntime({ host: '127.0.0.1', port: 0, shell: '/bin/sh', webOrigin, token });

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
  assert.match(homeSource, /CMUX3D/, 'index should contain the app shell');
  assert.match(homeSource, /momentum-duration/, 'settings should expose the momentum slider');
  assert.match(homeSource, /zero-gravity/, 'settings should expose the zero-gravity toggle');
  assert.match(homeSource, /hand-control/, 'settings should expose the opt-in hand control');
  assert.match(homeSource, /No computer connected/, 'an unpaired cube should say what is missing');
  assert.match(homeSource, /id="connect-panel" popover/, 'the connect flow should be light-dismiss, never a blocking gate');
  assert.match(homeSource, /id="connect-host"[^>]*placeholder="mymac\.tailnet\.ts\.net"/, 'the connect form should ask for a computer address');
  assert.match(homeSource, /id="connect-token"/, 'the connect form should ask for a pairing code');
  assert.match(homeSource, /id="key-row"/, 'phones need keys a soft keyboard cannot produce');
  assert.match(homeSource, /data-key="ctrl"[^>]*aria-pressed/, 'the sticky ctrl key should report its armed state');
  assert.match(homeSource, /rel="manifest" href="\/manifest\.webmanifest"/, 'the cube should be installable on a phone');
  assert.match(homeSource, /id="desktop-shells" href="http:\/\/127\.0\.0\.1:8064\/"/, 'the desktop-shells action should open the local workspace');
  assert.match(homeSource, /viewport-fit=cover/, 'mobile layout should respect device safe areas');
  assert.doesNotMatch(homeSource, /<dialog|companion-gate/, 'a missing host must not block the cube with a menu');
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
  assert.match(terminalSource, /entry\.ws = null;\s*ws\.close\(\)/, 'an inactive browser should release terminal sizing back to Ghostty');
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
  assert.match(mainSource, /AbortSignal\.timeout\(3000\)/, 'an unreachable host should stop background pairing quickly');
  assert.match(mainSource, /function setConnectionState\(/, 'the UI should track one connection state rather than a preview flag');
  assert.match(mainSource, /desktopShells\.href = hostHttp\('\/'\)/, 'desktop shells should use the shared host URL');
  assert.match(mainSource, /if \(active\) connectHost\(\)/, 'returning to the tab should re-check the host');
  assert.match(mainSource, /if \(!isPageActive\(\)\) return;/, 'sockets closed by backgrounding must not read as a lost host');
  assert.doesNotMatch(mainSource, /companion|showModal/i, 'connection failure should never open a blocking gate');
  assert.doesNotMatch(mainSource, /setInterval/, 'HerdR state should not be polled');

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

  slot0.input('CMUX3D_PROBE=alpha; printf "probe:%s:%s:%s\\n" "$CMUX3D_FACE" "$CMUX3D_SLOT" "$CMUX3D_PROBE"\r');
  await slot0.waitFor('probe:0:0:alpha');
  const replay = await openPty(wsBase, 0, 0);
  await replay.waitFor('probe:0:0:alpha');

  slot1.input('printf "probe:%s:%s:%s\\n" "$CMUX3D_FACE" "$CMUX3D_SLOT" "${CMUX3D_PROBE-empty}"\r');
  await slot1.waitFor('probe:0:1:empty');

  face4.input('printf "probe:%s:%s\\n" "$CMUX3D_FACE" "$CMUX3D_SLOT"\r');
  await face4.waitFor('probe:4:2');

  await rejectsInvalidResize(wsBase);

  slot0.close();
  replay.close();
  slot1.close();
  face4.close();
  await waitUntil(() => runtime.terminalGrid.sessions.size === 0);
  assert.equal(runtime.terminalGrid.sessions.size, 0, 'closing the last browser client should detach its proxy');
  console.log('smoke ok');
} finally {
  await runtime.stop();
}

async function checkHerdrStateEndpoint() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmux3d-herdr-'));
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

  const previousSocket = process.env.CMUX3D_TEST_HERDR_SOCKET;
  const previousState = process.env.CMUX3D_TEST_HERDR_STATE;
  process.env.CMUX3D_TEST_HERDR_SOCKET = socketPath;
  process.env.CMUX3D_TEST_HERDR_STATE = statePath;
  let runtime;

  try {
    await writeFile(statePath, JSON.stringify({ result: { snapshot } }));
    await writeFile(executable, `#!/bin/sh
if [ "$1:$2:$3:$4" = "--session:default:status:server" ]; then
  printf 'status: running\\nsocket: %s\\n' "$CMUX3D_TEST_HERDR_SOCKET"
elif [ "$1:$2:$3:$4" = "--session:default:api:snapshot" ]; then
  cat "$CMUX3D_TEST_HERDR_STATE"
elif [ "$1:$2:$3:$4" = "--session:default:terminal:attach" ]; then
  printf 'attached:%s\\n' "$5"
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
    await face.waitFor('attached:term-2');
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
    assert.throws(
      () => selectCubeFaces({ result: { snapshot: { ...snapshot, workspaces: [] } } }),
      /expected exactly one HerdR workspace/,
      'missing identity must fail closed instead of creating replacement sessions',
    );
  } finally {
    await runtime?.stop();
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => eventServer.close(resolve));
    if (previousSocket === undefined) delete process.env.CMUX3D_TEST_HERDR_SOCKET;
    else process.env.CMUX3D_TEST_HERDR_SOCKET = previousSocket;
    if (previousState === undefined) delete process.env.CMUX3D_TEST_HERDR_STATE;
    else process.env.CMUX3D_TEST_HERDR_STATE = previousState;
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

    classes.add('is-unpaired');
    listeners.get('pointerdown')({ target, pointerId: 2, clientX: 20, clientY: 20, timeStamp: 65 });
    assert.equal(pointerCaptures, 1, 'unpaired faces should remain draggable after they are focused');
    listeners.get('pointerup')({ type: 'pointerup', pointerId: 2, timeStamp: 66 });
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
  frame.write('CMUX', 0, 'ascii');
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
