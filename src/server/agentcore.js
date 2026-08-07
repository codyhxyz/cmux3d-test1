import { execFile, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createBusyTracker } from './busy.js';
import { paths } from './config.js';
import { cubePaneIds, DEFAULT_WORKSPACE, ensureCubeWorkspace, readHerdrState, watchHerdrState } from './herdr-state.js';
import { createRuntime } from './runtime.js';
import { createSessionStore, waitForMount } from './session-store.js';
import { chooseShell } from './shell.js';
import { setAgentCoreRoutes } from './static.js';

const execFileAsync = promisify(execFile);
const env = process.env;
const HOME = env.HOME || '/home/cube';
const MOUNT = env.CODING_CUBE_MOUNT || '/mnt/workspace';
const MOUNT_TIMEOUT_MS = Number(env.CODING_CUBE_MOUNT_TIMEOUT_MS || 30_000);
const HERDR = env.CODING_CUBE_HERDR && env.CODING_CUBE_HERDR !== '0' ? env.CODING_CUBE_HERDR : '/usr/local/bin/herdr';
const WORKSPACE = env.CODING_CUBE_WORKSPACE || DEFAULT_WORKSPACE;
const WORKDIR_OVERRIDE = env.CODING_CUBE_WORKDIR || null;
const SPIKE = env.CODING_CUBE_SPIKE === '1';
const ALLOW_EPHEMERAL = env.CODING_CUBE_ALLOW_EPHEMERAL === '1';
const FACE_COUNT = 6;
const HERDR_READY_TIMEOUT_MS = 30_000;
const RETRY_MS = 5000;
const MOUNT_WATCH_MS = Number(env.CODING_CUBE_MOUNT_WATCH_MS || 5000);
const SHELL_SAMPLE_MS = 1000;
// How long a dead herdr can go unnoticed if it dies without our child handle
// seeing it — an adopted server, or one killed with SIGKILL from a shell.
const HEALTH_MS = Number(env.CODING_CUBE_HEALTH_MS || 10_000);
// Measured on herdr 0.8.0: killing the shell behind a pane destroys the pane and
// its tab and emits NOTHING — not pane.closed, not tab.closed, even with both
// subscribed. The subscription types exist; the server does not broadcast them
// for this case. So the interval is the detector for an unattached face, not a
// backstop, and its period is how long /ping can judge a scope that has quietly
// lost a pane. One `herdr api snapshot` every 15 s is a cheap price for that.
const SWEEP_MS = Number(env.CODING_CUBE_SWEEP_MS || 15_000);
// Every reconcile is scheduled through one coalescing timer with this floor, so
// a herdr that crash-loops, or a burst of tab.closed events, costs one pass per
// window rather than one per signal.
const RECONCILE_MIN_MS = 3000;
const RECONCILE_BACKOFF_MAX_MS = 60_000;
// Events that mean the cube's own shape changed. pane.agent_detected and the
// rest are far too chatty to reconcile on.
const REPAIR_EVENTS = new Set(['tab_closed', 'pane_closed', 'workspace_closed']);

// Measured on the real linux/arm64 binary: herdr ignores HERDR_SOCKET_PATH
// whenever --session is passed, and every call in this repo passes it. The live
// socket is therefore always $HOME-derived, and honouring the variable would only
// point the gateway at a path the server never binds. Unset it so a stray value
// in the environment cannot make the gateway and a shell disagree either.
const SOCKET = path.join(HOME, '.config', 'herdr', 'herdr.sock');
process.env.HOME = HOME;
delete process.env.HERDR_SOCKET_PATH;

const store = createSessionStore({ home: HOME, mount: MOUNT, log: warn });
const busy = createBusyTracker({ runSnapshot: snapshot, log: warn });

let state = 'booting';
let phase = 'start';
let phases = [];
let faces = [];
let integrations = [];
let herdr = { executable: HERDR, version: null, socket: SOCKET, socketModes: {} };
let bootstrapPromise = null;
let bootStartedAt = Date.now();
let bootMs = 0;
let stopEvents = null;
let eventRetry = null;
let workdir = chooseWorkdir('ephemeral');
let persistence = 'unknown';
let mountWatch = null;
let socketWatcher = null;
let opening = null;
let adopting = false;
let mountAdoptions = 0;
let lastMountCheckAt = 0;
let herdrChild = null;
let reconciling = null;
let reconcileTimer = null;
let reconcileBackoffMs = 0;
let lastReconcileAt = 0;
let healthTimer = null;
let sweepTimer = null;
const pendingReasons = new Set();
const healing = { reconciles: 0, herdrRestarts: 0, faceRepairs: 0, failures: 0, lastAt: null, lastReasons: [], lastError: null };

const runtime = createRuntime({
  cwd: workdir,
  shell: chooseShell(env.CODING_CUBE_SHELL || env.SHELL),
  herdr: HERDR,
  workspace: WORKSPACE,
  publicRoot: paths.public,
  webOrigin: env.CODING_CUBE_WEB_ORIGIN,
  // Deliberately not readServerOptions(): config.js mints a file-backed pairing
  // code when the env var is empty, and origin.js short-circuits on a missing
  // token. AgentCore already authenticated whoever reached this port, and every
  // proxied request looks remote, so a second credential would only lock the
  // platform out of its own container.
  token: undefined,
  exposure: { active: false, tsOrigin: null },
  tailnet: null,
  gatewayOnly: true,
  hosts: [env.HOST || '0.0.0.0'],
  host: env.HOST || '0.0.0.0',
  port: Number(env.PORT || 8080),
});

setAgentCoreRoutes({ ping: () => busy.status(), invoke, face: faceState });

// start() prepares the terminal grid first, and preparing it means talking to a
// Herdr server bootstrap has not started yet. Port 8080 has to be open before any
// of that, or AgentCore never sees a /ping and kills the microVM.
runtime.terminalGrid.setTargets([]);
const holdGrid = setInterval(() => runtime.terminalGrid.setTargets(runtime.terminalGrid.targets), 500);
holdGrid.unref?.();

const address = await runtime.start();
console.log(`coding-cube agentcore gateway is listening at http://${address.host}:${address.port}/`);

bootstrap().catch((error) => warn(`bootstrap failed: ${error.message}`));
// A session whose only activity is a shell connection may never call
// /invocations, so bootstrap has to be able to finish on its own.
const bootstrapRetry = setInterval(() => {
  if (state !== 'ready') bootstrap().catch(() => {});
}, RETRY_MS);
bootstrapRetry.unref?.();

function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = runBootstrap().catch((error) => {
      bootstrapPromise = null;
      throw error;
    });
  }
  return bootstrapPromise;
}

async function runBootstrap() {
  bootStartedAt = Date.now();
  phases = [];
  state = 'booting';
  busy.setReady(false);

  const mounted = await step('mount', () => waitForMount(MOUNT, MOUNT_TIMEOUT_MS));
  await step('restore', () => store.restore(mounted));
  store.startSyncLoop();
  busy.setTracePath(store.statePath('ping-trace.ndjson'));
  await step('workdir', setWorkdir);
  await step('herdr-server', startHerdrServer);
  await step('herdr-ready', waitForHerdrServer);
  const cube = await step('workspace', () => ensureCubeWorkspace(HERDR, WORKSPACE, workdir));
  await step('faces', () => loadFaces(cube));
  await step('integrations', installIntegrations);
  await step('busy', startBusyTracking);

  bootMs = Date.now() - bootStartedAt;
  state = 'ready';
  phase = 'ready';
  busy.setReady(true);
  clearInterval(holdGrid);
  applyPersistence();
  startSupervision();
  await store.appendLog(JSON.stringify({ t: Date.now(), bootMs, mode: store.report().mode, persistence, phases }));
  return true;
}

// ensureCubeWorkspace() has always been idempotent and has always been able to
// heal a cube whose tabs went away — it just only ever ran inside runBootstrap(),
// and the retry that calls runBootstrap() is gated on state !== 'ready'. So a
// cube that finished booting and then broke stayed broken: herdr stayed dead, and
// a face whose shell exited took its tab with it, silently shrinking the pane
// scope /ping judges. Reconciliation is that same idempotent repair, reachable
// while the cube is ready.
function startSupervision() {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    checkHerdr().catch((error) => warn(`herdr health check failed: ${error.message}`));
  }, HEALTH_MS);
  healthTimer.unref?.();
  sweepTimer = setInterval(() => requestReconcile('sweep'), SWEEP_MS);
  sweepTimer.unref?.();
}

async function checkHerdr() {
  if (state !== 'ready' || reconciling || adopting) return;
  if (await runningSocket()) return;
  busy.setHerdrAlive(false);
  requestReconcile('herdr-down');
}

// One timer, coalescing, with a floor and a failure backoff. Signals are cheap
// and can arrive in bursts — six tab.closed events land together when a
// workspace is torn down — so the scheduler, not the caller, decides how often a
// pass actually runs. A reconcile can therefore never spin: every path to a pass
// goes through this delay, and a pass that fails only makes the next one later.
function requestReconcile(reason) {
  if (state !== 'ready' || adopting) return;
  pendingReasons.add(reason);
  if (reconciling || reconcileTimer) return;
  const wait = Math.max(0, lastReconcileAt + RECONCILE_MIN_MS + reconcileBackoffMs - Date.now());
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconciling = reconcile().finally(() => {
      reconciling = null;
      // Anything that arrived mid-pass gets its own scheduled pass rather than a
      // recursive one.
      if (pendingReasons.size) requestReconcile('deferred');
    });
  }, wait);
  reconcileTimer.unref?.();
}

async function reconcile() {
  const reasons = [...pendingReasons];
  pendingReasons.clear();
  lastReconcileAt = Date.now();
  healing.reconciles += 1;
  healing.lastAt = lastReconcileAt;
  healing.lastReasons = reasons;

  try {
    if (!(await runningSocket())) {
      busy.setHerdrAlive(false);
      warn(`herdr is not answering (${reasons.join(', ')}); restarting it`);
      await startHerdrServer();
      await waitForHerdrServer();
      healing.herdrRestarts += 1;
      // The hooks register by absolute path against the live home, and a server
      // that just came back has not read them.
      await installIntegrations();
      await openEvents();
    }
    busy.setHerdrAlive(true);

    // Compare pane ids, not terminal ids: the pane id is what the event stream
    // subscribes to, so it is the thing whose change has to invalidate the stream.
    const before = faces.map(({ paneId }) => paneId).join(',');
    // Idempotent by construction: it recreates only the faces that are missing
    // and leaves every unrelated workspace and tab alone.
    await loadFaces(await ensureCubeWorkspace(HERDR, WORKSPACE, workdir));
    const repaired = faces.map(({ paneId }) => paneId).join(',') !== before;
    if (repaired) {
      healing.faceRepairs += 1;
      warn(`restored the cube workspace (${reasons.join(', ')})`);
    }

    // `pane.agent_status_changed` cannot be subscribed to without a pane_id filter,
    // so herdr-state.js pins the subscription to the pane ids that existed when the
    // stream opened. A repaired face gets a NEW pane id, and the old subscription
    // goes on watching a pane that no longer exists — measured: herdr reported the
    // repaired pane `working` for 10 s while the gateway's cache still said `done`
    // and /ping still said Healthy. Only the 60 s re-seed corrected it, so every
    // repaired face carried a blind window in which an agent could start and finish
    // unseen. Reopening the stream re-reads the live pane ids, which is the whole
    // fix; the re-seed after it is what makes the new subscription's cache correct
    // from its first moment rather than from its first event.
    if (!stopEvents || repaired) await openEvents();
    if (repaired) await busy.seed();
    reconcileBackoffMs = 0;
    healing.lastError = null;
  } catch (error) {
    healing.failures += 1;
    healing.lastError = error.message;
    reconcileBackoffMs = Math.min(Math.max(RECONCILE_MIN_MS, reconcileBackoffMs * 2), RECONCILE_BACKOFF_MAX_MS);
    warn(`reconcile failed (${reasons.join(', ')}): ${error.message}; next attempt in ${reconcileBackoffMs}ms`);
    requestReconcile('retry');
  }
}

// The mount is documented to appear only at invocation time, never during
// initialization, so an ephemeral boot is a provisional reading rather than a
// verdict. Booting anyway keeps a shell-only session usable; latching the answer
// is what silently ran the whole session on the writable layer and lost it at
// idle timeout. Keep watching until the mount shows up, then re-run bootstrap on
// top of it. CODING_CUBE_ALLOW_EPHEMERAL=1 accepts ephemeral as final and stops
// the watch.
function applyPersistence() {
  const durable = store.report().mode === 'session';
  persistence = durable ? 'session' : ALLOW_EPHEMERAL ? 'ephemeral' : 'ephemeral-provisional';
  busy.setPersistence(persistence);
  if (durable || ALLOW_EPHEMERAL) {
    clearInterval(mountWatch);
    mountWatch = null;
    return;
  }
  if (mountWatch) return;
  warn(`no session storage at ${MOUNT}; running ephemeral and watching for the mount`);
  mountWatch = setInterval(() => adoptMount().catch((error) => warn(`mount watch failed: ${error.message}`)), MOUNT_WATCH_MS);
  mountWatch.unref?.();
}

async function adoptMount() {
  if (adopting || state !== 'ready' || store.report().mode === 'session') return;
  lastMountCheckAt = Date.now();
  const mounted = await waitForMount(MOUNT, 0);
  if (!(mounted.present && mounted.writable)) return;

  adopting = true;
  try {
    mountAdoptions += 1;
    warn(`session storage appeared at ${MOUNT} after ${mountAdoptions - 1} earlier attempts; re-running bootstrap onto it`);
    // restore() moves $HOME's durable directories onto the mount underneath a
    // running herdr, and herdr reads session.json once at startup, so the server
    // has to come down first. Terminal ids are minted per server start, so
    // loadFaces() re-targets the grid and any attached face reconnects.
    await stopHerdrServer();
    bootstrapPromise = null;
    await bootstrap();
  } finally {
    adopting = false;
  }
}

// WORKDIR must never be created under the mount point while the mount is absent:
// that directory lands on the writable layer and the next mount check would read
// it as session storage having arrived.
async function setWorkdir() {
  workdir = chooseWorkdir(store.report().mode);
  await fs.mkdir(workdir, { recursive: true });
  runtime.terminalGrid.cwd = workdir;
  return workdir;
}

function chooseWorkdir(mode) {
  if (mode === 'session') return WORKDIR_OVERRIDE || path.join(MOUNT, 'work');
  if (WORKDIR_OVERRIDE && !isUnder(MOUNT, WORKDIR_OVERRIDE)) return WORKDIR_OVERRIDE;
  return path.join(HOME, 'work');
}

function isUnder(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function step(name, run) {
  phase = name;
  const startedAt = Date.now();
  try {
    const value = await run();
    phases.push({ phase: name, ms: Date.now() - startedAt, ok: true });
    return value;
  } catch (error) {
    phases.push({ phase: name, ms: Date.now() - startedAt, ok: false, error: error.message });
    throw error;
  }
}

async function startHerdrServer() {
  herdr.version = await herdrVersion();
  if (await runningSocket()) return 'running';

  await fs.mkdir(path.dirname(SOCKET), { recursive: true });
  // herdr reads anything already at the socket path as proof a server is running
  // and exits without ever binding ("error: herdr server is already running"), so
  // a socket left by a stopped server — or a symlink baked into an image — has to
  // go. Nothing is created here in its place.
  await fs.rm(SOCKET, { force: true });
  const logPath = store.statePath('herdr-server.log');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const log = await fs.open(logPath, 'a');
  try {
    // Nothing in the cube has ever started the Herdr daemon — the gateway only
    // ever talked to a socket someone else opened.
    const child = spawn(HERDR, ['--session', 'default', 'server'], {
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env, HOME },
    });
    // Detached and unref'd so it outlives the gateway, but still watched: an
    // exit event is immediate where the health poll is up to HEALTH_MS late.
    child.unref();
    herdrChild = child;
    child.once('exit', (code, signal) => {
      // stopHerdrServer() clears the handle first, so a deliberate stop — the
      // one a late mount adoption performs — does not read as a death.
      if (herdrChild !== child) return;
      herdrChild = null;
      busy.setHerdrAlive(false);
      warn(`herdr server exited (${code ?? signal})`);
      requestReconcile('herdr-exited');
    });
  } finally {
    await log.close();
  }
  return 'spawned';
}

async function stopHerdrServer() {
  herdrChild = null;
  try {
    if (await runningSocket()) await runHerdrText(['server', 'stop']);
  } catch (error) {
    warn(`herdr server stop failed: ${error.message}`);
  }
  const deadline = Date.now() + HERDR_READY_TIMEOUT_MS;
  while (await runningSocket()) {
    if (Date.now() > deadline) throw new Error('herdr server did not stop');
    await sleep(250);
  }
  await fs.rm(SOCKET, { force: true });
}

async function waitForHerdrServer() {
  const deadline = Date.now() + HERDR_READY_TIMEOUT_MS;
  for (;;) {
    const socket = await runningSocket();
    if (socket) {
      // The path herdr reports is the only authority on where it bound; anything
      // else the gateway believes is a guess.
      if (socket !== SOCKET) warn(`herdr bound ${socket}, not the expected ${SOCKET}`);
      herdr.socket = socket;
      await widenSocket(socket);
      watchSockets(path.dirname(socket));
      return socket;
    }
    if (Date.now() > deadline) throw new Error(`herdr server did not report running within ${HERDR_READY_TIMEOUT_MS}ms`);
    await sleep(250);
  }
}

async function runningSocket() {
  try {
    const stdout = await runHerdrText(['status', 'server']);
    if (!/^status:\s*running$/m.test(stdout)) return null;
    return stdout.match(/^socket:\s*(.+)$/m)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

// herdr creates herdr.sock and herdr-client.sock 0600 explicitly — no umask here
// can widen them — and connect(2) needs write permission on the socket file. The
// uid AgentCore hands a platform-spawned shell is undocumented, so without this
// every face waits out the whole bootstrap and then dies with EACCES on the last
// line of cube-face. The isolation boundary is the microVM, not this file mode.
async function widenSocket(socket) {
  const directory = path.dirname(socket);
  const modes = {};
  try {
    await fs.chmod(directory, 0o777);
    // Per entry, because herdr unlinks and recreates these sockets while the
    // watcher is walking the directory: one ENOENT must not stop the pass before
    // it reaches a socket that is still there and still 0600.
    for (const entry of await fs.readdir(directory)) {
      if (!entry.endsWith('.sock')) continue;
      try {
        await fs.chmod(path.join(directory, entry), 0o666);
        modes[entry] = '0666';
      } catch (error) {
        if (error.code !== 'ENOENT') warn(`could not widen ${entry}: ${error.message}`);
      }
    }
  } catch (error) {
    warn(`could not widen the herdr socket permissions: ${error.message}`);
  }
  herdr.socketModes = modes;
  return modes;
}

// Observed on the real binary: herdr recreates herdr-client.sock *after* the
// server reports running, so a single pass at boot leaves it 0600 and the client
// socket fails for exactly the same reason the api socket used to. Widen whatever
// appears, whenever it appears.
function watchSockets(directory) {
  if (socketWatcher) return;
  try {
    // Unthrottled on purpose: chmod is idempotent, and skipping an event because
    // an earlier pass is still running is how a socket stays 0600.
    socketWatcher = watch(directory, (_event, filename) => {
      if (filename?.endsWith('.sock')) widenSocket(path.join(directory, filename)).catch(() => {});
    });
    socketWatcher.unref?.();
  } catch (error) {
    warn(`could not watch ${directory} for new herdr sockets: ${error.message}`);
  }
}

// `cube` is whatever a snapshot already produced — ensureCubeWorkspace() returns
// exactly this shape — so a reconcile costs one herdr call instead of two.
// setTargets() closes any grid session whose terminal id moved, which is what
// makes a repaired face reconnect instead of talking to a dead pane.
async function loadFaces(cube = null) {
  const state = cube ?? await readHerdrState(HERDR, WORKSPACE);
  runtime.terminalGrid.setTargets(state.map(({ terminalId }) => terminalId));
  faces = state.map(({ face, tabId, paneId, terminalId }) => ({ face, label: `Face ${face + 1}`, tabId, paneId, terminalId }));
  busy.setPaneIds(faces.map(({ paneId }) => paneId));
  return faces;
}

async function installIntegrations() {
  integrations = [];
  for (const name of ['claude', 'pi']) {
    try {
      // The installer registers its hook by absolute path, so it has to run
      // against the live home on every boot, not once at image build time.
      integrations.push({ name, ok: true, output: (await runHerdrText(['integration', 'install', name])).trim().slice(0, 400) });
    } catch (error) {
      // Without the hook /ping guesses instead of knowing, which is worth
      // reporting and never worth refusing to boot over.
      warn(`herdr integration install ${name} failed: ${error.message}`);
      integrations.push({ name, ok: false, error: error.message });
    }
  }
  return integrations;
}

// Herdr only ever sees agents. A person reading a build log or sitting in vim is
// invisible to it, so sample the grid directly: how many clients are attached,
// and when a PTY last emitted anything. Echo means typing counts as output, so a
// shell in use never looks quiet, and a shell nobody has touched stops counting.
const instrumented = new WeakSet();
const shellWatch = setInterval(sampleShells, SHELL_SAMPLE_MS);
shellWatch.unref?.();

function sampleShells() {
  let attached = 0;
  for (const session of runtime.terminalGrid.sessions.values()) {
    attached += session.clients.size;
    if (instrumented.has(session)) continue;
    instrumented.add(session);
    try {
      busy.noteShellOutput();
      session.pty.onData(() => busy.noteShellOutput());
      // `herdr terminal attach <id>` exiting means that pane is gone, and it is
      // the one signal for a dead face that costs nothing and arrives at once —
      // herdr itself broadcasts no event for it. Only covers faces a browser is
      // attached to; the sweep covers the rest.
      session.pty.onExit(() => requestReconcile('face-detached'));
    } catch (error) {
      warn(`could not observe terminal ${session.id}: ${error.message}`);
    }
  }
  busy.setAttachedShells(attached);
}

async function startBusyTracking() {
  await busy.seed();
  busy.start();
  await openEvents();
}

// Both the 5 s retry and a reconcile can decide to reopen the stream. Without a
// guard the loser leaks a live socket that nothing will ever stop, because
// `stopEvents` only ever holds the last one.
function openEvents() {
  if (!opening) opening = runOpenEvents().finally(() => { opening = null; });
  return opening;
}

async function runOpenEvents() {
  stopEvents?.();
  stopEvents = await watchHerdrState(HERDR, () => {}, onEventsLost, WORKSPACE, (message) => {
    try {
      busy.onEvent(message);
    } catch (error) {
      warn(`busy cache rejected an event: ${error.message}`);
    }
    // A face's shell exiting makes herdr close the pane and then the tab, and
    // /ping's scope silently shrinks with it. This is the signal that says so.
    const kind = typeof message?.event === 'string' ? message.event.replaceAll('.', '_') : null;
    if (kind && REPAIR_EVENTS.has(kind)) requestReconcile(kind);
  });
  busy.setEventsConnected(true);
}

function onEventsLost() {
  stopEvents = null;
  busy.setEventsConnected(false);
  // The stream drops when herdr dies, but also when it has not: reconnecting is
  // the cheap answer, and the reconcile behind it is the one that notices the
  // difference.
  requestReconcile('events-lost');
  clearTimeout(eventRetry);
  eventRetry = setTimeout(() => openEvents().catch((error) => {
    warn(`herdr event stream did not reopen: ${error.message}`);
    onEventsLost();
  }), RETRY_MS);
  eventRetry.unref?.();
}

async function invoke(body) {
  // An absent or unrecognised op is treated as `state`, because the platform may
  // probe this route with a body shape of its own.
  const op = typeof body?.op === 'string' ? body.op : 'state';
  busy.beginInvocation();
  try {
    if (op === 'snapshot') return await snapshot();
    if (op === 'probe') return await probe();
    if (op === 'hold') {
      const seconds = Number(body?.seconds ?? 60);
      return { op, seconds, holdUntil: busy.hold(seconds), ping: busy.status() };
    }
    if (op === 'exec') return await runExec(body?.cmd);
    return await stateResponse(op);
  } finally {
    busy.endInvocation();
  }
}

async function stateResponse(op) {
  let error = null;
  try {
    await bootstrap();
  } catch (failure) {
    error = failure.message;
  }
  return {
    op,
    state,
    phase,
    error,
    elapsedMs: state === 'ready' ? bootMs : Date.now() - bootStartedAt,
    phases,
    ...store.report(),
    persistence: {
      mode: persistence,
      durable: store.report().mode === 'session',
      allowEphemeral: ALLOW_EPHEMERAL,
      watchingForMount: Boolean(mountWatch),
      adoptions: mountAdoptions,
      lastMountCheckAt: lastMountCheckAt || null,
      workdir,
    },
    herdr: { ...herdr, integrations, supervisedPid: herdrChild?.pid ?? null },
    healing: { ...healing, backoffMs: reconcileBackoffMs, pending: [...pendingReasons], running: Boolean(reconciling) },
    faces,
    busy: busy.report(),
    image: { digest: env.CODING_CUBE_IMAGE_DIGEST || null },
  };
}

// The four undocumented properties of a platform-spawned PTY, read from the
// gateway's own process so there is something to compare a shell against.
async function probe() {
  return {
    home: env.HOME ?? null,
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    term: env.TERM ?? null,
    cwd: process.cwd(),
    shell: chooseShell(env.CODING_CUBE_SHELL || env.SHELL),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    herdrSocket: herdr.socket,
    df: await capture('df', ['-h', MOUNT, '/', '/tmp']),
    mounts: await mountTable(),
    ls: {
      [MOUNT]: await listDir(MOUNT),
      [HOME]: await listDir(HOME),
      [workdir]: await listDir(workdir),
    },
  };
}

async function runExec(cmd) {
  if (!SPIKE) return { error: 'exec requires CODING_CUBE_SPIKE=1' };
  if (typeof cmd !== 'string' || !cmd.trim()) return { error: 'exec requires a cmd string' };
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', cmd], { maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message };
  }
}

function faceState(number) {
  // cube-wait-face polls this, and a shell-only session reaches it before anything
  // has called /invocations, so asking is what starts the machine.
  bootstrap().catch(() => {});
  const known = Number.isInteger(number) && number >= 1 && number <= FACE_COUNT;
  const entry = known ? faces[number - 1] : null;
  return {
    state,
    phase,
    face: number,
    persistence,
    elapsedMs: state === 'ready' ? bootMs : Date.now() - bootStartedAt,
    terminalId: entry?.terminalId ?? null,
    paneId: entry?.paneId ?? null,
    error: known ? null : `face must be 1..${FACE_COUNT}`,
  };
}

async function snapshot() {
  const envelope = await runHerdr(['api', 'snapshot']);
  try {
    busy.setPaneIds(cubePaneIds(envelope, WORKSPACE));
  } catch {
    // The cube workspace does not exist yet; the next seed will scope it.
  }
  return envelope;
}

async function runHerdr(args) {
  return JSON.parse(await runHerdrText(args, { maxBuffer: 10 * 1024 * 1024 }));
}

async function runHerdrText(args, options = {}) {
  const { stdout } = await execFileAsync(HERDR, ['--session', 'default', ...args], { maxBuffer: 4 * 1024 * 1024, ...options });
  return stdout;
}

async function herdrVersion() {
  try {
    const { stdout } = await execFileAsync(HERDR, ['--version']);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function capture(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 256 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (error) {
    return `error: ${error.message}`;
  }
}

async function mountTable() {
  try {
    return (await fs.readFile('/proc/mounts', 'utf8')).split('\n').filter((line) => line.includes(` ${MOUNT} `) || line.includes(' / '));
  } catch (error) {
    return { error: error.message };
  }
}

async function listDir(target) {
  try {
    return (await fs.readdir(target)).slice(0, 200);
  } catch (error) {
    return { error: error.message };
  }
}

function warn(message) {
  console.error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Nothing documents whether a container is signalled before its microVM is torn
// down, so this is a bonus flush on top of the two-second sync loop, not the
// persistence mechanism.
async function shutdown() {
  try {
    clearInterval(mountWatch);
    clearInterval(shellWatch);
    clearInterval(healthTimer);
    clearInterval(sweepTimer);
    clearTimeout(reconcileTimer);
    await Promise.race([Promise.all([store.flush(), busy.close()]), sleep(2000)]);
    store.stop();
    stopEvents?.();
    await runtime.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
