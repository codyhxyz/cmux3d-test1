import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Six faces is the square prism the product shipped with and the count a user who
// never touches the setting keeps forever.
export const DEFAULT_FACE_COUNT = 6;
export const MIN_FACE_COUNT = 6;
// Measured, not assumed. AgentCore allows ten concurrent interactive shells per
// runtime SESSION — spike/RESULTS.md T-10, where twelve shells across two sessions on
// one runtime is what disproved the docs' "per runtime" reading. One workspace is one
// session, so one workspace can never show more than ten faces. This number is that
// limit and nothing else; do not raise it without re-measuring.
export const MAX_FACE_COUNT = 10;

const EVENT_TYPES = [
  'workspace.renamed',
  'workspace.closed',
  'tab.created',
  'tab.renamed',
  'tab.closed',
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.agent_detected',
];
export const DEFAULT_WORKSPACE = 'Coding Cube';

// A count out of range is clamped and reported, never fatal. It arrives from a
// browser control, and a stale or hand-edited client asking for twelve should get ten
// and be told so rather than a rejection and no terminals at all.
export function clampFaceCount(value, fallback = DEFAULT_FACE_COUNT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return { faces: fallback, requested: null, clamped: false };
  const requested = Math.trunc(number);
  const faces = Math.min(MAX_FACE_COUNT, Math.max(MIN_FACE_COUNT, requested));
  return { faces, requested, clamped: faces !== requested };
}

// faceCount null means "however many Face tabs exist", floored at MIN_FACE_COUNT so a
// workspace that has lost a tab still fails closed exactly as it always did instead of
// quietly reporting a smaller cube.
export async function readHerdrState(executable = 'herdr', workspaceLabel = DEFAULT_WORKSPACE, faceCount = null) {
  return cubeState(await runHerdr(executable, ['api', 'snapshot']), workspaceLabel, faceCount);
}

// The cube owns one ordinary Herdr workspace. Make its tabs idempotently so local and
// cloud hosts need no separate setup ceremony, while leaving every unrelated workspace
// and tab alone.
//
// It only ever CREATES. Shrinking the cube from ten faces to six stops rendering four
// panes; it must not close them, because someone may have an agent mid-task in Face 9,
// and a tab closed here is that agent's work destroyed with no way back. Growing again
// finds those same tabs and reattaches the same panes.
//
// Runs one at a time per workspace. Reading a snapshot, deciding what is missing and
// then creating it is not atomic, and this function has several callers that overlap:
// ten faces attaching at once each ask for a different width, and the container's
// health sweep reconciles on its own timer. Two overlapping runs both see "Face 7
// absent" and both create it — and cubeSetupPlan() then refuses that workspace
// forever, so the cube is dead until a human closes tabs by hand. Measured against a
// live herdr: widening six faces to ten produced "Face 7, Face 7, Face 8, Face 8" and
// four faces that never opened again.
const provisioning = new Map();

export function ensureCubeWorkspace(
  executable = 'herdr',
  workspaceLabel = DEFAULT_WORKSPACE,
  cwd = process.cwd(),
  faceCount = DEFAULT_FACE_COUNT,
) {
  // A failed run must not poison the queue: the caller behind it is usually the sweep
  // that exists to repair exactly that failure.
  const run = (provisioning.get(workspaceLabel) ?? Promise.resolve())
    .then(() => provisionCube(executable, workspaceLabel, cwd, faceCount));
  provisioning.set(workspaceLabel, run.then(() => {}, () => {}));
  return run;
}

async function provisionCube(executable, workspaceLabel, cwd, faceCount) {
  const count = clampFaceCount(faceCount).faces;
  let envelope = await runHerdr(executable, ['api', 'snapshot']);
  const plan = cubeSetupPlan(envelope, workspaceLabel, count);
  let workspaceId = plan.workspaceId;

  if (!workspaceId) {
    const created = await runHerdr(executable, ['workspace', 'create', '--cwd', cwd, '--label', workspaceLabel, '--no-focus']);
    workspaceId = created.result.workspace.workspace_id;
    await runHerdr(executable, ['tab', 'rename', created.result.tab.tab_id, 'Face 1']);
    plan.createFaces.shift();
  } else if (plan.renameTabId) {
    await runHerdr(executable, ['tab', 'rename', plan.renameTabId, 'Face 1']);
    plan.createFaces.shift();
  }

  for (const face of plan.createFaces) {
    await runHerdr(executable, ['tab', 'create', '--workspace', workspaceId, '--cwd', cwd, '--label', `Face ${face}`, '--no-focus']);
  }

  if (!plan.workspaceId || plan.renameTabId || plan.createFaces.length) {
    envelope = await runHerdr(executable, ['api', 'snapshot']);
  }
  return cubeState(envelope, workspaceLabel, count);
}

// The plan names tabs to create and never tabs to remove — see ensureCubeWorkspace().
export function cubeSetupPlan(envelope, workspaceLabel = DEFAULT_WORKSPACE, faceCount = DEFAULT_FACE_COUNT) {
  const count = clampFaceCount(faceCount).faces;
  const snapshot = envelope?.result?.snapshot;
  if (!snapshot) throw new Error('HerdR snapshot is missing');

  const workspaces = snapshot.workspaces.filter(({ label }) => label === workspaceLabel);
  if (workspaces.length > 1) {
    throw new Error(`expected at most one HerdR workspace named "${workspaceLabel}"; found ${workspaces.length}`);
  }
  const allFaces = Array.from({ length: count }, (_, index) => index + 1);
  if (!workspaces.length) return { workspaceId: null, renameTabId: null, createFaces: allFaces };

  const workspaceId = workspaces[0].workspace_id;
  const tabs = snapshot.tabs.filter(({ workspace_id }) => workspace_id === workspaceId);
  const createFaces = [];
  for (const face of allFaces) {
    const matches = tabs.filter(({ label }) => label === `Face ${face}`);
    if (matches.length > 1) throw new Error(`HerdR workspace "${workspaceLabel}" contains duplicate tabs named "Face ${face}"`);
    if (!matches.length) createFaces.push(face);
  }

  const seed = createFaces.length === count && tabs.length === 1 && /^\d+$/.test(tabs[0].label) ? tabs[0].tab_id : null;
  return { workspaceId, renameTabId: seed, createFaces };
}

function cubeState(envelope, workspaceLabel, faceCount = null) {
  return selectCubeFaces(envelope, workspaceLabel, faceCount).map(({ face, workspace, tab, pane }) => ({
    face,
    session: 'default',
    workspace: workspace.label,
    tabId: tab.tab_id,
    paneId: pane.pane_id,
    terminalId: pane.terminal_id,
    snapshot: {
      ...envelope,
      result: {
        ...envelope.result,
        snapshot: {
          ...envelope.result.snapshot,
          focused_workspace_id: workspace.workspace_id,
          focused_tab_id: tab.tab_id,
          focused_pane_id: pane.pane_id,
        },
      },
    },
  }));
}

async function runHerdr(executable, args) {
  const { stdout } = await execFileAsync(executable, ['--session', 'default', ...args], { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// The only panes /ping may judge. Every other pane in the Herdr server belongs to
// somebody else's work and must not keep this machine awake.
//
// Scoped to the faces that EXIST, not the faces being rendered. Shrinking the cube
// hides a pane without closing it, and a hidden Face 9 can still hold an agent
// mid-task; judging only the visible faces would sleep the microVM out from under it.
export function cubePaneIds(envelope, workspaceLabel = DEFAULT_WORKSPACE) {
  return selectCubeFaces(envelope, workspaceLabel).map(({ pane }) => pane.pane_id);
}

// Same scope, from the snapshot a state array already carries, so a caller holding
// N rendered faces can reach the hidden ones without a second `herdr api snapshot`.
export function cubePaneScope(state, workspaceLabel = DEFAULT_WORKSPACE) {
  const envelope = state?.[0]?.snapshot;
  if (!envelope) return (state ?? []).map(({ paneId }) => paneId);
  return cubePaneIds(envelope, workspaceLabel);
}

// How many "Face n" tabs the workspace holds, counting up from 1 and stopping at the
// first gap. Capped at the ten-shell ceiling so a stray "Face 11" someone made by hand
// cannot widen the cube past what AgentCore will serve.
export function countCubeFaces(envelope, workspaceLabel = DEFAULT_WORKSPACE) {
  const snapshot = envelope?.result?.snapshot;
  const workspace = snapshot?.workspaces?.find(({ label }) => label === workspaceLabel);
  if (!workspace) return 0;
  const tabs = snapshot.tabs.filter(({ workspace_id }) => workspace_id === workspace.workspace_id);
  // A face only counts if it is whole. selectCubeFaces() refuses a snapshot over a tab
  // that has lost its pane, and one broken face nobody is even looking at must not take
  // the visible cube down with it — the sweep repairs it on the next pass.
  const usable = (face) => {
    const matches = tabs.filter(({ label }) => label === `Face ${face}`);
    if (matches.length !== 1) return false;
    const panes = snapshot.panes.filter(({ tab_id }) => tab_id === matches[0].tab_id);
    return panes.length === 1 && Boolean(panes[0].terminal_id);
  };
  let count = 0;
  while (count < MAX_FACE_COUNT && usable(count + 1)) count += 1;
  return count;
}

export function selectCubeFaces(envelope, workspaceLabel = DEFAULT_WORKSPACE, faceCount = null) {
  const snapshot = envelope?.result?.snapshot;
  if (!snapshot) throw new Error('HerdR snapshot is missing');

  const workspaces = snapshot.workspaces.filter(({ label }) => label === workspaceLabel);
  if (workspaces.length !== 1) {
    throw new Error(`expected exactly one HerdR workspace named "${workspaceLabel}"; found ${workspaces.length}`);
  }

  const workspace = workspaces[0];
  const workspaceTabs = snapshot.tabs.filter(({ workspace_id }) => workspace_id === workspace.workspace_id);
  // More tabs than were asked for is not an error — that is what a shrunken cube looks
  // like, and the surplus is somebody's live work. Fewer still is: the floor keeps a
  // workspace that has lost a tab failing closed so reconciliation repairs it.
  const count = faceCount === null || faceCount === undefined
    ? Math.max(MIN_FACE_COUNT, countCubeFaces(envelope, workspaceLabel))
    : clampFaceCount(faceCount).faces;

  return Array.from({ length: count }, (_, face) => {
    const label = `Face ${face + 1}`;
    const tabs = workspaceTabs.filter((tab) => tab.label === label);
    if (tabs.length !== 1) throw new Error(`HerdR workspace "${workspaceLabel}" must contain exactly one tab named "${label}"`);
    const tab = tabs[0];
    const panes = snapshot.panes.filter(({ tab_id }) => tab_id === tab.tab_id);
    if (panes.length !== 1 || !panes[0].terminal_id) {
      throw new Error(`tab "${tab.label}" must contain exactly one terminal pane`);
    }
    return { face, workspace, tab, pane: panes[0] };
  });
}

// onEvent receives each event unmodified, because /ping needs the agent_status the
// 250 ms change debounce throws away.
export async function watchHerdrState(executable, onChange, onDisconnect, workspaceLabel = DEFAULT_WORKSPACE, onEvent = null) {
  // Every face that exists, hidden ones included: `pane.agent_status_changed` cannot be
  // subscribed without a pane_id, so a pane left out here is an agent nothing is
  // watching — which is exactly the blind window that made a healed face sleepable.
  const state = await readHerdrState(executable, workspaceLabel);
  const { stdout } = await execFileAsync(executable, ['--session', 'default', 'status', 'server']);
  const socketPath = stdout.match(/^socket:\s*(.+)$/m)?.[1];
  if (!socketPath) throw new Error('HerdR did not report its default session socket');

  let socket;
  let changeTimer;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(changeTimer);
    socket?.destroy();
  };
  const changed = () => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      if (!stopped) onChange();
    }, 250);
  };

  await new Promise((resolve, reject) => {
    socket = net.createConnection(socketPath);
    const id = 'coding-cube';
    let buffer = '';
    let ready = false;

    const fail = (error) => {
      if (stopped) return;
      if (!ready) reject(error);
      else {
        stop();
        onDisconnect();
      }
    };

    socket.on('connect', () => socket.write(`${JSON.stringify({
      id,
      method: 'events.subscribe',
      params: {
        subscriptions: [
          ...EVENT_TYPES.map((type) => ({ type })),
          ...state.map(({ paneId }) => ({ type: 'pane.agent_status_changed', pane_id: paneId })),
        ],
      },
    })}\n`));
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('HerdR event stream closed')));
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          fail(error);
          return;
        }
        if (message.error) {
          fail(new Error(message.error.message));
          return;
        }
        if (message.id === id) {
          ready = true;
          resolve();
        } else if (message.event) {
          onEvent?.(message);
          changed();
        }
      }
    });
  });

  return stop;
}
