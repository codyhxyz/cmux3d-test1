import os from 'node:os';
import pty from 'node-pty';
import { HERDR_SESSIONS } from './herdr-state.js';
import { chooseShell, repairDarwinPtyHelper } from './shell.js';

const FACE_MIN = 0;
const FACE_MAX = 5;
const SLOT_MIN = 0;
const SLOT_MAX = 3;
const RESIZE_MAGIC = Buffer.from('CMUX');
const HISTORY_LIMIT = 1_000_000;

export class TerminalGrid {
  constructor({ cwd, shell, herdr } = {}) {
    repairDarwinPtyHelper();
    this.cwd = cwd || os.homedir();
    this.shell = chooseShell(shell);
    this.herdr = herdr;
    this.sessions = new Map();
  }

  attach(faceValue, slotValue, ws) {
    const face = normalizeInteger(faceValue, FACE_MIN, FACE_MAX);
    const slot = normalizeInteger(slotValue, SLOT_MIN, SLOT_MAX);
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
    });

    return { face, slot, sessionId: session.id };
  }

  closeAll() {
    for (const session of this.sessions.values()) {
      for (const client of session.clients) {
        try {
          client.close(1001, 'server shutdown');
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
    this.sessions.clear();
  }

  #getSession(face, slot) {
    const id = `${face}.${slot}`;
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const term = pty.spawn(
      this.herdr || this.shell,
      this.herdr ? ['--session', HERDR_SESSIONS[face]] : [],
      {
        name: 'xterm-256color',
        cols: 90,
        rows: 28,
        cwd: this.cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          CMUX3D_FACE: String(face),
          CMUX3D_SLOT: String(slot),
          CMUX3D_SESSION: id,
        },
      },
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
      this.sessions.delete(id);
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
