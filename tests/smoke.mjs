import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { herdrMetadata } from '../public/app/herdr.js';
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
  STOP_SPEED,
} from '../public/app/space.js';
import { HERDR_SESSIONS } from '../src/server/herdr-state.js';
import { createRuntime } from '../src/server/runtime.js';

await checkHerdrStateEndpoint();

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

const runtime = createRuntime({ host: '127.0.0.1', port: 0, shell: '/bin/sh' });

try {
  const { host, port } = await runtime.start();
  const httpBase = `http://${host}:${port}`;
  const wsBase = `ws://${host}:${port}`;

  const home = await fetch(`${httpBase}/`);
  assert.equal(home.status, 200, 'index should be served');
  const homeSource = await home.text();
  assert.match(homeSource, /CMUX3D/, 'index should contain the app shell');
  assert.match(homeSource, /momentum-duration/, 'settings should expose the momentum slider');
  assert.match(homeSource, /zero-gravity/, 'settings should expose the zero-gravity toggle');

  const script = await fetch(`${httpBase}/app/terminals.js`);
  assert.equal(script.status, 200, 'terminal client should be served');
  const terminalSource = await script.text();
  assert.match(terminalSource, /AttachAddon/, 'official attach addon should be used');
  assert.match(terminalSource, /WebglAddon/, 'official WebGL addon should be used');

  const main = await fetch(`${httpBase}/app/main.js`);
  assert.equal(main.status, 200, 'main client should be served');
  const mainSource = await main.text();
  assert.match(mainSource, /new EventSource\('\/api\/herdr\/events'\)/, 'the UI should subscribe to HerdR events');
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
  console.log('smoke ok');
} finally {
  await runtime.stop();
}

async function checkHerdrStateEndpoint() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cmux3d-herdr-'));
  const executable = path.join(directory, 'herdr');
  const socketPath = path.join(directory, 'herdr.sock');
  const clients = new Set();
  const eventServer = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('data', (raw) => {
      const request = JSON.parse(String(raw).trim());
      assert.equal(request.method, 'events.subscribe');
      assert.ok(request.params.subscriptions.some(({ type }) => type === 'tab.renamed'));
      assert.ok(request.params.subscriptions.some(({ type }) => type === 'pane.agent_status_changed'));
      socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscription_started' } })}\n`);
    });
  });
  await new Promise((resolve, reject) => {
    eventServer.once('error', reject);
    eventServer.listen(socketPath, resolve);
  });

  const previousSocket = process.env.CMUX3D_TEST_HERDR_SOCKET;
  process.env.CMUX3D_TEST_HERDR_SOCKET = socketPath;
  const runtime = createRuntime({ host: '127.0.0.1', port: 0, herdr: executable });

  try {
    await writeFile(executable, `#!/bin/sh
if [ "$3" = "status" ]; then
  printf 'status: running\\nsocket: %s\\n' "$CMUX3D_TEST_HERDR_SOCKET"
else
  printf '{"result":{"snapshot":{"session":"%s","panes":[{"pane_id":"p1"}]}}}\\n' "$2"
fi
`);
    await chmod(executable, 0o755);
    const { host, port } = await runtime.start();
    const response = await fetch(`http://${host}:${port}/api/herdr/state`);
    assert.equal(response.status, 200, 'raw Herdr state should be exposed');
    const state = await response.json();
    assert.deepEqual(
      state.map(({ face, session, snapshot }) => ({ face, session, snapshot })),
      HERDR_SESSIONS.map((session, face) => ({
        face,
        session,
        snapshot: { result: { snapshot: { session, panes: [{ pane_id: 'p1' }] } } },
      })),
      'Herdr snapshots should pass through without derived status',
    );

    const events = await fetch(`http://${host}:${port}/api/herdr/events`);
    assert.equal(events.status, 200, 'HerdR event stream should be exposed');
    const reader = events.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: ready/, 'event stream should subscribe before bootstrapping state');
    assert.equal(clients.size, HERDR_SESSIONS.length, 'each face should subscribe to its HerdR session');
    clients.values().next().value.write('{"event":"tab_renamed","data":{}}\n');
    assert.match(new TextDecoder().decode((await reader.read()).value), /data: change/, 'HerdR events should invalidate UI state');
    await reader.cancel();
  } finally {
    await runtime.stop();
    for (const socket of clients) socket.destroy();
    await new Promise((resolve) => eventServer.close(resolve));
    if (previousSocket === undefined) delete process.env.CMUX3D_TEST_HERDR_SOCKET;
    else process.env.CMUX3D_TEST_HERDR_SOCKET = previousSocket;
    await rm(directory, { recursive: true, force: true });
  }
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
