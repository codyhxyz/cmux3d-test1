// InvokeAgentRuntimeCommandShell wire protocol. AWS publishes no API reference page
// and no JS client for this operation (@aws-sdk/client-bedrock-agentcore has zero
// hits for "CommandShell"), so the framing below is transcribed from the two
// first-party implementations that agree byte-for-byte: bedrock-agentcore 1.20.0
// (Python) and @aws/agentcore 0.26.0 (npm). The operational envelope — frame cap,
// frame rate, TTL, close codes — IS documented and is enforced here.
//
// Kept free of node: imports above the "Node-only" section so the browser adapter
// can import the same framing, presign and connection logic.

import {
  CONNECTION_TTL_MS,
  decodeFrame,
  DEFAULT_FRAME_RATE,
  encodeClose,
  encodeHeartbeat,
  encodeResize,
  encodeStdin,
  FRAME_RATE_CEILING,
  HEARTBEAT_INTERVAL_MS,
  MAX_PAYLOAD_SIZE,
  MAX_PRESIGN_EXPIRY_SECONDS,
  parseStatusFrame,
  RECONNECT_WINDOW_MS,
  REPLAY_BUFFER_BYTES,
  SHELL_CHANNEL,
  ShellProtocolError,
  toBytes,
  validateSessionId,
  validateShellId,
} from '../../public/app/agentcore-protocol.js';

export {
  CONNECTION_TTL_MS,
  CubeControlFrame,
  decodeFrame,
  DEFAULT_FRAME_RATE,
  encodeClose,
  encodeFrame,
  encodeHeartbeat,
  encodeResize,
  encodeStdin,
  FRAME_RATE_CEILING,
  HEARTBEAT_INTERVAL_MS,
  MAX_FRAME_SIZE,
  MAX_PAYLOAD_SIZE,
  MAX_PRESIGN_EXPIRY_SECONDS,
  MAX_SESSION_ID_LENGTH,
  MIN_SESSION_ID_LENGTH,
  parseStatusFrame,
  RECONNECT_WINDOW_MS,
  REPLAY_BUFFER_BYTES,
  SHELL_CHANNEL,
  SHELL_ID_PATTERN,
  ShellProtocolError,
  toBytes,
  validateSessionId,
  validateShellId,
} from '../../public/app/agentcore-protocol.js';

const SESSION_ID_PARAM = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const textEncoder = new TextEncoder();

export class MissingDependencyError extends Error {
  constructor(specifier, hint) {
    super(`${specifier} is not installed. ${hint}`);
    this.name = 'MissingDependencyError';
    this.specifier = specifier;
  }
}

export function newSessionId(prefix = 'cube-spike-') {
  return validateSessionId(`${prefix}${crypto.randomUUID()}`);
}

// The +1 offset between the Cube's 0-based faces and the shell ids lives here and
// nowhere else. Deterministic ids are what make a reload reclaim a shell instead of
// doubling the runtime's shell count.
export function faceShellId(face) {
  const index = Number(face);
  if (!Number.isInteger(index) || index < 0) throw new ShellProtocolError(`face must be a non-negative integer; got ${face}`);
  return validateShellId(`face-${index + 1}`);
}

export function buildShellUrl({ region, runtimeArn, shellId, qualifier = 'DEFAULT' }) {
  validateShellId(shellId);
  const query = new URLSearchParams({ qualifier, shellId });
  return `wss://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/ws/shells?${query}`;
}

export function buildPassthroughUrl({ region, runtimeArn, query = {} }) {
  const params = new URLSearchParams(query);
  const suffix = params.toString();
  return `wss://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/ws${suffix ? `?${suffix}` : ''}`;
}

export function buildInvocationsUrl({ region, runtimeArn, qualifier = 'DEFAULT' }) {
  return `https://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=${encodeURIComponent(qualifier)}`;
}

export function buildStopSessionUrl({ region, runtimeArn, qualifier = 'DEFAULT' }) {
  return `https://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/stopruntimesession?qualifier=${encodeURIComponent(qualifier)}`;
}

function dataPlaneHost(region) {
  if (!region) throw new ShellProtocolError('region is required');
  return `bedrock-agentcore.${region}.amazonaws.com`;
}

// 4000 is the one code a six-face UI must never retry: it means another client took
// this shellId, so retrying makes the two clients kick each other forever.
export function classifyCloseCode(code) {
  switch (code) {
    case 1000:
      return { reconnect: false, terminal: true, reason: 'closed normally' };
    case 1001:
      return { reconnect: true, terminal: false, reason: 'going away (platform shutdown or VM eviction)' };
    case 1003:
      return { reconnect: false, terminal: true, reason: 'text frames sent — this protocol is binary only; client bug' };
    case 1006:
      return { reconnect: true, terminal: false, reason: 'abnormal closure' };
    case 1008:
      return { reconnect: true, terminal: false, reason: 'connection TTL (1 hour), frame rate limit, or write buffer overflow' };
    case 1009:
      return { reconnect: false, terminal: true, reason: 'frame payload exceeded 64 KB; client bug' };
    case 1011:
      return { reconnect: true, terminal: false, reason: 'server error' };
    case 4000:
      return { reconnect: false, terminal: true, reason: 'attached elsewhere — another client claimed this shellId' };
    default:
      return { reconnect: code !== null && code >= 1000 && code < 3000, terminal: false, reason: `close code ${code}` };
  }
}

export async function presignShellUrl({
  region,
  runtimeArn,
  shellId,
  sessionId,
  qualifier = 'DEFAULT',
  expiresIn = MAX_PRESIGN_EXPIRY_SECONDS,
  credentials,
  signer = 'aws-sdk',
  date,
}) {
  validateSessionId(sessionId);
  const url = buildShellUrl({ region, runtimeArn, shellId, qualifier });
  return presignUrl({ url, region, sessionId, expiresIn, credentials, signer, date });
}

// Presigning is pure local crypto — no AWS call, no cost, no latency. The session id
// rides as a signed query param (not a header) so a browser holding the URL cannot
// swap it for someone else's session.
export async function presignUrl({ url, region, sessionId, expiresIn = MAX_PRESIGN_EXPIRY_SECONDS, credentials, signer = 'aws-sdk', date }) {
  if (expiresIn > MAX_PRESIGN_EXPIRY_SECONDS) {
    throw new ShellProtocolError(`presigned URLs expire after at most ${MAX_PRESIGN_EXPIRY_SECONDS}s; got ${expiresIn}`);
  }
  const target = new URL(url.replace(/^wss:/, 'https:'));
  if (sessionId) target.searchParams.set(SESSION_ID_PARAM, validateSessionId(sessionId));
  const resolved = credentials ?? (await resolveCredentials());
  const query = new Map([...target.searchParams.entries()]);

  if (signer === 'aws-sdk') {
    const signed = await presignWithAwsSdk({ target, query, region, credentials: resolved, expiresIn, date });
    return signed.replace(/^https:/, 'wss:');
  }
  const canonicalQuery = await presignQuery({
    method: 'GET',
    host: target.host,
    path: target.pathname,
    query,
    region,
    service: 'bedrock-agentcore',
    credentials: resolved,
    expiresIn,
    date: date ?? new Date(),
  });
  return `wss://${target.host}${target.pathname}?${canonicalQuery}`;
}

// SigV4 header auth: the server-side path, and the fallback if the presigned URL is
// rejected. Also used for /invocations and StopRuntimeSession.
export async function signRequest({
  method = 'GET',
  url,
  region,
  service = 'bedrock-agentcore',
  headers = {},
  body,
  credentials,
  date = new Date(),
}) {
  const target = new URL(url);
  const resolved = credentials ?? (await resolveCredentials());
  const signer = await awsSigner({ service, region, credentials: resolved });
  const signed = await signer.sign({
    method,
    protocol: target.protocol,
    hostname: target.hostname,
    path: target.pathname,
    query: Object.fromEntries(target.searchParams),
    headers: { ...headers, host: target.host },
    body,
  }, { signingDate: date });
  return signed.headers;
}

async function presignQuery({ method, host, path, query, region, service, credentials, expiresIn, date }) {
  const { longDate, shortDate } = formatDate(date);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;
  const params = new Map(query);
  params.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  params.set('X-Amz-Credential', `${credentials.accessKeyId}/${scope}`);
  params.set('X-Amz-Date', longDate);
  params.set('X-Amz-Expires', String(expiresIn));
  if (credentials.sessionToken) params.set('X-Amz-Security-Token', credentials.sessionToken);
  params.set('X-Amz-SignedHeaders', 'host');

  const canonicalQuery = canonicalQueryString(params);
  // botocore's SigV4QueryAuth hashes an empty body rather than sending UNSIGNED-PAYLOAD
  // for https URLs, and that is the oracle this must match.
  const canonicalRequest = [method, canonicalUri(path), canonicalQuery, `host:${host}\n`, 'host', EMPTY_BODY_SHA256].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', longDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const signature = toHex(await signingKey(credentials.secretAccessKey, shortDate, region, service, stringToSign));
  return `${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function presignWithAwsSdk({ target, query, region, credentials, expiresIn, date }) {
  const signer = await awsSigner({ service: 'bedrock-agentcore', region, credentials });
  const request = {
    method: 'GET',
    protocol: 'https:',
    hostname: target.hostname,
    path: target.pathname,
    query: Object.fromEntries(query),
    headers: { host: target.host },
  };
  const presigned = await signer.presign(request, { expiresIn, signingDate: date });
  const pairs = [];
  for (const [key, value] of Object.entries(presigned.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) pairs.push(`${escapeUri(key)}=${escapeUri(item)}`);
  }
  return `https://${target.host}${presigned.path}?${pairs.join('&')}`;
}

async function awsSigner({ service, region, credentials }) {
  const [{ SignatureV4 }, { Sha256 }] = await Promise.all([
    loadModule('@smithy/signature-v4', 'Run `npm install` from the repo root.'),
    loadModule('@aws-crypto/sha256-js', 'Run `npm install` from the repo root.'),
  ]);
  return new SignatureV4({ service, region, credentials, sha256: Sha256 });
}

function canonicalQueryString(params) {
  return [...params.entries()]
    .map(([key, value]) => [escapeUri(key), escapeUri(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// Non-S3 services double-encode the canonical path; the ARN in the path is already
// percent-encoded, so its %3A becomes %253A here. @aws/agentcore relies on the same
// behaviour, which is how we know the service accepts it.
function canonicalUri(path) {
  return escapeUri(path).replace(/%2F/g, '/');
}

function escapeUri(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function formatDate(date) {
  const longDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { longDate, shortDate: longDate.slice(0, 8) };
}

async function signingKey(secretAccessKey, shortDate, region, service, stringToSign) {
  let key = textEncoder.encode(`AWS4${secretAccessKey}`);
  for (const part of [shortDate, region, service, 'aws4_request', stringToSign]) key = await hmacSha256(key, part);
  return key;
}

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', toBytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, toBytes(data)));
}

async function sha256Hex(data) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(data))));
}

function toHex(bytes) {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

class Emitter {
  constructor() {
    this.listeners = new Map();
  }

  on(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(handler);
    return () => this.off(name, handler);
  }

  off(name, handler) {
    this.listeners.get(name)?.delete(handler);
  }

  emit(name, value) {
    for (const handler of [...(this.listeners.get(name) ?? [])]) {
      try {
        handler(value);
      } catch (error) {
        if (name === 'error') console.error('shell listener threw:', error);
        else this.emit('error', error);
      }
    }
  }
}

export class ShellConnection extends Emitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.shellId = options.shellId ?? null;
    this.sessionId = options.sessionId ?? null;
    this.reconnected = false;
    this.bytesDropped = 0;
    this.confirmed = false;
    this.openedAt = Date.now();
    this.exit = null;
    this.closeResult = null;
    this.framesSent = 0;
    this.framesReceived = 0;

    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    this.coalesceMs = options.coalesceMs ?? 4;
    this.frameIntervalMs = 1000 / Math.min(options.framesPerSecond ?? DEFAULT_FRAME_RATE, FRAME_RATE_CEILING - 1);
    this.captureLimit = options.captureLimit ?? REPLAY_BUFFER_BYTES;

    this.pending = [];
    this.pendingBytes = 0;
    this.queue = [];
    this.nextFrameAt = 0;
    this.pumpTimer = null;
    this.coalesceTimer = null;
    this.heartbeatTimer = null;
    this.transcript = '';
    this.transcriptDecoder = new TextDecoder();
    this.bytesReceived = 0;
    this.waiters = [];

    this.closed = new Promise((resolve) => {
      this.settleClose = resolve;
    });
  }

  get msUntilTtl() {
    return CONNECTION_TTL_MS - (Date.now() - this.openedAt);
  }

  // Everything the shell has printed since connect, bounded to the size of the
  // service's own replay buffer so a chatty face cannot grow without limit.
  output() {
    return this.transcript;
  }

  write(data) {
    const bytes = toBytes(data);
    if (!bytes.length) return;
    this.pending.push(bytes);
    this.pendingBytes += bytes.length;
    if (this.pendingBytes >= MAX_PAYLOAD_SIZE) this.flushStdin();
    else if (!this.coalesceTimer) this.coalesceTimer = setTimer(() => this.flushStdin(), this.coalesceMs);
  }

  resize(cols, rows) {
    this.enqueue(encodeResize(cols, rows));
  }

  heartbeat() {
    this.enqueue(encodeHeartbeat());
  }

  flushStdin() {
    clearTimer(this.coalesceTimer);
    this.coalesceTimer = null;
    if (!this.pending.length) return;
    const bytes = concatBytes(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    for (const frame of encodeStdin(bytes)) this.enqueue(frame);
  }

  enqueue(frame) {
    this.queue.push(frame);
    this.pump();
  }

  // One frame every frameIntervalMs keeps a fast paste under the 250 frames/sec
  // ceiling; exceeding it is close 1008, not backpressure.
  pump() {
    if (this.pumpTimer || !this.queue.length) return;
    const now = Date.now();
    if (now < this.nextFrameAt) {
      this.pumpTimer = setTimer(() => {
        this.pumpTimer = null;
        this.pump();
      }, this.nextFrameAt - now);
      return;
    }
    this.nextFrameAt = Math.max(now, this.nextFrameAt) + this.frameIntervalMs;
    this.sendRaw(this.queue.shift());
    if (this.queue.length) this.pump();
  }

  sendRaw(frame) {
    if (!(frame instanceof Uint8Array)) throw new ShellProtocolError('only binary frames may be sent; 5 text frames close the socket with 1003');
    if (this.socket.readyState !== 1) {
      this.emit('error', new ShellProtocolError('dropped a frame: socket is not open', { shellId: this.shellId }));
      return;
    }
    this.framesSent += 1;
    this.socket.send(frame);
  }

  // Resolves when the shell prints something matching `pattern`. The whole capture is
  // searched, so a match that arrived before the call still counts.
  waitFor(pattern, { timeoutMs = 15_000 } = {}) {
    // A /g regexp carries lastIndex between calls, which would make repeated tests on a
    // growing transcript miss.
    const probe = pattern instanceof RegExp && pattern.global ? new RegExp(pattern.source, pattern.flags.replace('g', '')) : pattern;
    const matcher = typeof probe === 'string' ? (text) => text.includes(probe) : (text) => probe.test(text);
    if (matcher(this.output())) return Promise.resolve(this.output());
    // A shell that is already gone will never print anything again. Waiting on it is
    // how a test ends up with no verdict at all instead of a failure it can report.
    if (this.closeResult) {
      return Promise.reject(
        new ShellProtocolError(`shell ${this.shellId} already closed (${this.closeResult.code}); ${pattern} can never arrive`, {
          output: this.output(),
          close: this.closeResult,
        }),
      );
    }
    return new Promise((resolve, reject) => {
      // Deliberately ref'd, unlike setTimer(): this expiry IS a measurement. An unref'd
      // one lets node exit with the promise unsettled, which reports nothing at all.
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new ShellProtocolError(`timed out after ${timeoutMs}ms waiting for ${pattern} on ${this.shellId}`, { output: this.output() }));
      }, timeoutMs);
      this.waiters.push({ matcher, resolve, reject, timer, pattern });
    });
  }

  // Runs `script` in the shell and returns only what the script printed — never the
  // PTY's echo of the request. Two defences, because either alone can fail: `stty
  // -echo` (which does nothing if the platform hands us a non-interactive shell), and
  // sentinels printed from two separate shell words, so the concatenated form the
  // parser looks for cannot appear in the echoed command line. Reading the echo instead
  // of the result is what made T-09 report garbage against a working system.
  async probe(script, { timeoutMs = 30_000 } = {}) {
    const nonce = `CUBE${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const begin = `${nonce}BEGIN`;
    const end = `${nonce}END`;
    this.write(`stty -echo 2>/dev/null; printf '%s%s\\n' '${nonce}' 'BEGIN'; ${script}; printf '%s%s\\n' '${nonce}' 'END'; stty echo 2>/dev/null\n`);
    await this.waitFor(end, { timeoutMs });
    const text = this.output().replace(/\r\n/g, '\n').replace(/\r/g, '');
    const start = text.lastIndexOf(begin);
    const stop = start < 0 ? -1 : text.indexOf(end, start + begin.length);
    if (start < 0 || stop < 0) {
      throw new ShellProtocolError(`probe sentinels did not bracket any output on ${this.shellId}`, { output: text.slice(-2000) });
    }
    const body = text.slice(start + begin.length, stop).replace(/^\n/, '');
    const lines = body.split('\n').filter((line) => line.length);
    const values = {};
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) values[match[1]] = match[2].trim();
    }
    return { text: body, lines, values, nonce };
  }

  close(code = 1000, reason = '') {
    if (this.closing) return this.closed;
    this.closing = true;
    if (this.socket.readyState === 1) {
      try {
        this.socket.send(encodeClose());
      } catch {
        // The socket may already be tearing down; the close below still runs.
      }
      this.socket.close(code, reason);
    } else if (this.socket.readyState === 3) {
      // Already CLOSED, so no close event is coming. Without this, awaiting the
      // returned promise hangs forever on a socket that is demonstrably gone.
      this.teardown(code, reason || 'closed before close() was called');
    } else if (typeof this.socket.terminate === 'function') {
      this.socket.terminate();
    } else {
      this.socket.close(code, reason);
    }
    return this.closed;
  }

  capture(bytes) {
    this.bytesReceived += bytes.length;
    // Streaming decode: a UTF-8 sequence can straddle two frames, and decoding each
    // frame independently would corrupt it.
    this.transcript += this.transcriptDecoder.decode(bytes, { stream: true });
    if (this.transcript.length > this.captureLimit) this.transcript = this.transcript.slice(-this.captureLimit);
    if (!this.waiters.length) return;
    const text = this.output();
    for (const waiter of [...this.waiters]) {
      if (!waiter.matcher(text)) continue;
      clearTimer(waiter.timer);
      this.waiters = this.waiters.filter((entry) => entry !== waiter);
      waiter.resolve(text);
    }
  }

  handleFrame(message) {
    this.framesReceived += 1;
    let frame;
    try {
      frame = decodeFrame(message);
    } catch (error) {
      this.emit('error', error);
      return;
    }
    switch (frame.channel) {
      case SHELL_CHANNEL.STDOUT:
        this.capture(frame.payload);
        this.emit('stdout', frame.payload);
        return;
      case SHELL_CHANNEL.STDERR:
        this.capture(frame.payload);
        this.emit('stderr', frame.payload);
        return;
      case SHELL_CHANNEL.STATUS:
        this.handleStatus(parseStatusFrame(frame.payload));
        return;
      case SHELL_CHANNEL.HEARTBEAT:
        this.emit('heartbeat', null);
        return;
      case SHELL_CHANNEL.CLOSE:
        // Server-sent 0xFF is the platform saying the microVM is going away. It is the
        // sleep signal, not an error.
        this.emit('evicted', null);
        this.close(1001, 'vm-evicted');
        return;
      default:
        this.emit('error', new ShellProtocolError(`unknown shell channel 0x${frame.channel.toString(16)}`));
    }
  }

  handleStatus(status) {
    this.emit('status', status);
    if (status.type === 'confirmation') {
      this.shellId = status.shellId;
      // Latched, not assigned: the post-drain confirmation carries bytesDropped and no
      // `reconnected`, and T-16a's whole verdict is this flag after a reattach.
      if (status.reconnected) this.reconnected = true;
      if (Number.isFinite(status.bytesDropped)) this.bytesDropped = status.bytesDropped;
      this.confirmed = true;
      this.emit('confirm', status);
      return;
    }
    if (status.type === 'exit') {
      this.exit = status;
      this.emit('exit', status);
    }
  }

  startHeartbeat() {
    if (!this.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  teardown(code, reason) {
    clearTimer(this.coalesceTimer);
    clearTimer(this.pumpTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.coalesceTimer = null;
    this.pumpTimer = null;
    this.heartbeatTimer = null;
    // Rejecting, not dropping. Silently discarding the waiters left every in-flight
    // waitFor() permanently unsettled, so a shell that died mid-probe produced no
    // verdict rather than a reportable failure.
    const orphans = this.waiters;
    this.waiters = [];
    for (const waiter of orphans) {
      clearTimer(waiter.timer);
      waiter.reject?.(
        new ShellProtocolError(`shell ${this.shellId} closed with ${code} while waiting for ${waiter.pattern}`, {
          code,
          classification: classifyCloseCode(code),
          output: this.output(),
        }),
      );
    }
    if (this.closeResult) return;
    this.closeResult = { code, reason, classification: classifyCloseCode(code), shellId: this.shellId, exit: this.exit };
    this.emit('close', this.closeResult);
    this.settleClose(this.closeResult);
  }
}

// Resolves only after the first 0x03 STATUS frame, so callers never send into a shell
// that has not confirmed. Exactly one of two things happens: you get a connection whose
// `closed` promise always settles, or you get a rejection. A consumer that has to
// present a WebSocket-shaped object (the browser adapter) must turn that rejection into
// its own single synthetic close event.
export async function connectShell(options = {}) {
  const {
    url,
    headers,
    protocols,
    WebSocketImpl,
    shellId = null,
    sessionId = null,
    connectTimeoutMs = 30_000,
    resize = null,
    bootstrap = null,
  } = options;
  if (!url) throw new ShellProtocolError('connectShell requires a url');

  const WebSocketCtor = WebSocketImpl ?? (await resolveWebSocket());
  const socket = headers ? new WebSocketCtor(url, protocols ?? [], { headers }) : new WebSocketCtor(url, protocols ?? []);
  socket.binaryType = 'arraybuffer';
  const connection = new ShellConnection(socket, { ...options, shellId, sessionId });

  return new Promise((resolve, reject) => {
    let settled = false;
    let handshake = null;
    // Ref'd: a connect that never confirms must produce a rejection, not a silent
    // process exit with this promise still pending.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.close(1000, 'connect timeout');
      reject(new ShellProtocolError(`timed out after ${connectTimeoutMs}ms waiting for the 0x03 confirmation on ${shellId ?? 'shell'}`));
    }, connectTimeoutMs);

    // Browsers cannot read the 101 response headers, so the shell id must come from
    // this frame and never from X-Amzn-Bedrock-AgentCore-Shell-Id.
    connection.on('confirm', (status) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (bootstrap && !status.reconnected) {
        const line = typeof bootstrap === 'function' ? bootstrap(status) : bootstrap;
        if (line) connection.write(line);
      }
      if (resize) connection.resize(resize.cols, resize.rows);
      connection.startHeartbeat();
      resolve(connection);
    });

    if (typeof socket.on === 'function') {
      // ws hands us the failed upgrade response only if we listen for it, and taking
      // the listener means we own aborting the request.
      socket.on('unexpected-response', (request, response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          handshake = {
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          };
          request.destroy();
        });
      });
    }

    socket.addEventListener('message', (event) => connection.handleFrame(event.data));
    socket.addEventListener('error', (event) => {
      connection.emit('error', event?.error ?? new ShellProtocolError(event?.message ?? 'shell socket error'));
    });
    socket.addEventListener('close', (event) => {
      connection.teardown(event?.code ?? 1006, event?.reason ?? '');
      if (settled) return;
      settled = true;
      clearTimer(timer);
      reject(describeHandshakeFailure(event, handshake, shellId));
    });
  });
}

function describeHandshakeFailure(event, handshake, shellId) {
  const code = event?.code ?? 1006;
  if (handshake) {
    const parsed = safeJson(handshake.body);
    const type = parsed?.__type ?? parsed?.name ?? handshake.headers?.['x-amzn-errortype']?.split(':')[0];
    const message = parsed?.message ?? parsed?.Message ?? handshake.body;
    return new ShellProtocolError(`shell upgrade rejected: HTTP ${handshake.statusCode} ${type ?? ''} ${message ?? ''}`.trim(), {
      statusCode: handshake.statusCode,
      errorType: type ?? null,
      awsMessage: message ?? null,
      body: handshake.body,
      requestId: handshake.headers?.['x-amzn-requestid'] ?? null,
      shellId,
    });
  }
  const classification = classifyCloseCode(code);
  return new ShellProtocolError(`shell closed before confirmation: ${code} (${classification.reason})`, { code, classification, shellId });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The reference reconnect loop. A 1-hour 1008 and a 15-minute idle drop are normal
// operating conditions for a face that stays open all day; 1003/4000/1009 are not and
// must stop the loop instead of fighting whoever else holds the shell.
export async function openShellSession(options = {}) {
  const { mint, maxAttempts = 6, backoffMs = 500, maxBackoffMs = 8000, windowMs = RECONNECT_WINDOW_MS } = options;
  if (typeof mint !== 'function') throw new ShellProtocolError('openShellSession requires mint()');

  const session = new Emitter();
  let connection = null;
  let stopped = false;
  let size = options.resize ?? null;

  const attach = async () => {
    const startedAt = Date.now();
    let attempt = 0;
    for (;;) {
      if (stopped) return null;
      try {
        connection = await connectShell({ ...options, ...(await mint()), resize: size });
        session.emit('connect', connection);
        connection.closed.then((result) => {
          if (stopped || connection?.closeResult !== result) return;
          session.emit('disconnect', result);
          if (result.classification.reconnect) attach().catch((error) => session.emit('error', error));
          else session.emit('stop', result);
        });
        return connection;
      } catch (error) {
        attempt += 1;
        const fatal = error.classification && !error.classification.reconnect;
        if (fatal || attempt >= maxAttempts || Date.now() - startedAt > windowMs) {
          session.emit('stop', { error });
          throw error;
        }
        await delay(Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs));
      }
    }
  };

  session.write = (data) => connection?.write(data);
  session.resize = (cols, rows) => {
    size = { cols, rows };
    connection?.resize(cols, rows);
  };
  session.current = () => connection;
  session.close = (code, reason) => {
    stopped = true;
    return connection?.close(code, reason);
  };
  await attach();
  return session;
}

// Deliberately a ref'd timer, unlike setTimer below. Callers use this to sequence a
// test across a deliberately dropped socket; an unref'd sleep lets node exit the moment
// terminate() releases the last handle, and the await never settles.
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

function clearTimer(timer) {
  if (timer) clearTimeout(timer);
}

// `ws` is preferred over the global WebSocket because only it exposes the failed
// upgrade response, and that body is what distinguishes "region not enabled" from
// "runtime not MMDSv2-enabled" from a signature problem.
export async function resolveWebSocket() {
  try {
    const module = await import('ws');
    return module.WebSocket ?? module.default;
  } catch {
    if (globalThis.WebSocket) return globalThis.WebSocket;
    throw new MissingDependencyError('ws', 'It ships with this repo; run this from the repo root, or use a runtime with a global WebSocket.');
  }
}

async function loadModule(specifier, hint) {
  try {
    return await import(specifier);
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') throw new MissingDependencyError(specifier, hint);
    throw error;
  }
}

// Node-only below this line. The browser never resolves credentials — it asks the mint
// server for a presigned URL instead.
let credentialProviderPromise;

export async function resolveCredentials(options) {
  credentialProviderPromise ??= (async () => {
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      return async () => ({
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        sessionToken: process.env.AWS_SESSION_TOKEN,
        expiration: process.env.AWS_CREDENTIAL_EXPIRATION ? new Date(process.env.AWS_CREDENTIAL_EXPIRATION) : undefined,
      });
    }
    const { fromNodeProviderChain } = await loadModule('@aws-sdk/credential-providers', 'Run `npm install` from the repo root.');
    return fromNodeProviderChain();
  })();
  return (await credentialProviderPromise)(options);
}
