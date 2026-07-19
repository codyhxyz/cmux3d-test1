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
  const envelope = JSON.parse((await execFileAsync(
    executable,
    ['--session', 'default', 'api', 'snapshot'],
    { maxBuffer: 10 * 1024 * 1024 },
  )).stdout);

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

export async function watchHerdrState(executable, onChange, onDisconnect, workspaceLabel = DEFAULT_WORKSPACE) {
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
    const id = 'cmux3d';
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
          changed();
        }
      }
    });
  });

  return stop;
}
