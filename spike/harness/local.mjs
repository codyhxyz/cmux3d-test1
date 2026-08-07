#!/usr/bin/env node
// Phase 0 driver: everything the spike can prove about the container without
// spending a cent on AWS. It talks to a locally running image over plain HTTP
// and WebSocket, so a failure here is a container bug and nothing else.
//
//   node spike/harness/local.mjs                     # T-01..T-03, T-05, T-06, T-18
//   node spike/harness/local.mjs --after-restart     # T-01, T-02, T-04
//
// T-04 needs two runs against the same bind mount with a container restart in
// between: the first run records a baseline and plants a marker, the second one
// checks that both survived.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { selectCubeFaces } from '../../src/server/herdr-state.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const options = readOptions(process.argv.slice(2));
const results = [];

let state = null;
let derivedFaces = null;
let workspace = null;
let snapshotError = null;

await main();

async function main() {
  console.log(`local harness -> ${options.base}${options.afterRestart ? ' (after restart)' : ''}`);

  await test('T-01', 'gateway answers /ping', async () => {
    const startedAt = Date.now();
    const body = await until(() => ping(), options.bootTimeout, 250);
    if (!['Healthy', 'HealthyBusy'].includes(body.status)) throw new Error(`unexpected status ${body.status}`);
    if (!Number.isInteger(body.time_of_last_update)) throw new Error('time_of_last_update is not an integer');
    // Measured from harness start, so run this immediately after the container.
    return { msToFirstPing: Date.now() - startedAt, pingStatus: body.status };
  });

  await test('T-02', 'bootstrap reaches ready with six faces', async () => {
    state = await until(async () => {
      const body = await invoke({ op: 'state' });
      if (body.state !== 'ready') throw new Error(`state is ${body.state}`);
      return body;
    }, options.bootTimeout, 500);

    if (!Array.isArray(state.faces) || state.faces.length !== 6) throw new Error(`expected six faces, got ${state.faces?.length}`);
    const terminalIds = state.faces.map((face) => face.terminalId);
    if (new Set(terminalIds).size !== 6) throw new Error(`terminalIds are not distinct: ${terminalIds.join(', ')}`);

    derivedFaces = await describeFaces();
    return {
      snapshotError,
      elapsedMs: state.elapsedMs ?? null,
      phases: state.phases ?? state.boot?.phases ?? null,
      mount: state.mount ?? null,
      herdr: state.herdr ?? null,
      faces: derivedFaces,
    };
  });

  if (options.afterRestart) await checkRestore();
  else await checkFresh();

  await writeResults();
  const failed = results.filter((entry) => entry.status === 'fail');
  for (const entry of results) console.log(`${symbol(entry.status)} ${entry.id} ${entry.title}${entry.error ? ` — ${entry.error}` : ''}`);
  console.log(`results -> ${options.out}`);
  process.exit(failed.length ? 1 : 0);
}

async function checkFresh() {
  await test('T-03', 'six panes fan out and reflow', async () => {
    const panes = [];
    try {
      for (let face = 0; face < 6; face += 1) panes.push(await openPane(face));

      const identities = [];
      for (const pane of panes) {
        pane.type(`echo "CUBEID[$CODING_CUBE_FACE][$HERDR_PANE_ID]"\r`);
        const match = await pane.expect(/CUBEID\[(\d*)\]\[([^\]]*)\]/, options.paneTimeout);
        identities.push({ face: pane.face, env: match[1], paneId: match[2], route: pane.route });
      }

      // Under Herdr the pane shell is the server's child, so CODING_CUBE_FACE is
      // only set when the grid falls back to spawning a raw shell. Either one
      // proves the six connections landed in six different places.
      const byEnv = identities.every((entry) => entry.env === String(entry.face));
      const paneIds = identities.map((entry) => entry.paneId).filter(Boolean);
      const expected = (state.faces || []).map((face) => face.paneId);
      const byPane = paneIds.length === 6 && new Set(paneIds).size === 6
        && (!expected.length || paneIds.every((id, face) => id === expected[face]));
      if (!byEnv && !byPane) throw new Error(`faces are not distinct: ${JSON.stringify(identities)}`);

      // Planted for T-04 before the resize probes, not after: those probes scroll
      // the pane and force full repaints, and scraping a marker out of a screen
      // that is being redrawn underneath you is a coin flip.
      options.historyToken = `CUBEHIST-${randomUUID().slice(0, 8)}`;
      panes[0].type(`echo "${options.historyToken}"\r`);
      await panes[0].expect(new RegExp(`${options.historyToken}`), options.paneTimeout);

      // Reflow is measured as a reversible change, not as equality with the size we
      // sent. Two things make equality wrong: under Herdr the shell lives inside a
      // bordered pane, so `stty size` reports the terminal minus the TUI's chrome
      // (measured 90x28 inside a 100x30 socket), and the pane re-lays-out
      // asynchronously, so a single-shot read catches an intermediate size. Both
      // made a working reflow report FAIL.
      //
      // No space in the markers on purpose either: Herdr repaints with absolute
      // cursor moves and emits a jump instead of blank cells, so "30 100" arrives
      // as "30" ESC[7;13H "100" and no regexp over the raw stream can see it.
      const settledSize = async (label, cols, rows) => {
        panes[0].resize(cols, rows);
        let previous = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await sleep(400);
          const marker = `${label}${attempt}`;
          panes[0].type(`echo "${marker}[$(stty size | tr ' ' 'x')]"\r`);
          const match = await panes[0].expect(new RegExp(`${marker}\\[(\\d+)x(\\d+)\\]`), options.paneTimeout);
          const size = { rows: Number(match[1]), cols: Number(match[2]) };
          if (previous && previous.rows === size.rows && previous.cols === size.cols) return size;
          previous = size;
        }
        return previous;
      };
      const small = await settledSize('CUBESIZEA', 100, 30);
      const large = await settledSize('CUBESIZEB', 120, 40);
      // Growth in both dimensions is the assertion. A pane that ignores the resize
      // frame reports the same size twice, which is the regression worth catching.
      if (!(large.cols > small.cols && large.rows > small.rows)) {
        throw new Error(`pane did not grow with the terminal: ${JSON.stringify(small)} -> ${JSON.stringify(large)}`);
      }
      const chrome = { rows: 30 - small.rows, cols: 100 - small.cols };

      return { route: panes[0].route, identities, reflow: { small, large, chrome }, historyToken: options.historyToken };
    } finally {
      for (const pane of panes) pane.close();
    }
  });

  await test('T-05', 'busy health suppresses idle shutdown', async () => {
    const hold = await checkHold();
    const agent = await checkAgentBusy();
    return { status: agent.observed ? 'pass' : 'partial', hold, agent };
  });

  await test('T-06', 'does Herdr rename over session.json', async () => {
    if (!workspace) throw new Error('no Coding Cube workspace id; T-02 must pass first');
    const home = (await run('printf %s "$HOME"')).stdout.trim() || '/home/cube';
    const target = options.sessionJson || `${home}/.config/herdr/session.json`;
    const before = await inode(target);

    const created = JSON.parse((await run(
      `${options.herdr} --session default tab create --workspace ${workspace} --cwd ${home} --label cube-t06 --no-focus`,
    )).stdout);
    const tabId = created.result.tab.tab_id;
    try {
      await run(`${options.herdr} --session default tab rename ${tabId} cube-t06-renamed`);
      await sleep(2000);
    } finally {
      await run(`${options.herdr} --session default tab close ${tabId}`).catch(() => null);
    }

    const after = await inode(target);
    const renamed = before !== after;
    return {
      path: target,
      inodeBefore: before,
      inodeAfter: after,
      verdict: renamed
        ? 'rename-over: a file symlink into the mount would be replaced, keep the sync loop'
        : 'written in place: these four files could be promoted to symlinks',
    };
  });

  await test('T-18', 'image fits the 2 GB cap', async () => {
    let stdout;
    try {
      ({ stdout } = await execFileAsync('finch', ['images', '--format', '{{.Size}}', options.image]));
    } catch (error) {
      return { status: 'skip', detail: `finch unavailable: ${error.message}` };
    }
    const size = stdout.trim().split('\n').filter(Boolean).at(-1);
    if (!size) return { status: 'skip', detail: `no such image: ${options.image}` };
    const bytes = parseSize(size);
    if (bytes && bytes > options.sizeBudget) throw new Error(`${size} exceeds the ${options.sizeBudget} byte budget`);
    return { image: options.image, size, bytes };
  });

  await writeBaseline();
}

async function checkRestore() {
  await test('T-04', 'faces and pane history survive a restart', async () => {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
    } catch (error) {
      throw new Error(`no baseline at ${options.baseline}; run without --after-restart first (${error.message})`);
    }

    // Without a snapshot every field this test compares is null on both sides, and
    // "nothing drifted" would mean "nothing was read".
    if (snapshotError) throw new Error(`herdr snapshot failed, so restoration is unmeasured: ${snapshotError}`);
    if (baseline.snapshotError) throw new Error(`the baseline was recorded without a herdr snapshot (${baseline.snapshotError}); re-record it before restarting`);

    const drift = [];
    for (const face of baseline.faces) {
      const now = derivedFaces.find((entry) => entry.face === face.face);
      if (!now) drift.push({ face: face.face, missing: true });
      else if (now.label !== face.label) drift.push({ face: face.face, label: [face.label, now.label] });
      else if (now.cwd !== face.cwd) drift.push({ face: face.face, cwd: [face.cwd, now.cwd] });
    }
    if (drift.length) throw new Error(`faces drifted: ${JSON.stringify(drift)}`);

    // Terminal ids are minted fresh by every Herdr server, so a match here would
    // mean the server never actually restarted.
    const reused = derivedFaces.filter((entry) => baseline.faces.some((face) => face.terminalId === entry.terminalId));

    // This test used to require the PRE-restart marker to replay, which asserted a
    // capability herdr 0.8.0 does not have. Measured three independent ways on the
    // live container: nothing on disk holds pane content (session.json is 2.4 KB of
    // layout, cwd and ids — no scrollback, and no other herdr file is big enough);
    // a marker planted before a reattach IS replayed within one server lifetime
    // (escape-stripped match, 47 KB repaint); the same marker is gone after the
    // container is replaced. experimental.pane_history buys replay-on-reattach, not
    // durability across a herdr restart, and an eviction restarts herdr.
    //
    // So assert the capability that exists and would be a real regression if it
    // broke — replay-on-reattach in the NEW server — and record the cross-restart
    // loss as the measured platform limit it is. Browser-local scrollback in
    // public/app/transport.js is what actually gives the user their screen back.
    const priorMarker = { token: baseline.historyToken ?? null, survivedRestart: false, replayBytes: 0 };
    if (baseline.historyToken) {
      const pane = await openPane(0);
      try {
        await sleep(2000);
        priorMarker.replayBytes = pane.read().length;
        priorMarker.survivedRestart = Boolean(await pane
          .expect(new RegExp(baseline.historyToken), options.paneTimeout)
          .catch(() => null));
      } finally {
        pane.close();
      }
    }

    // Plant, detach, reattach — all inside the post-restart server.
    // The settle is load-bearing, not superstition: the grid answers the WebSocket
    // as soon as it spawns `herdr terminal attach`, but that process needs a moment
    // to reach the pane, and anything written before it does is swallowed. Measured
    // on this container across four delays — 0 ms drops the keystrokes outright,
    // 500/1000/2000 ms all echo.
    const token = `CUBEREPLAY-${randomUUID().slice(0, 8)}`;
    const writer = await openPane(0);
    try {
      await sleep(1500);
      writer.type(`echo "${token}"\r`);
      await writer.expect(new RegExp(token), options.paneTimeout);
    } finally {
      writer.close();
    }
    await sleep(1000);
    const reader = await openPane(0);
    let replayed = false;
    let replayBytes = 0;
    try {
      await sleep(2000);
      replayBytes = reader.read().length;
      replayed = Boolean(await reader.expect(new RegExp(token), options.paneTimeout).catch(() => null));
    } finally {
      reader.close();
    }
    if (!replayed) {
      throw new Error(replayBytes > 0
        ? `the restarted server replayed ${replayBytes} bytes on reattach but not ${token} — pane replay is broken, check experimental.pane_history in herdr-config.toml`
        : 'the restarted server replayed nothing at all on reattach; check experimental.pane_history in herdr-config.toml');
    }

    return {
      faces: derivedFaces,
      reusedTerminalIds: reused.map((entry) => entry.face),
      replayOnReattach: { token, replayed, replayBytes },
      priorMarker,
      note: priorMarker.token && !priorMarker.survivedRestart
        ? 'expected: herdr keeps pane content in memory, so a restart blanks every screen. Cross-restart scrollback is the browser store in public/app/transport.js.'
        : undefined,
    };
  });
}

async function checkHold() {
  const seconds = 8;
  await invoke({ op: 'hold', seconds });
  const busy = [];
  for (let at = 0; at < 5; at += 1) {
    busy.push(await ping());
    await sleep(1000);
  }
  if (!busy.every((body) => body.status === 'HealthyBusy')) throw new Error(`hold did not report HealthyBusy: ${busy.map((b) => b.status).join(',')}`);
  const stamps = [...new Set(busy.map((body) => body.time_of_last_update))];
  // A timestamp that advances on every ping suppresses the idle timeout forever.
  if (stamps.length !== 1) throw new Error(`time_of_last_update advanced within one status run: ${stamps.join(',')}`);

  const idle = await until(async () => {
    const body = await ping();
    if (body.status !== 'Healthy') throw new Error(`still ${body.status}`);
    return body;
  }, seconds * 1000 + 15_000, 500);
  if (idle.time_of_last_update <= stamps[0]) throw new Error('time_of_last_update did not move on the flip back to Healthy');
  return { seconds, busyStamp: stamps[0], idleStamp: idle.time_of_last_update };
}

async function checkAgentBusy() {
  const pane = await openPane(0);
  const startedAt = Date.now();
  try {
    pane.type(`${options.agentCmd}\r`);
    const seen = [];
    while (Date.now() - startedAt < options.agentTimeout) {
      const body = await ping();
      seen.push(body.status);
      if (body.status === 'HealthyBusy') return { observed: true, command: options.agentCmd, afterMs: Date.now() - startedAt };
      await sleep(1000);
    }
    return {
      observed: false,
      command: options.agentCmd,
      note: 'never flipped to HealthyBusy; the agent is probably not authenticated inside the container',
      seen: [...new Set(seen)],
    };
  } finally {
    pane.type('\x03');
    await sleep(250);
    pane.close();
  }
}

async function describeFaces() {
  let envelope;
  snapshotError = null;
  try {
    envelope = await invoke({ op: 'snapshot' });
  } catch (error) {
    // Recorded, not swallowed: labels and cwds come only from the snapshot, so a
    // failure here means T-04 would compare null against null and call it a pass.
    snapshotError = error.message;
    return (state.faces || []).map((face) => ({ ...face, cwd: null }));
  }
  const cube = selectCubeFaces(envelope);
  workspace = cube[0]?.workspace.workspace_id || null;
  return cube.map(({ face, tab, pane }) => ({
    face,
    label: tab.label,
    cwd: pane.cwd ?? pane.foreground_cwd ?? null,
    tabId: tab.tab_id,
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    agentStatus: pane.agent_status ?? null,
  }));
}

// The passthrough mount path is exactly /ws, but a container built before that
// change only answers /ws/pty. Try both so the harness reports which one worked.
async function openPane(face, slot = 0) {
  const base = options.base.replace(/^http/, 'ws');
  const routes = [
    { route: '/ws', url: `${base}/ws`, hello: JSON.stringify({ face, slot }) },
    { route: '/ws/pty', url: `${base}/ws/pty?face=${face}&slot=${slot}`, hello: null },
  ];

  let last;
  for (const candidate of routes) {
    try {
      return await connectPane(face, candidate);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`no pane route worked for face ${face}: ${last?.message}`);
}

function connectPane(face, { route, url, hello }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let output = '';
    const fail = (message) => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail(`timed out opening ${route}`), options.paneTimeout);

    ws.on('unexpected-response', (_req, res) => fail(`${route} responded ${res.statusCode}`));
    ws.on('error', (error) => fail(`${route}: ${error.message}`));
    ws.on('message', (data, isBinary) => {
      output += isBinary ? data.toString('latin1') : data.toString();
    });
    ws.on('open', () => {
      clearTimeout(timer);
      if (hello) ws.send(hello);
      resolve({
        face,
        route,
        type: (text) => ws.send(text),
        resize: (cols, rows) => ws.send(resizeFrame(cols, rows)),
        read: () => output,
        screen: () => renderScreen(output),
        expect: (pattern, timeoutMs) => until(() => {
          // Raw first (cheapest), then escapes stripped, then the reconstructed
          // screen — which is the only one that survives a differential repaint.
          const match = output.match(pattern) ?? plainText(output).match(pattern) ?? renderScreen(output).match(pattern);
          if (!match) throw new Error(`no match for ${pattern}`);
          return match;
        }, timeoutMs, 100),
        close: () => ws.close(),
      });
    });
  });
}

// OSC (title, hyperlinks), CSI (colour, cursor moves) and two-byte escapes. Herdr
// emits all three around every marker a pane test writes.
function plainText(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

// Herdr paints panes differentially: a cell that already holds the right character
// is skipped with a cursor move rather than rewritten. So the literal a test echoed
// is frequently never sent as contiguous bytes — measured, "CUBEHIST-deadbeef"
// arrived as "CUBEHIST-deadeef" because the 'b' was already on screen from the
// previous run's token. Substring matching over the byte stream therefore reports
// failures that never happened, and stripping the escapes only glues the surviving
// runs closer together. Replaying the stream onto a virtual screen and reading the
// resulting rows is the only honest way to scrape a TUI.
function renderScreen(stream, size = { rows: 120, cols: 300 }) {
  const blank = () => new Array(size.cols).fill(' ');
  const grid = Array.from({ length: size.rows }, blank);
  let row = 0;
  let col = 0;

  const scroll = () => {
    grid.shift();
    grid.push(blank());
    row = size.rows - 1;
  };
  const put = (char) => {
    if (col >= size.cols) {
      col = 0;
      row += 1;
    }
    if (row >= size.rows) scroll();
    grid[row][col] = char;
    col += 1;
  };
  const eraseLine = (mode) => {
    const from = mode === 1 ? 0 : mode === 2 ? 0 : col;
    const to = mode === 1 ? col + 1 : size.cols;
    for (let at = from; at < to && at < size.cols; at += 1) grid[row][at] = ' ';
  };
  const eraseDisplay = (mode) => {
    if (mode === 2 || mode === 3) {
      for (let at = 0; at < size.rows; at += 1) grid[at] = blank();
      return;
    }
    eraseLine(mode);
    const from = mode === 1 ? 0 : row + 1;
    const to = mode === 1 ? row : size.rows;
    for (let at = from; at < to; at += 1) grid[at] = blank();
  };

  for (let at = 0; at < stream.length; at += 1) {
    const char = stream[at];
    if (char === '\x1b') {
      const rest = stream.slice(at, at + 64);
      const csi = /^\x1b\[([0-9;?]*)[ -/]*([@-~])/.exec(rest);
      if (csi) {
        const params = csi[1].split(';').map((value) => (value === '' ? null : Number(value)));
        const [first, second] = params;
        const final = csi[2];
        if (final === 'H' || final === 'f') {
          row = (first ?? 1) - 1;
          col = (second ?? 1) - 1;
        } else if (final === 'A') row -= first ?? 1;
        else if (final === 'B') row += first ?? 1;
        else if (final === 'C') col += first ?? 1;
        else if (final === 'D') col -= first ?? 1;
        else if (final === 'G') col = (first ?? 1) - 1;
        else if (final === 'd') row = (first ?? 1) - 1;
        row = Math.max(0, Math.min(size.rows - 1, row));
        col = Math.max(0, Math.min(size.cols - 1, col));
        if (final === 'J') eraseDisplay(first ?? 0);
        else if (final === 'K') eraseLine(first ?? 0);
        at += csi[0].length - 1;
        continue;
      }
      // OSC runs to BEL or ST; anything else is a two-byte escape.
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      at += osc ? osc[0].length - 1 : 1;
      continue;
    }
    if (char === '\r') col = 0;
    else if (char === '\n') {
      row += 1;
      if (row >= size.rows) scroll();
    } else if (char === '\b') col = Math.max(0, col - 1);
    else if (char === '\t') col = Math.min(size.cols - 1, (Math.floor(col / 8) + 1) * 8);
    else if (char >= ' ') put(char);
  }
  return grid.map((line) => line.join('').replace(/\s+$/, '')).join('\n');
}

function resizeFrame(cols, rows) {
  const frame = Buffer.alloc(8);
  frame.write('CUBE', 0, 'ascii');
  frame.writeUInt16BE(cols, 4);
  frame.writeUInt16BE(rows, 6);
  return frame;
}

async function ping() {
  const response = await fetch(`${options.base}/ping`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`/ping responded ${response.status}`);
  return response.json();
}

async function invoke(body) {
  const response = await fetch(`${options.base}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.invokeTimeout),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`/invocations ${body.op} responded ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function run(cmd) {
  const result = await invoke({ op: 'exec', cmd });
  if (result.code) throw new Error(`exec failed (${result.code}): ${cmd}\n${result.stderr || ''}`);
  return result;
}

async function inode(target) {
  const { stdout } = await run(`ls -li "${target}"`);
  return stdout.trim().split(/\s+/)[0];
}

async function test(id, title, body) {
  if (!options.only.has(id) && options.only.size) return;
  if (options.skip.has(id)) {
    results.push({ id, title, status: 'skip', detail: 'skipped by flag' });
    return;
  }
  const startedAt = Date.now();
  try {
    const detail = await body();
    results.push({ id, title, ms: Date.now() - startedAt, status: 'pass', ...detail });
  } catch (error) {
    results.push({ id, title, ms: Date.now() - startedAt, status: 'fail', error: error.message });
  }
}

async function until(body, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      return await body();
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) throw last;
    await sleep(intervalMs);
  }
}

async function writeBaseline() {
  if (!derivedFaces) return;
  await mkdir(path.dirname(options.baseline), { recursive: true });
  await writeFile(options.baseline, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    base: options.base,
    // Carried so the --after-restart run can refuse to compare against a baseline
    // that was itself recorded blind.
    snapshotError,
    historyToken: options.historyToken || null,
    faces: derivedFaces,
  }, null, 2)}\n`);
  console.log(`baseline -> ${options.baseline}`);
}

async function writeResults() {
  await mkdir(path.dirname(options.out), { recursive: true });
  await writeFile(options.out, `${JSON.stringify({
    startedAt: new Date().toISOString(),
    base: options.base,
    phase: options.afterRestart ? 'after-restart' : 'fresh',
    tests: results,
  }, null, 2)}\n`);
}

function parseSize(text) {
  const match = text.match(/^([\d.]+)\s*([kKmMgG]?i?)B?$/);
  if (!match) return null;
  const scale = { '': 1, k: 1e3, ki: 1024, m: 1e6, mi: 1024 ** 2, g: 1e9, gi: 1024 ** 3 };
  return Math.round(Number(match[1]) * (scale[match[2].toLowerCase()] ?? 1));
}

function symbol(status) {
  return { pass: 'ok  ', fail: 'FAIL', skip: 'skip', partial: 'part' }[status] || status;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readOptions(argv) {
  const flags = new Map();
  for (let at = 0; at < argv.length; at += 1) {
    const [name, inline] = argv[at].replace(/^--/, '').split('=');
    if (inline !== undefined) flags.set(name, inline);
    else if (argv[at + 1] && !argv[at + 1].startsWith('--')) flags.set(name, argv[at += 1]);
    else flags.set(name, 'true');
  }
  const list = (name) => new Set((flags.get(name) || '').split(',').filter(Boolean));
  return {
    base: (flags.get('base') || 'http://127.0.0.1:8080').replace(/\/$/, ''),
    out: path.resolve(flags.get('out') || path.join(here, 'results-local.json')),
    baseline: path.resolve(flags.get('baseline') || path.join(here, 'local-baseline.json')),
    afterRestart: flags.has('after-restart'),
    only: list('only'),
    skip: list('skip'),
    image: flags.get('image') || 'coding-cube-spike:dev',
    herdr: flags.get('herdr') || '/usr/local/bin/herdr',
    sessionJson: flags.get('session-json') || '',
    agentCmd: flags.get('agent-cmd') || 'claude',
    bootTimeout: Number(flags.get('boot-timeout') || 180_000),
    paneTimeout: Number(flags.get('pane-timeout') || 15_000),
    invokeTimeout: Number(flags.get('invoke-timeout') || 200_000),
    agentTimeout: Number(flags.get('agent-timeout') || 45_000),
    sizeBudget: Number(flags.get('size-budget') || 1_800_000_000),
    historyToken: '',
  };
}
