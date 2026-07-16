import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EVENT_TYPES = [
  'workspace.created',
  'workspace.updated',
  'workspace.renamed',
  'workspace.closed',
  'workspace.focused',
  'tab.created',
  'tab.renamed',
  'tab.closed',
  'tab.focused',
  'pane.created',
  'pane.closed',
  'pane.focused',
  'pane.moved',
  'pane.agent_detected',
];
const RECONNECT_EVENTS = new Set(['workspace_created', 'tab_created', 'pane_created']);

export const HERDR_SESSIONS = Object.freeze([
  'cmux3d-front',
  'cmux3d-back',
  'cmux3d-right',
  'cmux3d-left',
  'cmux3d-top',
  'cmux3d-bottom',
]);

export function readHerdrState(executable = 'herdr') {
  return Promise.all(HERDR_SESSIONS.map((session, face) => readHerdrSession(executable, session, face)));
}

export async function watchHerdrState(executable, onChange, onDisconnect) {
  const sockets = new Set();
  let restartRequested = false;
  let stopped = false;
  let watching = false;
  const stop = () => {
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  const disconnect = () => {
    if (stopped) return;
    stop();
    onDisconnect();
  };

  try {
    const state = await readHerdrState(executable);
    await Promise.all(state.map(({ session, snapshot }, face) => subscribe(
      session,
      face,
      snapshot.result?.snapshot?.panes || [],
    )));
    if (restartRequested) throw new Error('HerdR topology changed while subscribing');
    watching = true;
  } catch (error) {
    stop();
    throw error;
  }

  return stop;

  async function subscribe(session, face, panes) {
    const { stdout } = await execFileAsync(executable, ['--session', session, 'status', 'server']);
    const socketPath = stdout.match(/^socket:\s*(.+)$/m)?.[1];
    if (!socketPath) throw new Error(`HerdR did not report a socket for ${session}`);

    await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const id = `cmux3d:${face}`;
      let buffer = '';
      let ready = false;
      sockets.add(socket);

      const fail = (error) => {
        if (stopped) return;
        if (!ready) reject(error);
        else disconnect();
      };

      socket.on('connect', () => socket.write(`${JSON.stringify({
        id,
        method: 'events.subscribe',
        params: {
          subscriptions: [
            ...EVENT_TYPES.map((type) => ({ type })),
            ...panes.map(({ pane_id }) => ({ type: 'pane.agent_status_changed', pane_id })),
          ],
        },
      })}\n`));
      socket.on('error', fail);
      socket.on('close', () => {
        sockets.delete(socket);
        if (!stopped) fail(new Error(`HerdR event stream closed for ${session}`));
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        let changed = false;
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
          } else if (RECONNECT_EVENTS.has(message.event)) {
            if (watching) disconnect();
            else restartRequested = true;
            return;
          } else if (message.event) {
            changed = true;
          }
        }
        if (changed && !stopped) onChange(face);
      });
    });
  }
}

async function readHerdrSession(executable, session, face) {
  return {
    face,
    session,
    snapshot: JSON.parse((await execFileAsync(
      executable,
      ['--session', session, 'api', 'snapshot'],
      { maxBuffer: 10 * 1024 * 1024 },
    )).stdout),
  };
}
