// InvokeAgentRuntimeCommandShell's browser-safe wire contract. AWS publishes no API
// reference or JS client for this operation; these values and codecs are transcribed from
// the first-party Python and npm implementations and measured by the spike harness.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SHELL_CHANNEL = Object.freeze({
  STDIN: 0x00,
  STDOUT: 0x01,
  STDERR: 0x02,
  STATUS: 0x03,
  RESIZE: 0x04,
  HEARTBEAT: 0x05,
  CLOSE: 0xff,
});

export const MAX_FRAME_SIZE = 65_536;
export const MAX_PAYLOAD_SIZE = MAX_FRAME_SIZE - 1;
export const FRAME_RATE_CEILING = 250;
export const DEFAULT_FRAME_RATE = 200;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const CONNECTION_TTL_MS = 3_600_000;
export const RECONNECT_WINDOW_MS = 900_000;
export const REPLAY_BUFFER_BYTES = 262_144;
export const MAX_PRESIGN_EXPIRY_SECONDS = 300;
export const MIN_SESSION_ID_LENGTH = 33;
export const MAX_SESSION_ID_LENGTH = 256;
export const SHELL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export class ShellProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ShellProtocolError';
    Object.assign(this, details);
  }
}

// Resize frames must remain distinguishable from a Ctrl-D byte passed through xterm.
export class CubeControlFrame extends Uint8Array {}

export function validateShellId(shellId, ErrorType = ShellProtocolError) {
  if (!SHELL_ID_PATTERN.test(String(shellId ?? ''))) {
    throw new ErrorType(`shellId "${shellId}" must match ${SHELL_ID_PATTERN}`);
  }
  return shellId;
}

export function validateSessionId(sessionId, ErrorType = ShellProtocolError) {
  const value = String(sessionId ?? '');
  if (value.length < MIN_SESSION_ID_LENGTH || value.length > MAX_SESSION_ID_LENGTH) {
    throw new ErrorType(
      `runtimeSessionId must be ${MIN_SESSION_ID_LENGTH}-${MAX_SESSION_ID_LENGTH} characters; got ${value.length}`,
    );
  }
  return value;
}

export function toBytes(value) {
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new ShellProtocolError(`cannot convert ${typeof value} to bytes`);
}

export function encodeFrame(channel, payload) {
  const bytes = toBytes(payload ?? new Uint8Array(0));
  if (bytes.length > MAX_PAYLOAD_SIZE) {
    throw new ShellProtocolError(`frame payload ${bytes.length} exceeds ${MAX_PAYLOAD_SIZE} bytes (server closes with 1009)`);
  }
  const frame = new CubeControlFrame(bytes.length + 1);
  frame[0] = channel;
  frame.set(bytes, 1);
  return frame;
}

export function decodeFrame(message) {
  const bytes = toBytes(message);
  if (!bytes.length) throw new ShellProtocolError('received an empty shell frame');
  // Copy rather than subarray: payload.buffer must not expose the channel or another frame
  // that happened to share the socket read's backing buffer.
  return { channel: bytes[0], payload: bytes.slice(1) };
}

export function encodeStdin(data) {
  const bytes = toBytes(data);
  const frames = [];
  for (let offset = 0; offset < bytes.length; offset += MAX_PAYLOAD_SIZE) {
    frames.push(encodeFrame(SHELL_CHANNEL.STDIN, bytes.subarray(offset, offset + MAX_PAYLOAD_SIZE)));
  }
  return frames;
}

export function encodeResize(cols, rows) {
  return encodeFrame(SHELL_CHANNEL.RESIZE, JSON.stringify({
    width: Math.max(1, Math.floor(cols)),
    height: Math.max(1, Math.floor(rows)),
  }));
}

export function encodeHeartbeat() {
  return encodeFrame(SHELL_CHANNEL.HEARTBEAT);
}

export function encodeClose() {
  return encodeFrame(SHELL_CHANNEL.CLOSE);
}

export function parseStatusFrame(payload) {
  const raw = decoder.decode(toBytes(payload));
  let status;
  try {
    status = JSON.parse(raw);
  } catch {
    return { type: 'unparsed', raw };
  }
  const shellId = status?.metadata?.shellId;
  if (typeof shellId === 'string') {
    return {
      type: 'confirmation',
      shellId,
      reconnected: status.metadata.reconnected ?? false,
      bytesDropped: status.metadata.bytesDropped,
      status,
    };
  }
  const causes = status?.details?.causes ?? [];
  const exit = causes.find((cause) => cause.reason === 'ExitCode');
  const signal = causes.find((cause) => cause.reason === 'Signal');
  if (exit || signal) {
    return {
      type: 'exit',
      exitCode: exit ? Number(exit.message) : null,
      signal: signal ? Number(signal.message) : null,
      message: status?.message,
      status,
    };
  }
  if (status?.status === 'Success') return { type: 'exit', exitCode: 0, signal: null, status };
  return { type: 'error', reason: status?.reason, message: status?.message, code: status?.code, status };
}
