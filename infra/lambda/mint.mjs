// The authorize-then-mint endpoint. This file is the entire security boundary of multi-user
// Coding Cube, so read the next four paragraphs before changing anything in it.
//
// A browser cannot authenticate to AgentCore. SigV4 needs headers a WebSocket upgrade
// cannot carry, so the only thing a browser can hold is a presigned URL, and those live at
// most 300 seconds. Something server-side has to sign one per face per reconnect.
//
// The obvious alternative — customJWTAuthorizer on the runtime, so the browser presents its
// Cognito token directly — is NOT securable and was ruled out against the service model, not
// guessed at. AgentCore enforces no mapping between a token and a runtimeSessionId, and
// there is no IAM condition key for the session id. Any valid token could therefore name any
// session and attach to another user's workspace. Presigning is the only place identity can
// be bound to a target, so it is the only design here.
//
// The binding works like this, and it is a property of the key shape rather than of a
// comparison somebody has to remember to write:
//
//   1. `sub` comes from a verified RS256 signature over the token, twice — once at the HTTP
//      API's JWT authorizer and once in jwt.mjs. Nothing else in the request can set it.
//   2. That `sub` is the DynamoDB PARTITION key. The client can influence the sort key
//      (which workspace of its own) and nothing else. There is no query, no scan and no
//      secondary index in workspaces.mjs, so "somebody else's row" is not expressible.
//   3. The runtime ARN that gets signed comes from that row. It is never read from the
//      request — not from a header, not from a query parameter, not from a body.
//   4. Runtime, session and shell are all inside the SigV4 signature. Editing any of them
//      in the returned URL invalidates it, so the decision made here survives the URL
//      leaving this process.
//
// The isolation that makes step 3 sufficient is physical, not conventional: one EFS access
// point and one agent runtime per user, and the per-user execution role can only mount
// *through* its own access point (elasticfilesystem:AccessPointArn condition). A session id
// selects a microVM within a runtime that is already the caller's, which is why it is safe
// for the client to keep choosing it — see resolveSessionId.

import { AuthError, verifyCognitoAccessToken } from './jwt.mjs';
import {
  buildInvocationsUrl,
  credentialsFromEnvironment,
  MAX_PRESIGN_EXPIRY_SECONDS,
  presignShellUrl,
  signedFetch,
  validateSessionId,
} from './sigv4.mjs';
import { loadWorkspace, normalizeWorkspaceId, recordSession } from './workspaces.mjs';

const REFRESH_MARGIN_SECONDS = 30;
const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
// The Cube has six faces and shellIds are deterministic, so this is a closed set. An
// allowlist rather than a pattern: an arbitrary shellId is a degree of freedom the product
// does not need, and every extra shell counts against the 10-per-session cap.
const FACE_SHELL_IDS = Object.freeze(['face-1', 'face-2', 'face-3', 'face-4', 'face-5', 'face-6']);

const REGION = process.env.CUBE_REGION ?? process.env.AWS_REGION;
const TABLE = required('CUBE_TABLE');
const USER_POOL_ID = required('CUBE_USER_POOL_ID');
const CLIENT_ID = required('CUBE_APP_CLIENT_ID');
const QUALIFIER = process.env.CUBE_QUALIFIER ?? 'DEFAULT';
const EXPIRES_IN = Math.min(Number(process.env.CUBE_EXPIRES_IN ?? MAX_PRESIGN_EXPIRY_SECONDS), MAX_PRESIGN_EXPIRY_SECONDS);
// free   — the client keeps naming its own session id, as it does today. Safe because the
//          runtime it lands on is the caller's either way. Zero client change.
// pinned — one session id per workspace, server-chosen. Stops a browser with cleared
//          localStorage from booting a second microVM onto the same EFS workspace, which is
//          both a second $0.22/hour and two herdr instances on one socket directory.
const SESSION_POLICY = process.env.CUBE_SESSION_POLICY === 'pinned' ? 'pinned' : 'free';
const ALLOWED_ORIGINS = new Set(
  String(process.env.CUBE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured on this function`);
  return value;
}

export async function handler(event) {
  const startedAt = Date.now();
  const origin = event.headers?.origin;
  const route = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  const method = event.requestContext?.http?.method ?? 'GET';
  const log = { route, method };

  try {
    // CORS is hygiene here, not the boundary — this API takes a bearer token and no cookies,
    // so a browser's origin rules protect nothing a stolen token would not bypass anyway.
    // It stays because an unlisted origin means a page nobody deployed is calling, and that
    // is worth a 403 and a log line rather than a silent success.
    if (origin && ALLOWED_ORIGINS.size && !ALLOWED_ORIGINS.has(origin)) {
      throw new HttpError(403, `origin ${origin} is not allowed`);
    }
    if (method === 'OPTIONS') return respond(204, null, origin);

    const identity = await authorize(event);
    log.sub = identity.sub;

    const query = event.queryStringParameters ?? {};
    const workspaceId = normalizeWorkspaceId(query.workspaceId);
    log.workspaceId = workspaceId;

    const workspace = await loadWorkspace({ table: TABLE, region: REGION, userId: identity.sub, workspaceId });
    if (!workspace) throw new HttpError(404, 'no workspace is provisioned for this account');
    if (!workspace.runtimeArn) throw new HttpError(409, 'this workspace has no agent runtime yet');
    if (workspace.status !== 'ready') throw new HttpError(409, `workspace status is ${workspace.status}`);

    const sessionId = resolveSessionId({ requested: query.sessionId, workspace });
    log.sessionId = sessionId;

    switch (route) {
      case '/session':
        return respond(200, sessionPayload(workspace, sessionId), origin);
      case '/prepare':
        return respond(200, await prepare(workspace, sessionId, query.op ?? 'state'), origin);
      case '/mint':
        return respond(200, await mint(workspace, sessionId, shellIdFrom(query)), origin, { 'cache-control': 'no-store' });
      default:
        throw new HttpError(404, 'try GET /session, GET /prepare, or GET /mint?shellId=face-1');
    }
  } catch (error) {
    const status = error instanceof AuthError ? 401 : (error.status ?? 500);
    log.status = status;
    log.error = error.message;
    // 500s are ours, so the caller gets nothing but the status; anything else is a client
    // error whose message is the whole point of returning it.
    const body = status === 500
      ? { error: 'internal error' }
      : { error: error.message, ...(error.extra ?? {}) };
    return respond(status, body, origin);
  } finally {
    log.ms = Date.now() - startedAt;
    // The presigned URL and the bearer token are credentials and never enter this line.
    console.log(JSON.stringify(log));
  }
}

// The only source of identity in this file. Everything downstream takes `sub` from what
// this returns; nothing downstream is allowed to look at the event again for it.
async function authorize(event) {
  const header = event.headers?.authorization ?? event.headers?.Authorization ?? '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (!token) throw new AuthError('missing Authorization: Bearer <token>');

  const claims = await verifyCognitoAccessToken(token, { region: REGION, userPoolId: USER_POOL_ID, clientId: CLIENT_ID });

  // The gateway's authorizer verified the same token independently. If the two disagree the
  // request has been reshaped between them and the only safe answer is to stop.
  const gatewaySub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (gatewaySub && gatewaySub !== claims.sub) throw new AuthError('gateway and function disagree about the caller');

  return claims;
}

// A session id names a microVM *within a runtime*, and the runtime is already established as
// the caller's by the DynamoDB lookup above. It therefore grants nothing on its own, which
// is why `free` can hand the choice back to the browser and keep the client unchanged. What
// it does control is how many microVMs one workspace has, hence `pinned`.
function resolveSessionId({ requested, workspace }) {
  const pinned = workspace.runtimeSessionId ?? deriveSessionId(workspace);
  if (SESSION_POLICY === 'pinned') {
    if (requested && requested !== pinned) {
      throw new HttpError(409, 'this workspace is pinned to one session; use the id returned here', { sessionId: pinned });
    }
    return pinned;
  }
  return requested ? validateSessionId(requested) : pinned;
}

// Deterministic so a workspace that has never been used still has one stable answer, and so
// two concurrent first requests cannot disagree. 33-character minimum is satisfied by the
// prefix plus a Cognito sub (36 chars) on its own.
function deriveSessionId(workspace) {
  return validateSessionId(`cube-${workspace.workspaceId}-${workspace.userId}`);
}

function shellIdFrom(query) {
  const face = query.face;
  const shellId = query.shellId ?? (face === undefined ? null : FACE_SHELL_IDS[Number(face)]);
  if (!FACE_SHELL_IDS.includes(shellId)) {
    throw new HttpError(400, `shellId must be one of ${FACE_SHELL_IDS.join(', ')} (or face=0..${FACE_SHELL_IDS.length - 1})`);
  }
  return shellId;
}

function sessionPayload(workspace, sessionId) {
  return {
    sessionId,
    runtimeArn: workspace.runtimeArn,
    region: REGION,
    qualifier: QUALIFIER,
    expiresIn: EXPIRES_IN,
    refreshAfterSeconds: EXPIRES_IN - REFRESH_MARGIN_SECONDS,
    workspaceId: workspace.workspaceId,
    sessionPolicy: SESSION_POLICY,
  };
}

async function mint(workspace, sessionId, shellId) {
  const mintedAt = Date.now();
  const url = presignShellUrl({
    region: REGION,
    runtimeArn: workspace.runtimeArn,
    shellId,
    sessionId,
    qualifier: QUALIFIER,
    expiresIn: EXPIRES_IN,
    credentials: credentialsFromEnvironment(),
  });
  await noteSession(workspace, sessionId);
  return {
    url,
    shellId,
    sessionId,
    expiresIn: EXPIRES_IN,
    expiresAt: mintedAt + EXPIRES_IN * 1000,
    refreshAfterSeconds: EXPIRES_IN - REFRESH_MARGIN_SECONDS,
  };
}

// /mnt/workspace materialises on the first /invocations call and not before, so every client
// must invoke once before attaching shells. The same call returns the face -> terminal_id
// map the transport needs anyway — one call, both obligations.
async function prepare(workspace, sessionId, op) {
  const startedAt = Date.now();
  const response = await signedFetch({
    method: 'POST',
    url: buildInvocationsUrl({ region: REGION, runtimeArn: workspace.runtimeArn, qualifier: QUALIFIER }),
    region: REGION,
    service: 'bedrock-agentcore',
    headers: { 'content-type': 'application/json', accept: 'application/json', [SESSION_HEADER]: sessionId },
    body: JSON.stringify({ op: String(op).slice(0, 64) }),
    credentials: credentialsFromEnvironment(),
  });

  const json = safeJson(response.body);
  if (response.statusCode >= 400) {
    throw new HttpError(502, json?.message ?? `runtime returned ${response.statusCode}`, { statusCode: response.statusCode, sessionId });
  }
  await noteSession(workspace, sessionId);
  return {
    sessionId,
    state: json?.state ?? 'unknown',
    phase: json?.phase ?? null,
    elapsedMs: json?.elapsedMs ?? null,
    faces: Array.isArray(json?.faces) ? json.faces : [],
    // Same field the single-operator minter forwards. The browser joins busy.panes to
    // faces[].paneId for "agent working — sleep paused"; dropping it here would make the
    // multi-user path quietly less honest than the loopback one it replaces.
    busy: json?.busy ?? null,
    persistence: json?.persistence ?? null,
    invokedInMs: Date.now() - startedAt,
  };
}

// Bookkeeping only, and never allowed to fail the request: the URL is already signed and
// correct, and a workspace whose recorded session is one reconnect stale costs nothing. Six
// faces re-minting every 270 seconds would otherwise write the same value ~7,000 times a
// month per user, so the write is skipped whenever the row already says this.
async function noteSession(workspace, sessionId) {
  if (workspace.runtimeSessionId === sessionId) return;
  await recordSession({ table: TABLE, region: REGION, userId: workspace.userId, workspaceId: workspace.workspaceId, sessionId })
    .catch((error) => console.log(JSON.stringify({ warn: 'recordSession failed', message: error.message })));
}

function respond(status, body, origin, extra = {}) {
  const headers = { ...extra };
  if (body !== null) headers['content-type'] = 'application/json';
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'origin';
  }
  return { statusCode: status, headers, body: body === null ? '' : JSON.stringify(body) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
