import os from 'node:os';
import pty from 'node-pty';
import { DEFAULT_WORKSPACE, ensureCubeWorkspace, readHerdrState } from './herdr-state.js';
import { chooseShell, repairDarwinPtyHelper, resolveExecutable } from './shell.js';

const FACE_MIN = 0;
const FACE_MAX = 5;
const SLOT_MIN = 0;
const SLOT_MAX = 3;
const RESIZE_MAGIC = Buffer.from('CUBE');
const HISTORY_LIMIT = 1_000_000;

export class TerminalGrid {
  constructor({ cwd, shell, herdr, workspace = DEFAULT_WORKSPACE } = {}) {
    repairDarwinPtyHelper();
    this.cwd = cwd || os.homedir();
    this.shell = chooseShell(shell);
    this.herdr = resolveExecutable(herdr);
    this.workspace = workspace;
    this.targets = [];
    this.preparedAt = 0;
    this.workspaceReady = false;
    if (herdr && !this.herdr) throw new Error(`executable not found: ${herdr}`);
    this.sessions = new Map();
  }

  async prepare() {
    if (!this.herdr || Date.now() - this.preparedAt < 1000) return;
    const state = this.workspaceReady
      ? await readHerdrState(this.herdr, this.workspace)
      : await ensureCubeWorkspace(this.herdr, this.workspace, this.cwd);
    this.workspaceReady = true;
    this.setTargets(state.map(({ terminalId }) => terminalId));
  }

  setTargets(targets) {
    const previous = this.targets;
    this.targets = [...targets];
    this.preparedAt = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (previous[session.face] && previous[session.face] !== targets[session.face]) this.#closeSession(session);
    }
  }

  async attach(faceValue, slotValue, ws) {
    const face = normalizeInteger(faceValue, FACE_MIN, FACE_MAX);
    const slot = normalizeInteger(slotValue, SLOT_MIN, SLOT_MAX);
    await this.prepare();
    const session = this.#getSession(face, slot);
    if (session.history) send(ws, session.history);
    session.clients.add(ws);

    ws.on('message', (raw, isBinary) => {
      if (!isBinary) {
        session.pty.write(String(raw));
        return;
      }

      if (raw.length !== 8 || !raw.subarray(0, 4).equals(RESIZE_MAGIC)) {
        session.pty.write(raw.toString('latin1'));
        return;
      }

      const cols = raw.readUInt16BE(4);
      const rows = raw.readUInt16BE(6);
      if (cols < 20 || cols > 220 || rows < 8 || rows > 80) {
        ws.close(1003, 'invalid terminal size');
        return;
      }

      try {
        session.pty.resize(cols, rows);
      } catch (error) {
        send(ws, `\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      if (!session.clients.size) this.#closeSession(session);
    });

    return { face, slot, sessionId: session.id };
  }

  closeAll() {
    for (const session of [...this.sessions.values()]) this.#closeSession(session);
  }

  #closeSession(session) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    for (const client of session.clients) {
      try {
        client.close(1001, 'terminal detached');
      } catch {
        // Client may already be gone.
      }
    }
    try {
      session.pty.kill();
    } catch {
      // PTY may already be dead.
    }
  }

  #getSession(face, slot) {
    const id = `${face}.${slot}`;
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CODING_CUBE_FACE: String(face),
      CODING_CUBE_SLOT: String(slot),
      CODING_CUBE_SESSION: id,
    };
    for (const key of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID']) delete env[key];

    const term = pty.spawn(
      this.herdr || this.shell,
      this.herdr ? ['--session', 'default', 'terminal', 'attach', this.targets[face]] : [],
      { name: 'xterm-256color', cols: 90, rows: 28, cwd: this.cwd, env },
    );

    const session = {
      id,
      face,
      slot,
      pty: term,
      clients: new Set(),
      history: '',
    };

    term.onData((chunk) => {
      session.history = (session.history + chunk).slice(-HISTORY_LIMIT);
      for (const client of session.clients) {
        send(client, chunk);
      }
    });

    term.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      for (const client of session.clients) {
        send(client, `\r\n\x1b[31mprocess ended (${exitCode ?? signal}); reconnecting…\x1b[0m\r\n`);
        client.close(1012, 'shell exited');
      }
    });

    this.sessions.set(id, session);
    return session;
  }
}

function normalizeInteger(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function send(ws, text) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(text);
}
