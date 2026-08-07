// A transport is everything the fleet needs from a backend: a socket per face and
// a resize frame. Today's origin+token host and an AgentCore runtime look nothing
// alike on the wire, so the difference is confined here rather than smeared
// through terminals.js.

import { activeHost, hostHttp, hostWebSocket } from './connection.js';

/**
 * @typedef {Object} CubeSocket  Structural subset of WebSocket that AttachAddon and TerminalFleet require.
 * @property {'arraybuffer'|'blob'} binaryType
 * @property {0|1|2|3} readyState
 * @property {(data: string|ArrayBufferLike|ArrayBufferView) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {(type: 'open'|'message'|'close'|'error', fn: Function) => void} addEventListener
 * @property {(type: string, fn: Function) => void} removeEventListener
 */

/**
 * @typedef {Object} CubeTransport
 * @property {string} id
 * @property {string} name
 * @property {(face: number, slot: number) => CubeSocket} openTerminal  face is 0..5, Cube-native
 * @property {(cols: number, rows: number) => CubeControlFrame} encodeResize
 * @property {() => Promise<{ok: boolean, reason?: string}>} probe
 */

const STDIN = 0x00;
const STDOUT = 0x01;
const STDERR = 0x02;
const STATUS = 0x03;
const RESIZE = 0x04;
const HEARTBEAT = 0x05;
const SHUTDOWN = 0xff;

// AgentCore's 256 KB replay buffer carries output missed *while disconnected*, not the
// screen, so a fresh tab attaching to a live workspace gets nothing (measured: a marker
// echoed before a drop was absent after reconnect). These bound a browser-local copy of
// each face's tail: six faces at 48k characters is ~576 KB of UTF-16 in localStorage,
// well inside the 5 MB every engine allows, and the record cap stops old sessions from
// accumulating forever.
const SCROLLBACK_NAMESPACE = 'coding-cube.scrollback.v1';
const SCROLLBACK_MAX_CHARS = 48_000;
const SCROLLBACK_MAX_RECORDS = 12;
const SCROLLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const SCROLLBACK_FLUSH_MS = 1500;

const SHELL_FRAME_MAX = 65_536;
const SHELL_PAYLOAD_MAX = SHELL_FRAME_MAX - 1;
const PASSTHROUGH_FRAME_MAX = 32_768;
// 250 frames/sec is the documented ceiling and the penalty is close 1008, so frames
// leave on a token clock one at a time. A wider coalescing window makes each frame
// fuller; it does not bound the burst, so it cannot be the rate limit.
const FRAME_RATE = 200;
const FRAME_INTERVAL_MS = 1000 / FRAME_RATE;
const COALESCE_MS = 4;
const CONFIRM_MS = 20_000;
const AWS_LOGIN_REQUIRED = 'AWS_LOGIN_REQUIRED';
const SESSION_ID_MIN = 33;
const SESSION_ID_MAX = 256;
const SHELL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

const { CONNECTING = 0, OPEN = 1, CLOSED = 3 } = globalThis.WebSocket || {};
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

// A resize frame and a Ctrl-D keystroke both start with 0x04, so the frame type
// has to be carried by the object. `instanceof` is unambiguous; a byte is not.
export class CubeControlFrame extends Uint8Array {}

// runtimeSessionId has a 33-character minimum, so a bare UUID is not enough.
export function createSessionId(prefix = 'cube-spike-') {
  const id = `${prefix}${crypto.randomUUID()}`;
  if (id.length < SESSION_ID_MIN || id.length > SESSION_ID_MAX) {
    throw new RangeError(`runtimeSessionId must be ${SESSION_ID_MIN}-${SESSION_ID_MAX} characters; got ${id.length}`);
  }
  return id;
}

/** Today's path, unchanged: a real WebSocket and the 8-byte big-endian CUBE frame. */
export function createOriginTransport(host = activeHost()) {
  return {
    id: host.origin,
    name: host.name,
    openTerminal(face, slot = 0) {
      return new WebSocket(hostWebSocket(`/ws/pty?face=${face}&slot=${slot}`));
    },
    encodeResize: cubeResizeFrame,
    async probe() {
      try {
        const response = await fetch(hostHttp('/health'), { signal: AbortSignal.timeout(3000) });
        if (response.status === 401) return { ok: false, reason: 'unauthorized' };
        return response.ok ? { ok: true } : { ok: false, reason: 'unreachable' };
      } catch {
        return { ok: false, reason: 'unreachable' };
      }
    },
  };
}

/** Native InvokeAgentRuntimeCommandShell. faceOffset 1 => shellId "face-1".."face-6". */
export function createShellTransport({
  mintUrl,
  ensureWorkspace,
  sessionId = createSessionId(),
  faceOffset = 1,
  heartbeatMs = 30_000,
  size = { cols: 80, rows: 24 },
  bootstrapCommand = (shell) => `exec /usr/local/bin/cube-face ${shell}\n`,
  scrollback = createScrollbackStore({ sessionId }),
  name = 'AgentCore shell',
} = {}) {
  if (typeof mintUrl !== 'function') throw new TypeError('createShellTransport needs mintUrl(shellId, sessionId)');
  // Measured, not guessed: /mnt/workspace does not exist for a session whose only
  // activity is a shell connection — it materialises on the first /invocations call.
  // A shell opened before that runs with no session storage and loses everything when
  // the microVM is evicted, silently. So this is a constructor argument, not a step the
  // caller is trusted to remember, and openTerminal() awaits it on every face.
  if (typeof ensureWorkspace !== 'function') {
    throw new TypeError(
      'createShellTransport needs ensureWorkspace(): /mnt/workspace only materialises on the first '
        + '/invocations call, so a shell opened before it has no persistent storage and loses all work at idle timeout',
    );
  }
  if (sessionId.length < SESSION_ID_MIN || sessionId.length > SESSION_ID_MAX) {
    throw new RangeError(`runtimeSessionId must be ${SESSION_ID_MIN}-${SESSION_ID_MAX} characters; got ${sessionId.length}`);
  }

  const workspace = createWorkspaceGate(ensureWorkspace);

  return {
    id: `agentcore:${sessionId}`,
    name,
    sessionId,
    workspace,
    scrollback,
    shellIdFor: (face, slot = 0) => shellIdFor(face, slot, faceOffset),
    terminalIdFor: (face) => workspace.state?.terminals.get(face) ?? null,
    /** The browser-local tail for a face, or null when there is nothing to restore. */
    history(face, slot = 0) {
      return scrollback?.begin(shellIdFor(face, slot, faceOffset)) ?? null;
    },
    /** Restore before the live stream starts; returns the record it wrote, or null. */
    restoreInto(term, face, slot = 0) {
      const record = this.history(face, slot);
      return writeRestoredHistory(term, record) ? record : null;
    },
    openTerminal(face, slot = 0, geometry = size) {
      const shellId = shellIdFor(face, slot, faceOffset);
      return new ShellSocket({
        shellId,
        heartbeatMs,
        size: geometry,
        scrollback,
        prepare: () => workspace.ready(),
        mint: () => mintUrl(shellId, sessionId),
        bootstrap: bootstrapCommand(face + faceOffset),
      });
    },
    encodeResize: shellResizeFrame,
    // Presigning is local crypto against no AWS API, so this proves the auth path
    // without opening a shell and consuming one of the ten.
    async probe() {
      try {
        const url = await mintUrl(shellIdFor(0, 0, faceOffset), sessionId);
        return url ? { ok: true } : { ok: false, reason: 'mint returned no url' };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
  };
}

/**
 * One /invocations call per transport, shared by all six faces and awaited by each of
 * them. A rejection is deliberately not cached: no shell may open until one succeeds,
 * but the next face must be allowed to try again.
 */
export function createWorkspaceGate(ensureWorkspace) {
  let settled = null;
  let pending = null;
  return {
    get state() {
      return settled;
    },
    ready() {
      if (settled) return Promise.resolve(settled);
      if (!pending) {
        pending = (async () => ensureWorkspace())()
          .then((result) => {
            settled = normalizeWorkspace(result);
            pending = null;
            return settled;
          })
          .catch((error) => {
            pending = null;
            throw error;
          });
      }
      return pending;
    },
    reset() {
      settled = null;
      pending = null;
    },
  };
}

function normalizeWorkspace(result) {
  const faces = Array.isArray(result?.faces) ? result.faces : [];
  const terminals = new Map();
  faces.forEach((entry, index) => {
    const face = Number.isFinite(entry?.face) ? entry.face : index;
    if (entry?.terminalId) terminals.set(face, entry.terminalId);
  });
  return {
    state: typeof result?.state === 'string' ? result.state : 'unknown',
    ready: result?.state === 'ready',
    faces,
    terminals,
    // Only an explicit false is a warning: an older gateway that reports no
    // persistence block must not be painted as ephemeral.
    durable: result?.persistence?.durable !== false,
    warning: typeof result?.warning === 'string' ? result.warning : null,
    raw: result ?? null,
  };
}

/** InvokeAgentRuntimeWithWebSocketStream, proxied straight to the container's own /ws. */
export function createPassthroughTransport({
  mintUrl,
  sessionId = createSessionId(),
  faceOffset = 0,
  name = 'AgentCore passthrough',
} = {}) {
  if (typeof mintUrl !== 'function') throw new TypeError('createPassthroughTransport needs mintUrl(sessionId)');

  return {
    id: `agentcore-ws:${sessionId}`,
    name,
    sessionId,
    openTerminal(face, slot = 0) {
      return new PassthroughSocket({
        mint: () => mintUrl(sessionId),
        greeting: JSON.stringify({ face: face + faceOffset, slot }),
      });
    },
    encodeResize: cubeResizeFrame,
    async probe() {
      try {
        const url = await mintUrl(sessionId);
        return url ? { ok: true } : { ok: false, reason: 'mint returned no url' };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
  };
}

// The shell speaks [1-byte channel][payload]. Reconnection is deliberately NOT
// handled here: the fleet already owns one backoff loop keyed on the face, and
// shellId is derived from the face, so re-opening lands on the same PTY. Two
// loops would race each other into close 4000.
class ShellSocket {
  #events = createEmitter();
  #ws = null;
  #bootstrap;
  #heartbeatMs;
  #size;
  #stdin = [];
  #stdinBytes = 0;
  #frames = [];
  #coalesceTimer = 0;
  #pumpTimer = 0;
  #nextFrameAt = 0;
  #heartbeatTimer = 0;
  #confirmTimer = 0;
  #confirmed = false;
  #ended = false;
  #scrollback;
  #key;
  #decoder = new TextDecoder();

  constructor({ mint, prepare, bootstrap, heartbeatMs, size, shellId, scrollback = null }) {
    this.binaryType = 'arraybuffer';
    this.readyState = CONNECTING;
    this.shellId = shellId;
    this.reconnected = false;
    this.bytesDropped = 0;
    this.statusError = null;
    this.#bootstrap = bootstrap;
    this.#heartbeatMs = heartbeatMs;
    this.#size = size;
    this.#scrollback = scrollback;
    // The storage key is the shellId this socket was constructed for, never the one a
    // status frame reports, so a surprising echo cannot orphan a face's history.
    this.#key = shellId;
    this.#scrollback?.begin(shellId);
    this.#connect(mint, prepare);
  }

  addEventListener(type, fn) {
    this.#events.add(type, fn);
  }

  removeEventListener(type, fn) {
    this.#events.remove(type, fn);
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    if (data instanceof CubeControlFrame) this.#queueFrame(data);
    else this.#queueStdin(toBytes(data));
  }

  close(code = 1000, reason = '') {
    this.#end(code, reason);
  }

  async #connect(mint, prepare) {
    // Ordering, enforced rather than documented: no socket is minted until the
    // /invocations call that materialises /mnt/workspace has returned. Opening the
    // shell first would give the user a working terminal on storage that evaporates.
    try {
      await prepare();
    } catch (error) {
      this.#end(1006, `workspace not ready: ${error.message}`, error.code === AWS_LOGIN_REQUIRED);
      return;
    }
    if (this.#ended) return;

    let url;
    try {
      url = await mint();
    } catch (error) {
      // A dead minter is transient. Expired AWS login is not: only the Retry button
      // should ask again after the operator has run `aws login`.
      this.#end(1006, `mint failed: ${error.message}`, error.code === AWS_LOGIN_REQUIRED);
      return;
    }
    if (this.#ended) return;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.addEventListener('message', (event) => this.#receive(event.data));
    ws.addEventListener('close', (event) => this.#end(event.code, event.reason));
    // A socket error is always followed by a close; one close event is the contract.
    ws.addEventListener('error', () => {});
    this.#confirmTimer = setTimeout(() => this.#end(1006, 'no status frame'), CONFIRM_MS);
  }

  #receive(data) {
    if (!data || typeof data === 'string') return;
    const frame = new Uint8Array(data);
    if (!frame.length) return;
    const payload = frame.subarray(1);
    if (frame[0] === STDOUT || frame[0] === STDERR) {
      // Streaming decode: a frame boundary can fall inside a multi-byte sequence, and
      // a per-frame decoder would persist a U+FFFD where an emoji was.
      this.#scrollback?.push(this.#key, this.#decoder.decode(payload, { stream: true }));
      this.#events.emit({ type: 'message', data: payload.slice().buffer });
    }
    else if (frame[0] === STATUS) this.#status(payload);
    // A server-sent CLOSE is the platform evicting the microVM. That is the sleep
    // signal, not a fault, and it must reach the interface.
    else if (frame[0] === SHUTDOWN) this.#end(1001, 'vm-evicted');
  }

  // Mirrors parseStatusFrame() in spike/harness/shell-client.mjs: the same bytes must
  // classify the same way in both implementations.
  #status(payload) {
    let status = null;
    try {
      status = JSON.parse(decoder.decode(payload));
    } catch {
      // Diagnostics only; a malformed status must not take the face down.
    }
    if (!status) return;
    const metadata = status.metadata;
    if (typeof metadata?.shellId === 'string') {
      // A second confirmation arrives once the 256 KB replay buffer has drained. It
      // carries bytesDropped and no `reconnected`, so it is neither a termination nor
      // permission to forget what the first frame said.
      if (this.#confirmed) this.#observe(metadata);
      else this.#confirm(metadata);
      return;
    }
    const cause = status.details?.causes?.find(({ reason }) => reason === 'ExitCode' || reason === 'Signal');
    if (cause) {
      this.#end(1000, `${cause.reason} ${cause.message}`);
      return;
    }
    if (status.status === 'Success') {
      this.#end(1000, status.reason || 'shell ended');
      return;
    }
    // Everything else is informational — a Failure report, or a status this client does
    // not know yet. Only a positively-identified termination may end the face; the
    // service closes the socket itself when the shell is actually gone.
    this.statusError = status.reason || status.message || null;
  }

  // Latching, not assignment: the first confirmation carries `reconnected` and no
  // bytesDropped, the post-drain one carries the reverse.
  #observe(metadata) {
    if (typeof metadata.shellId === 'string') this.shellId = metadata.shellId;
    if (metadata.reconnected === true) this.reconnected = true;
    if (Number.isFinite(metadata.bytesDropped)) this.bytesDropped = metadata.bytesDropped;
  }

  #confirm(metadata) {
    clearTimeout(this.#confirmTimer);
    this.#confirmed = true;
    this.#observe(metadata);

    // Geometry first so the bootstrap line runs in a correctly sized PTY. This is also
    // the order shell-client.mjs puts on the wire, where the resize skips the stdin
    // coalescing buffer.
    this.#queueFrame(shellResizeFrame(this.#size.cols, this.#size.rows));
    // A reconnected PTY is already inside `herdr terminal attach`; re-sending the
    // bootstrap line would type it into whatever the agent is doing.
    if (!this.reconnected && this.#bootstrap) this.#queueStdin(encoder.encode(this.#bootstrap));
    this.#flush();

    if (this.#heartbeatMs) {
      // Browsers cannot send RFC 6455 pings, and a quiet face is dropped at the
      // proxy's ~15 minute idle timeout.
      this.#heartbeatTimer = setInterval(() => this.send(controlFrame(HEARTBEAT, EMPTY)), this.#heartbeatMs);
    }
    // AttachAddon throws — not warns — when readyState is not OPEN, and it reads
    // it from a term.onData handler, so this must be true before any listener can
    // be handed a keystroke.
    this.readyState = OPEN;
    this.#events.emit({ type: 'open' });
  }

  #queueStdin(bytes) {
    if (!bytes.length) return;
    this.#stdin.push(bytes);
    this.#stdinBytes += bytes.length;
    // A full frame is already decided; waiting out the window only delays a paste.
    if (this.#stdinBytes >= SHELL_PAYLOAD_MAX) this.#flush();
    else this.#schedule();
  }

  #queueFrame(frame) {
    this.#drainStdin();
    this.#frames.push(frame);
    this.#schedule();
  }

  #drainStdin() {
    if (!this.#stdin.length) return;
    const bytes = concat(this.#stdin);
    this.#stdin = [];
    this.#stdinBytes = 0;
    for (const chunk of chunks(bytes, SHELL_PAYLOAD_MAX)) this.#frames.push(controlFrame(STDIN, chunk));
  }

  #schedule() {
    if (this.#coalesceTimer) return;
    this.#coalesceTimer = setTimeout(() => {
      this.#coalesceTimer = 0;
      this.#flush();
    }, COALESCE_MS);
  }

  #flush() {
    clearTimeout(this.#coalesceTimer);
    this.#coalesceTimer = 0;
    this.#drainStdin();
    this.#pump();
  }

  // One frame per FRAME_INTERVAL_MS. Draining the queue in a single loop is what
  // turns a 20 MB paste into 300+ frames in the same millisecond and earns a 1008.
  #pump() {
    if (this.#pumpTimer || !this.#frames.length) return;
    if (this.#ws?.readyState !== OPEN) {
      // Same call as shell-client's sendRaw: a frame that cannot be sent is dropped
      // rather than queued behind a socket that may never open.
      this.#frames = [];
      return;
    }
    const now = Date.now();
    if (now < this.#nextFrameAt) {
      this.#pumpTimer = setTimeout(() => {
        this.#pumpTimer = 0;
        this.#pump();
      }, this.#nextFrameAt - now);
      return;
    }
    this.#nextFrameAt = Math.max(now, this.#nextFrameAt) + FRAME_INTERVAL_MS;
    this.#ws.send(this.#frames.shift());
    if (this.#frames.length) this.#pump();
  }

  #end(code, reason, permanent = false) {
    if (this.#ended) return;
    this.#ended = true;
    this.readyState = CLOSED;
    clearTimeout(this.#coalesceTimer);
    clearTimeout(this.#pumpTimer);
    clearTimeout(this.#confirmTimer);
    clearInterval(this.#heartbeatTimer);
    // A dropped face is exactly when the tail must already be on disk: the retry may
    // be a reload, and the throttled flush would never have fired.
    this.#scrollback?.flush();
    try {
      this.#ws?.close();
    } catch {
      // Already closing.
    }
    this.#events.emit({ type: 'close', code: permanent ? 1011 : stopCode(code), reason: reason || '' });
  }
}

// The passthrough carries the container's own /ws bytes untouched, so the only
// work here is deferring the open until a URL has been minted.
class PassthroughSocket {
  #events = createEmitter();
  #ws = null;
  #greeting;
  #ended = false;

  constructor({ mint, greeting }) {
    this.binaryType = 'arraybuffer';
    this.readyState = CONNECTING;
    this.#greeting = greeting;
    this.#connect(mint);
  }

  addEventListener(type, fn) {
    this.#events.add(type, fn);
  }

  removeEventListener(type, fn) {
    this.#events.remove(type, fn);
  }

  send(data) {
    if (this.readyState !== OPEN || this.#ws?.readyState !== OPEN) return;
    // Text and binary mean different things to the container: text is written to
    // the PTY as-is, binary is decoded latin1. Keep strings as strings.
    if (typeof data === 'string') {
      for (let at = 0; at < data.length; at += 8192) this.#ws.send(data.slice(at, at + 8192));
      return;
    }
    if (data instanceof CubeControlFrame) {
      this.#ws.send(data);
      return;
    }
    for (const chunk of chunks(toBytes(data), PASSTHROUGH_FRAME_MAX)) this.#ws.send(chunk);
  }

  close(code = 1000, reason = '') {
    this.#end(code, reason);
  }

  async #connect(mint) {
    let url;
    try {
      url = await mint();
    } catch (error) {
      this.#end(1006, `mint failed: ${error.message}`, error.code === AWS_LOGIN_REQUIRED);
      return;
    }
    if (this.#ended) return;

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.addEventListener('open', () => {
      // Query parameters may not survive the proxy and a presigned URL cannot be
      // amended without breaking its signature, so routing rides on a first frame.
      ws.send(this.#greeting);
      this.readyState = OPEN;
      this.#events.emit({ type: 'open' });
    });
    ws.addEventListener('message', (event) => this.#events.emit({ type: 'message', data: event.data }));
    ws.addEventListener('close', (event) => this.#end(event.code, event.reason));
    ws.addEventListener('error', () => {});
  }

  #end(code, reason, permanent = false) {
    if (this.#ended) return;
    this.#ended = true;
    this.readyState = CLOSED;
    try {
      this.#ws?.close();
    } catch {
      // Already closing.
    }
    this.#events.emit({ type: 'close', code: permanent ? 1011 : stopCode(code), reason: reason || '' });
  }
}

/**
 * Browser-local scrollback, keyed by (runtimeSessionId, shellId).
 *
 * The session id is part of the key rather than a field to compare, so restoring another
 * session's screen is not a bug that can happen: a different session simply finds no
 * record. Returns null when there is no usable storage — persistence is best-effort and
 * must never be able to break a terminal.
 */
export function createScrollbackStore({ sessionId, storage = defaultStorage(), ...options } = {}) {
  if (!sessionId) throw new TypeError('createScrollbackStore needs the runtimeSessionId it is keyed by');
  if (!storage) return null;
  return new ScrollbackStore({ sessionId, storage, ...options });
}

function defaultStorage() {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    // Safari's private mode throws on write, not on access, so probing has to write.
    const probe = `${SCROLLBACK_NAMESPACE}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

class ScrollbackStore {
  #storage;
  #sessionId;
  #namespace;
  #maxChars;
  #maxRecords;
  #ttlMs;
  #flushMs;
  #now;
  #buffers = new Map();
  #timer = 0;
  #listening = false;

  constructor({
    storage,
    sessionId,
    namespace = SCROLLBACK_NAMESPACE,
    maxChars = SCROLLBACK_MAX_CHARS,
    maxRecords = SCROLLBACK_MAX_RECORDS,
    ttlMs = SCROLLBACK_TTL_MS,
    flushMs = SCROLLBACK_FLUSH_MS,
    now = () => Date.now(),
  }) {
    this.#storage = storage;
    this.#sessionId = sessionId;
    this.#namespace = namespace;
    this.#maxChars = maxChars;
    this.#maxRecords = maxRecords;
    this.#ttlMs = ttlMs;
    this.#flushMs = flushMs;
    this.#now = now;
    this.prune();
  }

  get sessionId() {
    return this.#sessionId;
  }

  /**
   * Adopt a shell's stored tail as the live buffer. Idempotent, and called from the
   * socket constructor as well as from history(), so the next flush extends what is
   * already stored instead of replacing it with only the output of this connection.
   */
  begin(shellId) {
    let buffer = this.#buffers.get(shellId);
    if (!buffer) {
      const entry = this.#entries().find((record) => record.shellId === shellId && record.sessionId === this.#sessionId);
      const text = entry ? this.#get(this.#dataKey(shellId)) : null;
      buffer = { parts: text ? [text] : [], chars: text ? text.length : 0, savedAt: entry?.savedAt ?? null, dirty: false };
      this.#buffers.set(shellId, buffer);
    }
    return this.#record(shellId, buffer);
  }

  read(shellId) {
    return this.begin(shellId);
  }

  push(shellId, text) {
    if (!text) return;
    if (!this.#buffers.has(shellId)) this.begin(shellId);
    const buffer = this.#buffers.get(shellId);
    buffer.parts.push(text);
    buffer.chars += text.length;
    buffer.dirty = true;
    // Joining every push is O(n²) on a busy face; collapse only when the parts list
    // has drifted well past what will ever be written.
    if (buffer.chars > this.#maxChars * 3) this.#collapse(buffer);
    this.#schedule();
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = 0;
    for (const [shellId, buffer] of this.#buffers) {
      if (!buffer.dirty) continue;
      const text = this.#collapse(buffer);
      buffer.dirty = false;
      if (!text) continue;
      const stored = this.#persist(shellId, text);
      if (stored === null) continue;
      buffer.parts = [stored];
      buffer.chars = stored.length;
      buffer.savedAt = this.#now();
      this.#upsert(shellId, stored.length, buffer.savedAt);
    }
  }

  clear(shellId) {
    this.#buffers.delete(shellId);
    this.#remove(this.#dataKey(shellId));
    this.#writeEntries(this.#entries().filter((entry) => !(entry.shellId === shellId && entry.sessionId === this.#sessionId)));
  }

  /** Drop expired and surplus records so six faces cannot grow into a quota failure. */
  prune() {
    const cutoff = this.#now() - this.#ttlMs;
    const kept = [];
    const dropped = [];
    for (const entry of this.#entries().sort((a, b) => b.savedAt - a.savedAt)) {
      const stale = !(entry.savedAt > cutoff);
      const surplus = kept.length >= this.#maxRecords;
      if (stale || surplus || this.#get(this.#key(entry.sessionId, entry.shellId)) === null) dropped.push(entry);
      else kept.push(entry);
    }
    if (!dropped.length) return kept.length;
    for (const entry of dropped) this.#remove(this.#key(entry.sessionId, entry.shellId));
    this.#writeEntries(kept);
    return kept.length;
  }

  dispose() {
    this.flush();
    clearTimeout(this.#timer);
    this.#timer = 0;
  }

  #record(shellId, buffer) {
    const text = this.#collapse(buffer);
    if (!text) return null;
    const savedAt = buffer.savedAt ?? this.#now();
    return { shellId, sessionId: this.#sessionId, text, chars: text.length, savedAt, ageMs: Math.max(0, this.#now() - savedAt) };
  }

  #collapse(buffer) {
    const text = tailFrom(buffer.parts.length === 1 ? buffer.parts[0] : buffer.parts.join(''), this.#maxChars);
    buffer.parts = text ? [text] : [];
    buffer.chars = text.length;
    return text;
  }

  #schedule() {
    this.#listen();
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = 0;
      this.flush();
    }, this.#flushMs);
    // Node runs this store in tests; an outstanding throttle must not hold the loop open.
    this.#timer?.unref?.();
  }

  #listen() {
    if (this.#listening || typeof globalThis.addEventListener !== 'function') return;
    this.#listening = true;
    // pagehide is the only teardown iOS Safari reliably fires; the throttle would
    // otherwise lose the last second and a half of every session.
    globalThis.addEventListener('pagehide', () => this.flush());
    globalThis.addEventListener('visibilitychange', () => {
      if (globalThis.document?.visibilityState === 'hidden') this.flush();
    });
  }

  #persist(shellId, text) {
    const key = this.#dataKey(shellId);
    let value = text;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.#storage.setItem(key, value);
        return value;
      } catch {
        // A quota failure is recoverable: another session's records are worthless, and
        // a quarter of this face's history beats none of it.
        if (attempt === 0) this.#evictOtherSessions();
        else if (attempt === 1) value = tailFrom(value, Math.max(1024, Math.floor(value.length / 4)));
        else this.#remove(key);
      }
    }
    return null;
  }

  #evictOtherSessions() {
    const mine = [];
    for (const entry of this.#entries()) {
      if (entry.sessionId === this.#sessionId) mine.push(entry);
      else this.#remove(this.#key(entry.sessionId, entry.shellId));
    }
    this.#writeEntries(mine);
  }

  #upsert(shellId, chars, savedAt) {
    const entries = this.#entries().filter((entry) => !(entry.shellId === shellId && entry.sessionId === this.#sessionId));
    entries.push({ sessionId: this.#sessionId, shellId, chars, savedAt });
    this.#writeEntries(entries);
  }

  #entries() {
    try {
      const parsed = JSON.parse(this.#storage.getItem(`${this.#namespace}:index`) ?? '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry) => entry && typeof entry.sessionId === 'string' && typeof entry.shellId === 'string')
        .map((entry) => ({ ...entry, savedAt: Number(entry.savedAt) || 0, chars: Number(entry.chars) || 0 }));
    } catch {
      return [];
    }
  }

  #writeEntries(entries) {
    try {
      this.#storage.setItem(`${this.#namespace}:index`, JSON.stringify(entries));
    } catch {
      // The index is a cleanup aid, not the data; losing it costs a prune, not a face.
    }
  }

  #key(sessionId, shellId) {
    return `${this.#namespace}:d:${sessionId}:${shellId}`;
  }

  #dataKey(shellId) {
    return this.#key(this.#sessionId, shellId);
  }

  #get(key) {
    try {
      return this.#storage.getItem(key);
    } catch {
      return null;
    }
  }

  #remove(key) {
    try {
      this.#storage.removeItem(key);
    } catch {
      // Nothing to undo.
    }
  }
}

// Cutting a fixed number of characters off the front lands inside an escape sequence
// often enough to matter, and half a CSI renders as literal garbage. Resume at the first
// line boundary instead.
function tailFrom(text, maxChars) {
  if (text.length <= maxChars) return text;
  const cut = text.length - maxChars;
  const newline = text.indexOf('\n', cut);
  return newline === -1 ? text.slice(cut) : text.slice(newline + 1);
}

/**
 * Write a restored tail into a terminal, fenced above and below so the user can never
 * mistake it for live output. Returns false when there is nothing to restore, which is
 * the caller's signal that a blank screen is the truth.
 */
export function writeRestoredHistory(term, record) {
  if (!record?.text) return false;
  const width = Math.max(24, Math.min(term.cols || 80, 120));
  term.write(`\x1b[0m${rule(width, `restored history · ${formatChars(record.chars)} · saved ${formatAge(record.ageMs)} ago · NOT live`)}\r\n`);
  // Alternate-screen switches are dropped rather than replayed: leaving them in strands
  // the terminal in the alt buffer, and the matching ?1049l performs a cursor restore
  // that lands the closing fence on top of the history it is supposed to close. Measured
  // in headless Chromium — the first two rows were the two fences and the screen was gone.
  term.write(record.text.replace(/\x1b\[\?(?:1049|1047|47)[hl]/g, ''));
  term.write(`\x1b[0m\r\n${rule(width, 'live output starts here')}\r\n`);
  return true;
}

function rule(width, label) {
  const text = ` ${label} `;
  const trailing = Math.max(2, width - text.length - 2);
  return `\x1b[90m──${text}${'─'.repeat(trailing)}\x1b[0m`;
}

function formatChars(chars) {
  return chars < 1024 ? `${chars} chars` : `${Math.round(chars / 1024)} KB`;
}

function formatAge(ageMs) {
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 90) return `${Math.max(1, seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

function shellIdFor(face, slot, faceOffset) {
  // Only slot 0 fits the ten-shells-per-runtime ceiling, but the id stays
  // deterministic either way so a reload reclaims its shells instead of doubling
  // them and fighting itself with close 4000.
  const id = slot ? `face-${face + faceOffset}-slot-${slot}` : `face-${face + faceOffset}`;
  if (!SHELL_ID.test(id)) throw new RangeError(`invalid shellId: ${id}`);
  return id;
}

function shellResizeFrame(cols, rows) {
  // A fit addon can hand back a fraction, and {"width":79.5} is not a geometry.
  const width = Math.max(1, Math.floor(cols));
  const height = Math.max(1, Math.floor(rows));
  return controlFrame(RESIZE, encoder.encode(JSON.stringify({ width, height })));
}

function cubeResizeFrame(cols, rows) {
  const frame = new CubeControlFrame(8);
  const view = new DataView(frame.buffer);
  view.setUint32(0, 0x43554245); // CUBE
  view.setUint16(4, cols);
  view.setUint16(6, rows);
  return frame;
}

function controlFrame(channel, payload) {
  const frame = new CubeControlFrame(payload.length + 1);
  frame[0] = channel;
  frame.set(payload, 1);
  return frame;
}

// terminals.js treats only 1011 as permanent. 1003 (a text frame), 1009 (a frame over
// 64 KB) and 4000 (another client holds this shellId) all repeat identically on retry,
// which is the same set shell-client.mjs's classifyCloseCode() refuses to reconnect.
// 1000 stays retryable on purpose: for a six-face grid a shell that exited should be
// re-attached, and the deterministic shellId lands the retry on the same PTY.
function stopCode(code) {
  if (code === 1003 || code === 1009 || code === 4000) return 1011;
  // A server-sent 1011 is transient and must be retried, but it collides with the
  // sentinel above, so it arrives as 1012 instead of reading as permanent.
  if (code === 1011) return 1012;
  return code;
}

function toBytes(data) {
  if (typeof data === 'string') return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

function concat(parts) {
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function* chunks(bytes, max) {
  for (let at = 0; at < bytes.length; at += max) yield bytes.subarray(at, at + max);
}

function createEmitter() {
  const listeners = new Map();
  return {
    add(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    remove(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(event) {
      for (const fn of [...(listeners.get(event.type) || [])]) fn(event);
    },
  };
}
