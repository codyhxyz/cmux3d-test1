import os from 'node:os';
import pty from 'node-pty';
import { clampFaceCount, DEFAULT_FACE_COUNT, DEFAULT_WORKSPACE, ensureCubeWorkspace, MAX_FACE_COUNT, readHerdrState } from './herdr-state.js';
import { chooseShell, repairDarwinPtyHelper, resolveExecutable } from './shell.js';

const FACE_MIN = 0;
// 0-based, so the last addressable face is the tenth — the AgentCore ceiling, not a
// number of our own choosing. See MAX_FACE_COUNT.
const FACE_MAX = MAX_FACE_COUNT - 1;
const SLOT_MIN = 0;
// Faces x slots is the addressable grid; the two bounds are independent and nothing
// here has ever assumed one from the other.
const SLOT_MAX = 3;
const RESIZE_MAGIC = Buffer.from('CUBE');
const HISTORY_LIMIT = 1_000_000;

export class TerminalGrid {
  constructor({ cwd, shell, herdr, workspace = DEFAULT_WORKSPACE, faceCount = DEFAULT_FACE_COUNT } = {}) {
    repairDarwinPtyHelper();
    this.cwd = cwd || os.homedir();
    this.shell = chooseShell(shell);
    this.herdr = resolveExecutable(herdr);
    this.workspace = workspace;
    this.targets = [];
    this.preparedAt = 0;
    this.workspaceReady = false;
    this.faceCount = clampFaceCount(faceCount).faces;
    if (herdr && !this.herdr) throw new Error(`executable not found: ${herdr}`);
    this.sessions = new Map();
  }

  // The count only ever grows. A browser that widens its cube asks for a face this
  // workspace has never had a tab for, and that request is the whole protocol on the
  // local path — there is no second endpoint to call. Narrowing it again is the
  // browser rendering fewer faces; the tabs stay, because one of them may hold an
  // agent mid-task.
  async prepare(faceCount = this.faceCount) {
    // The current count is the fallback, so a nonsense argument can only leave the
    // workspace as wide as it already is — never narrow it. Raised before queueing, so
    // the runs below can only ever see the width grow.
    const wanted = clampFaceCount(Math.max(faceCount, this.faceCount), this.faceCount).faces;
    const grew = wanted > this.faceCount;
    this.faceCount = wanted;
    if (!this.herdr) return;
    // Widening the cube reconnects every face at once, so ten of these arrive together
    // asking for ten different widths. Overlapping them lets a plain snapshot read land
    // between a widening and its result and publish the SHORTER target list, which
    // leaves faces 7..10 with "no terminal on this host". One at a time, in the order
    // they asked, so the last word always belongs to the widest request.
    this.preparing = (this.preparing ?? Promise.resolve())
      .then(() => this.#prepareOnce(wanted, grew), () => this.#prepareOnce(wanted, grew));
    return this.preparing;
  }

  async #prepareOnce(wanted, grew) {
    // A face with no terminal id yet is the one case the throttle must not swallow.
    if (!grew && Date.now() - this.preparedAt < 1000) return;
    const state = this.workspaceReady && !grew
      ? await readHerdrState(this.herdr, this.workspace)
      : await ensureCubeWorkspace(this.herdr, this.workspace, this.cwd, wanted);
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
    await this.prepare(face + 1);
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

    // Named rather than spawned with an undefined argument: without this a face whose
    // tab could not be created reaches node-pty as `herdr terminal attach undefined`,
    // and the browser is told the shell exited instead of what actually happened.
    if (this.herdr && !this.targets[face]) throw new Error(`face ${face + 1} has no terminal on this host`);

    const env = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CODING_CUBE_FACE: String(face),
      CODING_CUBE_SLOT: String(slot),
      CODING_CUBE_SESSION: id,
    };
    for (const key of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_TAB_ID']) delete env[key];

    // --takeover is not optional. Closing a socket kills this PTY, but the herdr
    // side of the attach takes a moment longer to let go, and herdr refuses a
    // second attach in that window: "terminal <id> already has an attached client;
    // retry with --takeover". Measured on a live container — reconnecting to a face
    // with no gap after disconnecting returned 548 bytes of that refusal, the PTY
    // exited 1, and the socket closed 1012 "shell exited" instead of showing the
    // terminal. A browser page reload is exactly that sequence, so without this a
    // refresh reliably kills the face it reloads.
    //
    // Takeover is also the right semantics rather than a workaround: the gateway is
    // the only thing that ever attaches to the cube's terminals, so a client already
    // holding one is always a stale attach that has not finished dying, never a
    // second user whose session we would be stealing.
    //
    // The flag goes AFTER the terminal id even though `herdr terminal attach --help`
    // prints `[OPTIONS] <TERMINAL_ID>`. Measured: the documented order makes herdr
    // exit 2 with "unknown option: term_…" and the face never opens at all.
    const term = pty.spawn(
      this.herdr || this.shell,
      this.herdr ? ['--session', 'default', 'terminal', 'attach', this.targets[face], '--takeover'] : [],
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
