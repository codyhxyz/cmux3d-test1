// A workspace waking from sleep and a workspace that is broken look identical when the
// only feedback is six terminals retrying. This module owns the one question the
// interface has to answer out loud — what is this workspace doing, and what can I do
// about it — derived from signals that already exist: the transport's workspace gate,
// the phase /prepare reports, and the busy block in the /invocations state payload.
//
// Deliberately DOM-free so it can be reasoned about (and tested) without a browser;
// main.js owns the elements, this owns the state and the words.

/** Before this a wake is instant and a counter is noise; after it, silence reads as a hang. */
export const ELAPSED_AFTER_MS = 5_000;
// Cold start was measured at 1342 ms. Anything still waking after this is not slow, it is
// stuck, and continuing to call it "Waking" is the endless spinner the plan forbids.
export const STUCK_AFTER_MS = 90_000;
const FACE_COUNT = 6;
const DETAIL_REFRESH_MS = 15_000;

// Plan section 6. Every state carries its own words and its own way out.
export const LIFECYCLE = {
  ready: { label: 'Ready', tone: 'ok', action: null },
  working: { label: 'Working', tone: 'busy', action: null },
  sleeping: { label: 'Sleeping', tone: 'idle', action: 'Wake' },
  waking: { label: 'Waking', tone: 'busy', action: 'Cancel' },
  saving: { label: 'Saving', tone: 'busy', action: null },
  attention: { label: 'Needs attention', tone: 'bad', action: 'Retry' },
};

// The four lines from plan section 3, against the phases the container actually reports
// (`mount`, `restore`, `workdir`, `herdr-server`, `herdr-ready`, `workspace`, `faces`,
// `integrations`, `busy`, `ready`). An unrecognised phase falls back to the first line
// rather than inventing a step that may not exist.
const PHASE_LINES = new Map([
  ['mount', 'Restoring files…'],
  ['restore', 'Restoring files…'],
  ['workdir', 'Resuming Herdr…'],
  ['herdr-server', 'Resuming Herdr…'],
  ['herdr-ready', 'Resuming Herdr…'],
  ['workspace', 'Resuming Herdr…'],
  ['faces', 'Opening terminals…'],
  ['integrations', 'Opening terminals…'],
  ['busy', 'Opening terminals…'],
  ['ready', 'Opening terminals…'],
]);

export function wakeLine(phase) {
  return PHASE_LINES.get(phase) ?? 'Starting your workspace…';
}

/**
 * One lifecycle state from everything currently known. Pure: the caller supplies the
 * clock, so the same inputs always produce the same words.
 *
 * `workspace` accepts either the transport gate's normalized state or the raw /prepare
 * body, because they carry the same fields under the same names.
 */
export function deriveWorkspaceState({
  cloud = false,
  connection = 'connecting',
  preparing = false,
  cancelled = false,
  workspace = null,
  busy = null,
  faces = 0,
  faceCount = FACE_COUNT,
  elapsedMs = 0,
  error = null,
  everStarted = false,
} = {}) {
  // A computer you own does not sleep, and calling an unreachable laptop "Sleeping"
  // would be a guess about someone else's machine. Only the cloud has a lifecycle.
  if (!cloud) return blank();

  if (error) {
    const auth = error.auth === true || /aws login/i.test(error.message || '');
    return state('attention', {
      detail: auth
        ? 'AWS login expired on the computer that owns this workspace.'
        : error.message || 'The workspace could not be reached.',
      action: auth ? 'Reconnect' : 'Retry',
    });
  }
  if (cancelled) return state('sleeping', { detail: 'Wake cancelled. Your files and Herdr sessions are kept.' });

  const phase = typeof workspace?.phase === 'string' ? workspace.phase : null;
  const ready = workspace?.ready ?? workspace?.state === 'ready';
  // A workspace with all six faces live is not waking, whatever else is in flight. The
  // detail refresh is an /invocations call on exactly that workspace, so without this
  // an open Computers popover repaints a healthy cube as "Waking… Cancel" every 15s.
  const attached = connection === 'connected' && faces >= faceCount;
  const waking = (preparing && !attached) || connection === 'lost' || (connection === 'connected' && faces < faceCount);

  if (workspace?.state === 'saving') {
    return state('saving', { detail: 'Saving your workspace before sleep' });
  }
  if (waking) {
    // Elapsed time is what makes this falsifiable: without it a wedged wake and a slow
    // one are the same picture forever.
    if (elapsedMs >= STUCK_AFTER_MS) {
      return state('attention', { detail: 'This is taking much longer than a wake should. Your files are still safe.' });
    }
    // A workspace that already reported ready is not booting; the remaining wait is the
    // faces attaching, and naming a boot phase it has finished would be fiction.
    let line = wakeLine(phase);
    if (!preparing && connection === 'lost') line = 'Reconnecting your terminals…';
    else if (!preparing && ready) line = 'Opening terminals…';
    return state('waking', { detail: line });
  }
  if (connection === 'connected' && ready !== false) {
    const working = workingPanes(busy, workspace?.faces);
    if (working.length) return state('working', { detail: agentDetail(working), note: agentNote(working) });
    return state('ready', { detail: 'All six terminals are attached.' });
  }
  return state('sleeping', {
    detail: everStarted
      ? 'Sleeping. Your files and Herdr sessions are kept.'
      : 'Never started. Waking takes a couple of seconds.',
  });
}

/**
 * Panes a coding agent is actually working in.
 *
 * The agent_status enum is idle, working, blocked, done, unknown, and only `working`
 * means busy: `blocked` is an agent waiting on a human, which is exactly when sleeping
 * the microVM is the right thing to do.
 */
export function workingPanes(busy, faces = []) {
  const panes = busy?.panes;
  if (!panes || typeof panes !== 'object') return [];
  const named = new Map(
    (Array.isArray(faces) ? faces : [])
      .filter((entry) => entry?.paneId)
      .map((entry) => [entry.paneId, entry.label || `Face ${(entry.face ?? 0) + 1}`]),
  );
  return Object.entries(panes)
    .filter(([, pane]) => pane?.status === 'working')
    .map(([paneId, pane]) => ({ paneId, status: pane.status, label: named.get(paneId) ?? null }));
}

/** The sentence users most need to trust: work in progress will not be slept out from under them. */
export function agentNote(working) {
  if (!working?.length) return null;
  return working.length === 1 ? 'Agent working — sleep paused' : `${working.length} agents working — sleep paused`;
}

function agentDetail(working) {
  const named = working.filter((pane) => pane.label);
  if (working.length === 1) return named.length ? `An agent is working in ${named[0].label}.` : 'An agent is working.';
  return `Agents are working in ${working.length} faces.`;
}

/**
 * Plain language, and only as specific as the truth allows: the idle timeout lives in
 * the runtime's lifecycleConfiguration and nothing reaches the browser today, so naming
 * a number we cannot read would be a guess.
 */
export function sleepPolicy(idleSeconds = null) {
  if (!Number.isFinite(idleSeconds) || idleSeconds <= 0) {
    return 'Sleeps on its own once no terminal or agent has been active. Your files are kept.';
  }
  const minutes = Math.round(idleSeconds / 60);
  return minutes >= 1
    ? `Sleeps after ${minutes} minute${minutes === 1 ? '' : 's'} with no terminal or agent activity.`
    : `Sleeps after ${Math.round(idleSeconds)} seconds with no terminal or agent activity.`;
}

/** Relative activity for a workspace row: `active now`, `slept 2h ago`, `never started`. */
export function describeActivity({ cloud = false, connection = 'connecting', lastConnected = 0, now = Date.now() } = {}) {
  if (connection === 'connected') return 'active now';
  if (!lastConnected) return cloud ? 'never started' : '';
  const ago = formatAgo(now - lastConnected);
  if (ago === 'just now') return cloud ? 'slept just now' : ago;
  return cloud ? `slept ${ago} ago` : `${ago} ago`;
}

export function formatAgo(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * The stateful half: holds the inputs, re-derives on every change, and runs the two
 * clocks the interface needs — the elapsed counter during a wake, and an on-demand
 * refresh while the user is actually looking at workspace details.
 */
export function createWorkspaceLifecycle({
  onChange = () => {},
  refresh = null,
  now = () => Date.now(),
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = (id) => clearInterval(id),
  tickMs = 1000,
  detailMs = DETAIL_REFRESH_MS,
  elapsedAfterMs = ELAPSED_AFTER_MS,
} = {}) {
  let input = { cloud: false, connection: 'connecting', faceCount: FACE_COUNT };
  let current = deriveWorkspaceState(input);
  // When the current wait began, held separately from the state so that escalating a
  // stuck wake to Needs attention does not reset the clock and flip straight back.
  let wakingSince = null;
  let tick = null;
  let detail = null;

  function elapsed() {
    return wakingSince === null ? 0 : now() - wakingSince;
  }

  function snapshot() {
    const elapsedMs = elapsed();
    return {
      ...current,
      elapsedMs,
      // Absent for the first five seconds on purpose: a counter on a two-second cold
      // start is noise, and not showing one is not the same as hiding the wait.
      elapsed: elapsedMs >= elapsedAfterMs ? formatElapsed(elapsedMs) : null,
    };
  }

  function retime() {
    if (wakingSince !== null && !tick) tick = schedule(onTick, tickMs);
    else if (wakingSince === null && tick) {
      cancel(tick);
      tick = null;
    }
  }

  // The clock is also an input: a wake that never lands has to escalate on its own, so
  // every tick re-derives rather than only redrawing.
  function onTick() {
    if (!recompute()) onChange(snapshot(), { stateChanged: false });
  }

  function recompute() {
    const at = now();
    // Two passes. The first asks what the inputs say by themselves, which is what decides
    // whether a wait is still running; only then may elapsed time escalate it.
    const bare = deriveWorkspaceState({ ...input, elapsedMs: 0 });
    if (bare.state === 'waking') wakingSince ??= at;
    else wakingSince = null;
    const next = wakingSince === null ? bare : deriveWorkspaceState({ ...input, elapsedMs: at - wakingSince });
    // Announcements ride the words, not the state name: "Resuming Herdr…" is a change
    // worth hearing even though the state is still Waking.
    const changed = next.state !== current.state || next.detail !== current.detail || next.note !== current.note;
    current = next;
    retime();
    if (changed) onChange(snapshot(), { stateChanged: true });
    return changed;
  }

  return {
    snapshot,
    get state() {
      return current.state;
    },
    update(patch = {}) {
      input = { ...input, ...patch };
      recompute();
    },
    /**
     * Refreshing costs one /invocations call, and an /invocations call is activity that
     * resets AgentCore's idle timer — so a background poll would quietly stop every
     * workspace from ever sleeping. It runs only while the user has the workspace
     * details open, which is also the only time the plan wants a countdown at all.
     */
    setDetailInterest(interested) {
      if (!interested || !refresh) {
        if (detail) cancel(detail);
        detail = null;
        return;
      }
      if (detail) return;
      refresh();
      detail = schedule(() => refresh(), detailMs);
    },
    dispose() {
      if (tick) cancel(tick);
      if (detail) cancel(detail);
      tick = null;
      detail = null;
    },
  };
}

function state(name, { detail, note = null, action } = {}) {
  const base = LIFECYCLE[name];
  return { state: name, label: base.label, tone: base.tone, action: action ?? base.action, detail, note };
}

function blank() {
  return { state: null, label: null, tone: null, action: null, detail: null, note: null };
}
