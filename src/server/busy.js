import fs from 'node:fs/promises';
import path from 'node:path';

const RESEED_MS = 60_000;
// Staleness must outlast the re-seed interval. A shorter window guarantees the
// cache goes stale between every pair of re-seeds, and each flip rewrites
// `time_of_last_update` — which is precisely what stops AgentCore's idle timeout
// from ever firing, so a cube with nothing running bills until maxLifetime.
const STALE_MS = RESEED_MS * 2;
// A degraded reading holds HealthyBusy so a blip cannot get a working microVM
// destroyed — but only for a while. Measured on the spike: with herdr dead,
// HealthyBusy latched from t=100s to t=160s and would have held to maxLifetime,
// so a cube that broke ten seconds after boot billed for a full hour. The files
// are on session storage either way, so an unrecoverable cube must be allowed to
// sleep; the human loses a wake-up, not their work.
//
// Measured from the last snapshot that actually answered, because that is the
// last moment busy-ness was known rather than assumed.
const GIVE_UP_MS = 300_000;
// Shorter when herdr is not merely quiet but confirmed gone and the supervisor
// has failed to bring it back — there is nothing left to wait for.
const HERDR_DOWN_GIVE_UP_MS = 120_000;
const FORK_THROTTLE_MS = 5_000;
// Backoff so a dead herdr is not re-probed every 5 s until maxLifetime.
const FORK_THROTTLE_MAX_MS = 60_000;
// Append-and-rotate: writeTrace() used to rewrite a 2000-line file to session
// storage once a second, which is megabytes an hour of NFS traffic against a
// 1 GB mount to record that nothing changed. Only new lines are written now, and
// the file rotates by rename at a byte cap. The format is unchanged — still one
// JSON object per line — so `tail -n 400` on it still works.
const TRACE_MAX_BYTES = 512 * 1024;
// Bounds memory if the mount is wedged and every append is failing.
const TRACE_PENDING_MAX = 2000;
// An attached WebSocket on its own would hold the microVM awake for as long as a
// browser tab is open, which is the same never-sleep bug from the other end. A
// shell only counts while its PTY is still producing output — echo means typing
// counts, and a build's own output counts.
const SHELL_ACTIVE_MS = Number(process.env.CODING_CUBE_SHELL_ACTIVE_MS || 300_000);
const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];

// Verified against the real linux/arm64 binary (`herdr agent wait --until`): the
// enum is exactly idle, working, blocked, done, unknown, and only `working` is
// busy. `blocked` is an agent waiting on the human, which is exactly when
// sleeping the microVM is correct, and a freshly created pane reports `unknown`,
// so treating that as busy would mean a new workspace never sleeps at all.
export function paneBusy(status) {
  return status === 'working';
}

export function createBusyTracker({
  paneIds = [],
  runSnapshot = null,
  log = console.error,
} = {}) {
  const panes = new Map();
  const pending = [];
  const seenEventKinds = new Set();
  let scope = [...paneIds];
  let tracePath = null;
  let traceTimer = null;
  let traceBytes = 0;
  let traceDropped = 0;
  let traceFresh = false;
  let writing = false;
  let reseedTimer = null;
  let seededAt = 0;
  let seeding = null;
  let lastForkAt = 0;
  let forkThrottleMs = FORK_THROTTLE_MS;
  let herdrDownAt = 0;
  let eventsConnected = false;
  let ready = false;
  let notReadyAt = Date.now();
  let holdUntil = 0;
  let inFlight = 0;
  let attachedShells = 0;
  let shellOutputAt = 0;
  let persistence = 'unknown';
  // Only ever written when the answer flips: a `time_of_last_update` that advances
  // on every ping tells AgentCore the session is changing continuously, and the
  // idle timeout then never fires.
  let reported = { status: 'HealthyBusy', since: Date.now() };

  function remember(paneId, status, hasAgent, source) {
    if (typeof paneId !== 'string' || !paneId) return;
    const previous = panes.get(paneId);
    panes.set(paneId, {
      status: AGENT_STATUSES.includes(status) ? status : previous?.status ?? 'unknown',
      // `agent` is optional on the event payload, so an event that omits it must
      // not erase what the last full snapshot knew. The 60 s re-seed is the
      // correction mechanism.
      hasAgent: hasAgent === undefined ? Boolean(previous?.hasAgent) : Boolean(hasAgent),
      source,
      at: Date.now(),
    });
  }

  function decide(now = Date.now()) {
    const per = {};
    let busy = false;
    for (const paneId of scope) {
      const pane = panes.get(paneId);
      const paneIsBusy = pane ? paneBusy(pane.status) : false;
      per[paneId] = { status: pane?.status ?? null, hasAgent: Boolean(pane?.hasAgent), busy: paneIsBusy };
      busy = busy || paneIsBusy;
    }

    // Herdr sees agents, not people. A human in vim across six faces registers as
    // six idle panes, and the microVM would be destroyed with the WebSockets
    // still attached.
    const shells = { attached: attachedShells, lastOutputAt: shellOutputAt || null, active: false };
    shells.active = attachedShells > 0 && shellOutputAt > 0 && now - shellOutputAt < SHELL_ACTIVE_MS;

    let reason = busy ? 'pane' : null;
    // Same unbounded latch from the other end: a cube whose bootstrap never
    // succeeds is never `ready`, and 'booting' would have held HealthyBusy to
    // maxLifetime just as surely as a dead herdr did. Cold start is measured at
    // 1342 ms; anything still booting after GIVE_UP_MS is not going to finish,
    // and falling through here lands it on 'unrecoverable' below.
    if (!ready && now - notReadyAt < GIVE_UP_MS) [busy, reason] = [true, 'booting'];
    else if (holdUntil > now) [busy, reason] = [true, 'hold'];
    else if (inFlight > 0) [busy, reason] = [true, 'invocation'];
    else if (!busy && shells.active) [busy, reason] = [true, 'shell'];
    else if (!busy && !eventsConnected && now - seededAt > STALE_MS) {
      // Nothing has confirmed this cache recently, and reporting Healthy from a
      // stale one hands AgentCore a reason to destroy a working microVM. But the
      // wait is bounded: past the give-up window this is not a blip, it is a
      // cube that cannot answer, and holding it awake only burns money.
      forkSoon();
      [busy, reason] = givenUp(now) ? [false, 'unrecoverable'] : [true, 'stale'];
    }
    return { busy, reason, panes: per, shells };
  }

  function givenUp(now) {
    if (now - seededAt > GIVE_UP_MS) return true;
    return Boolean(herdrDownAt) && now - herdrDownAt > HERDR_DOWN_GIVE_UP_MS;
  }

  function forkSoon() {
    const now = Date.now();
    if (!runSnapshot || seeding || now - lastForkAt < forkThrottleMs) return;
    lastForkAt = now;
    seed().catch(() => {});
  }

  function record(kind, payload) {
    if (!tracePath) return;
    if (pending.length >= TRACE_PENDING_MAX) {
      pending.shift();
      traceDropped += 1;
    }
    pending.push(JSON.stringify({ t: Date.now(), kind, payload, decided: decide() }));
    if (traceTimer) return;
    traceTimer = setTimeout(() => writeTrace().catch(() => {}), 1000);
    traceTimer.unref?.();
  }

  async function writeTrace() {
    traceTimer = null;
    if (!tracePath || !pending.length || writing) return;
    writing = true;
    // Taken before the await so a record() during the append is not written
    // twice and not lost.
    const lines = pending.splice(0, pending.length);
    const chunk = `${lines.join('\n')}\n`;
    try {
      await fs.mkdir(path.dirname(tracePath), { recursive: true });
      // Rotate before appending so the cap is never exceeded, and by rename so a
      // reader following the file sees a clean cut rather than a truncation.
      if (traceFresh || traceBytes + chunk.length > TRACE_MAX_BYTES) {
        traceFresh = false;
        await fs.rename(tracePath, `${tracePath}.1`).catch(() => {});
        traceBytes = 0;
      }
      await fs.appendFile(tracePath, chunk);
      traceBytes += chunk.length;
    } catch (error) {
      log(`ping trace append failed: ${error.message}`);
    } finally {
      writing = false;
    }
  }

  function seed() {
    if (seeding) return seeding;
    if (!runSnapshot) return Promise.reject(new Error('no snapshot source'));
    seeding = (async () => {
      const envelope = await runSnapshot();
      const snapshot = envelope?.result?.snapshot;
      if (!snapshot) throw new Error('HerdR snapshot is missing');
      const withAgents = new Set((snapshot.agents || []).map(({ pane_id }) => pane_id));
      for (const pane of snapshot.panes || []) {
        remember(pane.pane_id, pane.agent_status, 'agent' in pane || withAgents.has(pane.pane_id), 'seed');
      }
      seededAt = Date.now();
      forkThrottleMs = FORK_THROTTLE_MS;
      record('seed', { panes: (snapshot.panes || []).map(({ pane_id, agent_status, agent }) => ({ pane_id, agent_status, agent })) });
      return envelope;
    })().catch((error) => {
      // Every failed probe forks a herdr that is not answering. Back off, or a
      // dead cube spawns a process every five seconds until maxLifetime.
      forkThrottleMs = Math.min(forkThrottleMs * 2, FORK_THROTTLE_MAX_MS);
      throw error;
    }).finally(() => {
      seeding = null;
    });
    return seeding;
  }

  return {
    seed,
    setPaneIds(ids) {
      scope = [...ids];
    },
    setTracePath(value) {
      if (value === tracePath) return;
      tracePath = value;
      traceBytes = 0;
      // Deliberately not a stat(): session storage caches attributes for an hour
      // with no close-to-open consistency, so the size this microVM would read
      // for a file the last one wrote is not evidence of anything. Retiring the
      // previous generation costs one rename and makes the byte count exact.
      traceFresh = true;
    },
    setHerdrAlive(alive) {
      if (alive) herdrDownAt = 0;
      else if (!herdrDownAt) herdrDownAt = Date.now();
    },
    setReady(value) {
      const next = Boolean(value);
      // Only on the edge. runBootstrap() calls setReady(false) on every retry,
      // and restarting the clock each time is how "bounded" becomes "forever".
      if (next === ready) return;
      ready = next;
      notReadyAt = next ? 0 : Date.now();
    },
    setPersistence(value) {
      persistence = String(value);
    },
    // Attach and detach are counted rather than latched: a face whose browser tab
    // is closed stops holding the machine open as soon as the count drops.
    setAttachedShells(count) {
      attachedShells = Math.max(0, Number(count) || 0);
    },
    noteShellOutput(at = Date.now()) {
      if (at > shellOutputAt) shellOutputAt = at;
    },
    setEventsConnected(value) {
      eventsConnected = Boolean(value);
      if (!eventsConnected) forkSoon();
    },
    hold(seconds) {
      const span = Math.max(0, Math.min(3600, Number(seconds) || 0));
      holdUntil = Date.now() + span * 1000;
      return holdUntil;
    },
    beginInvocation() {
      inFlight += 1;
    },
    endInvocation() {
      inFlight = Math.max(0, inFlight - 1);
    },
    onEvent(message) {
      // Measured on herdr 0.8.0: a broadcast event arrives underscored
      // ("pane_agent_detected") but a per-pane subscription echoes the
      // subscription type back verbatim and dotted ("pane.agent_status_changed"),
      // and that subscription cannot be opened without a pane_id filter. Matching
      // one spelling silently drops every status change and leaves /ping relying
      // on the 60 s re-seed, so compare on a normalised name.
      const kind = typeof message?.event === 'string' ? message.event.replaceAll('.', '_') : null;
      const data = message?.data;
      if (!kind || !data || typeof data !== 'object') return;
      if (kind === 'pane_agent_status_changed') {
        remember(data.pane_id, data.agent_status, 'agent' in data ? Boolean(data.agent) : undefined, 'event');
        record('event', { event: message.event, data });
        return;
      }
      if (kind !== 'pane_agent_detected') return;

      // The verified schema covers PaneAgentStatusChangedEvent only, so this
      // payload's field names are a guess until the spike reads the trace. Log the
      // shape once rather than pretend to know it.
      if (!seenEventKinds.has(kind)) {
        seenEventKinds.add(kind);
        log(`herdr ${kind} payload keys: ${Object.keys(data).join(', ')}`);
      }
      if (typeof data.pane_id === 'string') remember(data.pane_id, data.agent_status, true, 'event');
      record('event', { event: message.event, data });
    },
    status() {
      const { busy, reason } = decide();
      const status = busy ? 'HealthyBusy' : 'Healthy';
      // A stale cache is a degraded reading, not a state change: it holds
      // HealthyBusy until a fork lands but never moves `since`. Letting it move
      // the timestamp is what made an idle cube advertise a continuous status
      // change forever, and the idle timeout then never fires.
      if (reason !== 'stale' && status !== reported.status) reported = { status, since: Date.now() };
      return { status, time_of_last_update: Math.floor(reported.since / 1000), persistence };
    },
    report() {
      const { busy, reason, panes: per, shells } = decide();
      return {
        busy,
        reason,
        ready,
        eventsConnected,
        persistence,
        inFlight,
        holdSecondsLeft: Math.max(0, Math.ceil((holdUntil - Date.now()) / 1000)),
        seededAt,
        staleMs: STALE_MS,
        giveUpMs: GIVE_UP_MS,
        herdrDownAt: herdrDownAt || null,
        shells,
        trace: { path: tracePath, bytes: traceBytes, pending: pending.length, dropped: traceDropped },
        tracePath,
        panes: per,
      };
    },
    start() {
      if (reseedTimer) return;
      // The `agent` key is optional on the event payload, so the cache drifts. A
      // full snapshot once a minute is the only thing that corrects it.
      reseedTimer = setInterval(() => seed().catch((error) => log(`ping re-seed failed: ${error.message}`)), RESEED_MS);
      reseedTimer.unref?.();
    },
    close() {
      clearInterval(reseedTimer);
      clearTimeout(traceTimer);
      reseedTimer = null;
      traceTimer = null;
      return writeTrace();
    },
  };
}
