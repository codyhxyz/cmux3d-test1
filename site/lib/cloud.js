// The minting API, as Cloudflare Pages Functions. Same three endpoints the loopback minter
// serves (src/server/cloud/routes.js), same response shapes, no process on anyone's machine.
//
// A browser cannot authenticate to AgentCore — SigV4 needs headers a WebSocket upgrade
// cannot carry, and presigned URLs live at most 300 seconds — so something server-side has
// to sign one URL per face per reconnect. That something used to be a node process the
// operator had to start, which made the hosted page a decoration. Here it is the same origin
// as the page, so there is no address-space boundary in the way at all.
//
// Two things this file deliberately does NOT contain:
//
//   No signer. spike/harness/shell-client.mjs is kept free of top-level node imports for
//   exactly this reason, and its `raw` presign path is already pure crypto.subtle. It is the
//   implementation verified byte-correct against the live service, so importing it is both
//   less code and the only version that stays correct when the wire format is next corrected.
//
//   No token verification. The Cloudflare Access application covers this whole hostname, so
//   the edge has already authenticated every request that reaches a Function, and it injects
//   the verified identity below. Re-deriving that from the raw JWT would be a second
//   implementation of a check that already happened.
//
// The credential trade: a long-lived AWS key now lives in Cloudflare's secret store rather
// than the operator's ~/.aws/credentials. It is the key of the deliberately tiny minter user
// from spike/aws/create-minter-user.sh — it can invoke one runtime and open shells on it,
// and can create and delete nothing.

import { clampFaceCount, DEFAULT_FACE_COUNT, MAX_FACE_COUNT, MIN_FACE_COUNT } from '../../public/app/face-count.js';
import {
  buildInvocationsUrl,
  faceShellId,
  MAX_PRESIGN_EXPIRY_SECONDS,
  presignShellUrl,
  signRequest,
  validateSessionId,
} from '../../spike/harness/shell-client.mjs';

// Already the code the browser treats as "stop retrying, a human must act" — see
// transport.js. A revoked key in Cloudflare and an expired `aws login` are the same state to
// the interface, so they are the same code.
const CREDENTIAL_ACTION_REQUIRED = 'AWS_LOGIN_REQUIRED';
const REFRESH_MARGIN_SECONDS = 30;
const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const INVOKE_ATTEMPTS = 4;

class CloudError extends Error {
  constructor(status, message, { code, extra } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra ?? {};
  }
}

/**
 * One Pages Function per route, all of them this.
 * @param {'session'|'prepare'|'mint'} route
 */
export function cloudRoute(route) {
  return async function onRequest({ request, env }) {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new CloudError(405, 'method not allowed');
      // Authenticated before anything else, configuration included: whether this deployment
      // holds AWS keys is not a question an unauthenticated caller gets to ask.
      const identity = identify(request);
      const config = readConfig(env);
      const params = new URL(request.url).searchParams;
      const sessionId = await resolveSessionId(params.get('sessionId'), identity, config);

      if (route === 'session') return respond(200, sessionPayload(config, sessionId));
      if (route === 'prepare') {
        return respond(200, await prepare(config, sessionId, params.get('op') ?? 'state', params.get('faces')));
      }
      return respond(200, await mint(config, sessionId, shellIdFrom(params)));
    } catch (error) {
      // An unexpected throw is ours and the caller gets nothing but the status. A CloudError
      // is a decision made here, and its message is the whole point of returning it.
      if (!(error instanceof CloudError)) return respond(500, { error: 'internal error' });
      const body = { error: error.message, ...error.extra };
      if (error.code) body.code = error.code;
      // Tells resolveCloudBase() this origin really is the minter even when it is refusing,
      // so the page does not go looking elsewhere for an API that is right here.
      body.minter = true;
      return respond(error.status, body);
    }
  };
}

// Read per request, not at module load: Pages hands env in per invocation, and a secret
// rotated in the dashboard must take effect on the next request rather than whenever an
// isolate happens to recycle.
function readConfig(env) {
  const runtimeArn = env.CUBE_RUNTIME_ARN;
  const accessKeyId = env.CUBE_AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.CUBE_AWS_SECRET_ACCESS_KEY;
  const missing = Object.entries({ CUBE_RUNTIME_ARN: runtimeArn, CUBE_AWS_ACCESS_KEY_ID: accessKeyId, CUBE_AWS_SECRET_ACCESS_KEY: secretAccessKey })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new CloudError(503, `this deployment is missing ${missing.join(', ')}`, { code: CREDENTIAL_ACTION_REQUIRED });

  return {
    runtimeArn,
    // The ARN already carries the region; the override is only for an ARN-shaped value
    // pointed somewhere else.
    region: env.CUBE_REGION || runtimeArn.split(':')[3] || 'us-east-1',
    qualifier: env.CUBE_QUALIFIER || 'DEFAULT',
    expiresIn: Math.min(Number(env.CUBE_MINT_EXPIRES) || MAX_PRESIGN_EXPIRY_SECONDS, MAX_PRESIGN_EXPIRY_SECONDS),
    // free   — the browser keeps naming its own session id, exactly as it does against the
    //          loopback minter. That id IS the workspace the browser remembers, and the
    //          runtime it lands on is this operator's either way.
    // pinned — one server-chosen session per identity, so a browser with cleared storage
    //          cannot boot a second microVM onto the same EFS workspace.
    pinSession: env.CUBE_SESSION_POLICY === 'pinned',
    credentials: { accessKeyId, secretAccessKey, sessionToken: env.CUBE_AWS_SESSION_TOKEN || undefined },
  };
}

// Cloudflare Access injects this on every request it lets through, after verifying its own
// JWT. A request that reaches a Function without it means the Access application is not
// actually covering this hostname — which is a deployment that would otherwise sign root
// shells for the internet, so it is refused rather than defaulted.
function identify(request) {
  const email = request.headers.get('cf-access-authenticated-user-email');
  if (!email) {
    throw new CloudError(403, 'this request did not come through Cloudflare Access; the cube refuses to sign shells without it');
  }
  return email.toLowerCase();
}

async function resolveSessionId(requested, identity, config) {
  const pinned = await deriveSessionId(identity);
  if (config.pinSession) {
    if (requested && requested !== pinned) {
      throw new CloudError(409, 'this workspace is pinned to one session; use the id returned by /session', { extra: { sessionId: pinned } });
    }
    return pinned;
  }
  if (!requested) return pinned;
  try {
    return validateSessionId(requested);
  } catch (error) {
    throw new CloudError(400, error.message);
  }
}

// Hashed rather than interpolated: an email is neither long enough for the 33-character
// minimum nor guaranteed to be a legal session id, and this value lands in AWS logs where
// the operator's address has no business being.
async function deriveSessionId(identity) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  return validateSessionId(`cube-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
}

function shellIdFrom(params) {
  const face = params.get('face');
  const requested = params.get('shellId') ?? (face === null ? null : faceShellId(Number(face)));
  // A closed set, not a pattern. AgentCore allows ten concurrent shells per runtime session
  // (spike/RESULTS.md T-10); an eleventh presigns fine and then fails at the handshake as one
  // face that simply never opens, so it is refused here where the answer can name the limit.
  const allowed = Array.from({ length: MAX_FACE_COUNT }, (_, index) => faceShellId(index));
  if (!allowed.includes(requested)) {
    throw new CloudError(400, `shellId must be one of ${allowed.join(', ')} (or face=0..${MAX_FACE_COUNT - 1})`);
  }
  return requested;
}

function sessionPayload(config, sessionId) {
  return {
    sessionId,
    runtimeArn: config.runtimeArn,
    region: config.region,
    qualifier: config.qualifier,
    expiresIn: config.expiresIn,
    refreshAfterSeconds: config.expiresIn - REFRESH_MARGIN_SECONDS,
  };
}

async function mint(config, sessionId, shellId) {
  const mintedAt = Date.now();
  // Presigning is pure local crypto: no AWS call, no cost, no latency. `raw` is the
  // Web Crypto path — the `aws-sdk` default would pull @smithy through a dynamic import
  // that has no business inside a Worker.
  const url = await presignShellUrl({
    region: config.region,
    runtimeArn: config.runtimeArn,
    shellId,
    sessionId,
    qualifier: config.qualifier,
    expiresIn: config.expiresIn,
    credentials: config.credentials,
    signer: 'raw',
  });
  return {
    url,
    shellId,
    sessionId,
    expiresIn: config.expiresIn,
    expiresAt: mintedAt + config.expiresIn * 1000,
    refreshAfterSeconds: config.expiresIn - REFRESH_MARGIN_SECONDS,
  };
}

// Measured: /mnt/workspace does not exist for a session whose only activity is a shell
// connection — it materialises on the first /invocations call. The browser cannot make that
// call itself, so this does, and the transport blocks every face on the answer. The same call
// returns the face -> terminal_id map the transport needs anyway.
async function prepare(config, sessionId, op, faces) {
  const request = clampFaceCount(faces);
  const startedAt = Date.now();
  const result = await invokeRuntime(config, sessionId, { op: String(op).slice(0, 64), faces: request.faces });
  const json = safeJson(result.body);
  if (result.statusCode >= 400) {
    throw new CloudError(502, json?.message ?? `runtime returned ${result.statusCode}`, { extra: { statusCode: result.statusCode } });
  }
  const servedFaces = Array.isArray(json?.faces) ? json.faces : [];
  return {
    sessionId,
    state: json?.state ?? 'unknown',
    phase: json?.phase ?? null,
    elapsedMs: json?.elapsedMs ?? null,
    faces: servedFaces,
    // What the container actually served, never what it was asked for. An image that predates
    // the setting ignores `faces`, answers six and reports no faceCount at all; echoing the
    // request back would claim ten faces over an array of six.
    faceCount: servedFaces.length || (Number.isFinite(json?.faceCount) ? json.faceCount : request.faces),
    facesRequested: request.requested,
    facesClamped: request.clamped || json?.facesClamped === true,
    faceLimits: json?.faceLimits ?? { min: MIN_FACE_COUNT, max: MAX_FACE_COUNT, default: DEFAULT_FACE_COUNT },
    // The container's own account of which panes hold a working agent. The browser joins it to
    // faces[].paneId for "agent working — sleep paused"; dropping it here would make this path
    // quietly less honest than the loopback one it replaces.
    busy: json?.busy ?? null,
    persistence: json?.persistence ?? null,
    invokedInMs: Date.now() - startedAt,
  };
}

async function invokeRuntime(config, sessionId, payload) {
  const url = buildInvocationsUrl({ region: config.region, runtimeArn: config.runtimeArn, qualifier: config.qualifier });
  const body = JSON.stringify(payload);

  for (let attempt = 0; ; attempt += 1) {
    const headers = await signRequest({
      method: 'POST',
      url,
      region: config.region,
      service: 'bedrock-agentcore',
      headers: { 'content-type': 'application/json', accept: 'application/json', [SESSION_HEADER]: sessionId },
      body,
      credentials: config.credentials,
      signer: 'raw',
    });
    const response = await fetch(url, { method: 'POST', headers, body });
    const text = await response.text();

    // A key AWS refuses is not transient and no retry fixes it. Unlike the loopback minter
    // there is no `aws login` to run — the secret in Cloudflare has been revoked, rotated or
    // mistyped — so the message says that, under the code the browser already treats as
    // "stop retrying and offer a way out".
    if (response.status === 403 && /expired|InvalidSignature|security token|not authorized/i.test(text)) {
      throw new CloudError(503, 'Cloudflare is holding an AWS key that AWS is refusing. Rotate the CUBE_AWS_* secrets on the Pages project.', { code: CREDENTIAL_ACTION_REQUIRED });
    }
    // RetryableConflictException is documented as brief and expected while the service
    // provisions or tears down a session, so a first 409 is not an answer.
    const retryable = response.status === 409 || response.status === 429 || response.status >= 500;
    if (!retryable || attempt + 1 >= INVOKE_ATTEMPTS) return { statusCode: response.status, body: text };
    await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)));
  }
}

function respond(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      // A presigned root-shell URL must never sit in a cache, a proxy, or the back button.
      'cache-control': 'no-store',
    },
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
