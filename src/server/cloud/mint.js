// The AgentCore minter: for a single operator, this is the entire control plane.
//
// A browser cannot authenticate to AgentCore at all — SigV4 needs headers a WebSocket
// upgrade cannot carry, and presigned URLs live at most 300 seconds — so something
// server-side has to sign one URL per face per reconnect. This module is that
// something, and nothing more: it authorizes nobody. Whoever mounts it decides who is
// allowed to ask (the gateway uses the pairing code; the standalone spike server uses
// "any process on this machine").
//
// The presign path is also the only one where authorization is *enforceable* later:
// AgentCore maps no session to any user and there is no IAM condition key for
// runtimeSessionId, so a JWT authorizer could not stop a valid token from naming
// someone else's session. Binding identity to (sessionId, shellId) at mint time can.

import https from 'node:https';
// The wire protocol, presign and SigV4 live with the harness that first proved them
// byte-correct against the live service. Sharing that file is what keeps the product
// and `spike/harness/agentcore.mjs` signing identical requests.
import {
  buildInvocationsUrl,
  faceShellId,
  newSessionId,
  presignShellUrl,
  resolveCredentials,
  signRequest,
  validateSessionId,
  validateShellId,
} from '../../../spike/harness/shell-client.mjs';

export const AWS_LOGIN_REQUIRED = 'AWS_LOGIN_REQUIRED';
export const MAX_EXPIRES_SECONDS = 300;
const REFRESH_MARGIN_SECONDS = 30;
const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
const INVOKE_TIMEOUT_MS = 120_000;
const INVOKE_ATTEMPTS = 4;

export class CloudError extends Error {
  constructor(message, { status = 400, code, cause } = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = status;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

export function awsLoginRequired(cause) {
  return new CloudError('AWS login required. Run `aws login`, then choose Retry.', {
    status: 503,
    code: AWS_LOGIN_REQUIRED,
    cause,
  });
}

// The SDK's provider chain is built once, lazily, and reads AWS_PROFILE at
// construction — so the profile has to be in the environment before the first
// credential resolution, which is why this runs at minter construction.
function preferProfile(profile, { pinned = false, log } = {}) {
  if (!profile) return null;
  process.env.AWS_PROFILE = profile;
  // Static keys in the environment beat any profile inside the provider chain. An
  // `aws login` export inherited from the shell would therefore silently reinstate
  // the daily expiry that naming a profile exists to remove.
  if (pinned && process.env.AWS_ACCESS_KEY_ID) {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_CREDENTIAL_EXPIRATION;
    log?.(`CUBE_AWS_PROFILE=${profile} wins; ignoring AWS_ACCESS_KEY_ID from the environment`);
  }
  return profile;
}

/**
 * @param {object} options
 * @param {string} options.runtimeArn      the one runtime this minter will ever sign for
 * @param {string} [options.sessionId]     33-256 chars; generated when absent
 * @param {boolean} [options.pinSession]   refuse to sign any session but our own
 * @param {string} [options.profile]       AWS named profile to resolve credentials from
 */
export function createMinter(options = {}) {
  const runtimeArn = options.runtimeArn;
  if (!runtimeArn) throw new CloudError('createMinter requires a runtimeArn');
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const region = options.region ?? runtimeArn.split(':')[3] ?? 'us-east-1';
  const qualifier = options.qualifier ?? 'DEFAULT';
  const signer = options.signer ?? 'aws-sdk';
  const expiresIn = Math.min(Number(options.expiresIn) || MAX_EXPIRES_SECONDS, MAX_EXPIRES_SECONDS);
  // One session id per minter run: all six faces must land in the same microVM, and
  // the browser has no business choosing it. It may still name its own unless pinned,
  // because the id IS the workspace and the browser is the thing that remembers it.
  const sessionId = options.sessionId ? validateSessionId(options.sessionId) : newSessionId('cube-');
  const pinSession = Boolean(options.pinSession);
  const profile = preferProfile(options.profile, { pinned: options.profilePinned, log });

  // The AWS provider owns caching, concurrent-refresh coalescing and aws-login token
  // refresh. Wrapping that cache is how the old path spawned one CLI per face instead
  // of sharing one resolution.
  async function currentCredentials({ force = false } = {}) {
    try {
      return await resolveCredentials(force ? { forceRefresh: true } : undefined);
    } catch (error) {
      throw awsLoginRequired(error);
    }
  }

  // Signing a caller-named session is precisely the hole multi-user must close: with
  // no session-to-user mapping in AgentCore, whoever names the session owns the
  // workspace. Here the caller is the operator's own browser, so it is allowed — but
  // validated, and switchable off.
  function targetSession(requested) {
    if (requested && pinSession && requested !== sessionId) {
      throw new CloudError('pinned: this minter only signs its own sessionId; call GET /session to read it');
    }
    return requested ? validateSessionId(requested) : sessionId;
  }

  // Measured: /mnt/workspace does not exist for a session whose only activity is a
  // shell connection — it materialises on the first /invocations call. The browser
  // cannot make that call itself (SigV4 needs headers and a body hash), so this does,
  // and the transport blocks every face on the answer.
  async function invokeRuntime(target, payload) {
    const url = buildInvocationsUrl({ region, runtimeArn, qualifier });
    const body = JSON.stringify(payload);
    let refreshedCredentials = false;
    for (let attempt = 0; ; attempt += 1) {
      const headers = await signRequest({
        method: 'POST',
        url,
        region,
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: target },
        body,
        credentials: await currentCredentials(),
      });
      const result = await postJson(url, { ...headers, 'content-length': Buffer.byteLength(body) }, body);
      // A token can die between resolution and the request (clock skew or revocation).
      // Force one refresh; a second auth rejection is a human-action state, not a retry.
      if (isExpiredCredentials(result)) {
        if (refreshedCredentials) throw awsLoginRequired(new Error(result.body));
        refreshedCredentials = true;
        log('credentials expired mid-flight; refreshing once');
        await currentCredentials({ force: true });
        continue;
      }
      // RetryableConflictException is documented as brief and expected while the
      // service provisions or tears down a session, so a first 409 is not an answer.
      const retryable = result.statusCode === 409 || result.statusCode === 429 || result.statusCode >= 500;
      if (!retryable || attempt + 1 >= INVOKE_ATTEMPTS) return result;
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)));
    }
  }

  return {
    runtimeArn,
    region,
    qualifier,
    sessionId,
    expiresIn,
    pinSession,
    profile,
    faces: [0, 1, 2, 3, 4, 5].map(faceShellId),

    session() {
      return {
        sessionId,
        runtimeArn,
        region,
        qualifier,
        expiresIn,
        refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS,
      };
    },

    async prepare({ sessionId: requested, op = 'state' } = {}) {
      const target = targetSession(requested);
      const startedAt = Date.now();
      const result = await invokeRuntime(target, { op });
      const json = safeJson(result.body);
      if (result.statusCode >= 400) {
        log(`prepare ${target} FAILED HTTP ${result.statusCode}`);
        throw new CloudError(json?.message ?? result.body.slice(0, 400), { status: 502 });
      }
      const state = json?.state ?? 'unknown';
      log(`prepare ${target} op=${op} state=${state} in ${Date.now() - startedAt}ms`);
      return {
        sessionId: target,
        state,
        phase: json?.phase ?? null,
        elapsedMs: json?.elapsedMs ?? null,
        // The face -> terminal_id map the transport needs anyway, from the same call
        // that creates the mount. One call, both obligations.
        faces: Array.isArray(json?.faces) ? json.faces : [],
        // The container's own account of which panes hold a working agent. The browser
        // joins it to faces[].paneId to say "agent working — sleep paused"; dropping it
        // here would leave that permanently unprovable rather than merely unknown.
        busy: json?.busy ?? null,
        persistence: json?.persistence ?? null,
        invokedInMs: Date.now() - startedAt,
      };
    },

    async mint({ shellId: requestedShell, face, sessionId: requested } = {}) {
      const shellId = requestedShell ?? (face === null || face === undefined ? null : faceShellId(Number(face)));
      if (!shellId) throw new CloudError('pass ?shellId=face-1 or ?face=0');
      validateShellId(shellId);
      const target = targetSession(requested);
      const mintedAt = Date.now();
      // Presigning is pure local crypto: no AWS call, no cost, no latency.
      const url = await presignShellUrl({
        region,
        runtimeArn,
        shellId,
        sessionId: target,
        qualifier,
        expiresIn,
        credentials: await currentCredentials(),
        signer,
      });
      log(`mint ${shellId} session=${target} expires=${expiresIn}s`);
      return {
        url,
        shellId,
        sessionId: target,
        expiresIn,
        expiresAt: mintedAt + expiresIn * 1000,
        refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS,
      };
    },
  };
}

function isExpiredCredentials(result) {
  return result.statusCode === 403 && /expired|InvalidSignature|security token/i.test(result.body || '');
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      { method: 'POST', hostname: target.hostname, path: `${target.pathname}${target.search}`, headers },
      (result) => {
        const chunks = [];
        result.on('data', (chunk) => chunks.push(chunk));
        result.on('end', () => resolve({ statusCode: result.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    request.setTimeout(INVOKE_TIMEOUT_MS, () => request.destroy(new Error(`invocation timed out after ${INVOKE_TIMEOUT_MS}ms`)));
    request.on('error', reject);
    request.end(body);
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
