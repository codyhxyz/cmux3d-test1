import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FACE_COUNT = 6;
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

export async function readHerdrState(executable = 'herdr', workspaceLabel = DEFAULT_WORKSPACE) {
  return cubeState(await runHerdr(executable, ['api', 'snapshot']), workspaceLabel);
}

// The cube owns one ordinary Herdr workspace. Make its six tabs idempotently so
// local and cloud hosts need no separate setup ceremony, while leaving every
// unrelated workspace and tab alone.
export async function ensureCubeWorkspace(executable = 'herdr', workspaceLabel = DEFAULT_WORKSPACE, cwd = process.cwd()) {
  let envelope = await runHerdr(executable, ['api', 'snapshot']);
  const plan = cubeSetupPlan(envelope, workspaceLabel);
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
  return cubeState(envelope, workspaceLabel);
}

export function cubeSetupPlan(envelope, workspaceLabel = DEFAULT_WORKSPACE) {
  const snapshot = envelope?.result?.snapshot;
  if (!snapshot) throw new Error('HerdR snapshot is missing');

  const workspaces = snapshot.workspaces.filter(({ label }) => label === workspaceLabel);
  if (workspaces.length > 1) {
    throw new Error(`expected at most one HerdR workspace named "${workspaceLabel}"; found ${workspaces.length}`);
  }
  if (!workspaces.length) return { workspaceId: null, renameTabId: null, createFaces: [1, 2, 3, 4, 5, 6] };

  const workspaceId = workspaces[0].workspace_id;
  const tabs = snapshot.tabs.filter(({ workspace_id }) => workspace_id === workspaceId);
  const createFaces = [];
  for (let face = 1; face <= FACE_COUNT; face += 1) {
    const matches = tabs.filter(({ label }) => label === `Face ${face}`);
    if (matches.length > 1) throw new Error(`HerdR workspace "${workspaceLabel}" contains duplicate tabs named "Face ${face}"`);
    if (!matches.length) createFaces.push(face);
  }

  const seed = createFaces.length === FACE_COUNT && tabs.length === 1 && /^\d+$/.test(tabs[0].label) ? tabs[0].tab_id : null;
  return { workspaceId, renameTabId: seed, createFaces };
}

function cubeState(envelope, workspaceLabel) {
  return selectCubeFaces(envelope, workspaceLabel).map(({ face, workspace, tab, pane }) => ({
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
export function cubePaneIds(envelope, workspaceLabel = DEFAULT_WORKSPACE) {
  return selectCubeFaces(envelope, workspaceLabel).map(({ pane }) => pane.pane_id);
}

export function selectCubeFaces(envelope, workspaceLabel = DEFAULT_WORKSPACE) {
  const snapshot = envelope?.result?.snapshot;
  if (!snapshot) throw new Error('HerdR snapshot is missing');

  const workspaces = snapshot.workspaces.filter(({ label }) => label === workspaceLabel);
  if (workspaces.length !== 1) {
    throw new Error(`expected exactly one HerdR workspace named "${workspaceLabel}"; found ${workspaces.length}`);
  }

  const workspace = workspaces[0];
  const workspaceTabs = snapshot.tabs.filter(({ workspace_id }) => workspace_id === workspace.workspace_id);

  return Array.from({ length: FACE_COUNT }, (_, face) => {
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
