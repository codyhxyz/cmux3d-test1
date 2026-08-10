// What /session, /prepare and /mint answer with — the shapes, and nothing that fetches.
//
// Two servers implement those three routes. The Pages Functions serve the public site
// (site/lib/cloud.js): static Cloudflare secrets, signed over fetch(), no node at all. The
// loopback gateway serves a checkout (src/server/cloud/mint.js): the AWS provider chain,
// signed over node:https, with a mid-flight credential refresh. They differ in everything
// around the edges and in nothing about what comes back, because the browser reaching them
// is the same browser and it must not meet two dialects of one API depending on which
// server answered.
//
// That is the whole reason this file exists rather than the shapes living twice. The two
// copies were identical for 33 lines including the prose, and only one of them is on the
// public internet — so a field added to the tested loopback copy and forgotten on the
// hosted one would have failed for strangers first and for `npm run smoke` never.
//
// A leaf on purpose: face-count.js and agentcore-protocol.js are themselves leaves, so
// this imports no signer, no transport and nothing from node. It is safe in a Worker for
// the same reason it is cheap in a test.

import { MAX_PRESIGN_EXPIRY_SECONDS } from '../public/app/agentcore-protocol.js';
import { DEFAULT_FACE_COUNT, MAX_FACE_COUNT, MIN_FACE_COUNT } from '../public/app/face-count.js';

// How long before expiry the browser is told to re-mint. A presigned URL lives at most
// MAX_PRESIGN_EXPIRY_SECONDS, and a reconnect that starts after it has lapsed is a face
// that simply never opens.
export const REFRESH_MARGIN_SECONDS = 30;
export const SESSION_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';
export const INVOKE_ATTEMPTS = 4;

// AgentCore refuses anything longer, so an operator-supplied expiry is clamped rather than
// rejected: the number is a tuning knob, not a reason to serve no terminals.
export function clampExpiry(value) {
  return Math.min(Number(value) || MAX_PRESIGN_EXPIRY_SECONDS, MAX_PRESIGN_EXPIRY_SECONDS);
}

export function sessionReply({ sessionId, runtimeArn, region, qualifier, expiresIn }) {
  return {
    sessionId,
    runtimeArn,
    region,
    qualifier,
    expiresIn,
    refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS,
  };
}

export function mintReply({ url, shellId, sessionId, expiresIn, mintedAt }) {
  return {
    url,
    shellId,
    sessionId,
    expiresIn,
    expiresAt: mintedAt + expiresIn * 1000,
    refreshAfterSeconds: expiresIn - REFRESH_MARGIN_SECONDS,
  };
}

/**
 * The answer to the one /invocations call that materialises /mnt/workspace. Every face
 * blocks on it, so it carries the face -> terminal_id map the transport needs anyway.
 *
 * @param {object} args
 * @param {string} args.sessionId  the session actually invoked, never the one requested
 * @param {object|null} args.json  the runtime's parsed body, or null if it was not JSON
 * @param {object} args.request    clampFaceCount() output: { faces, requested, clamped }
 * @param {number} args.elapsedMs  wall time of the invocation
 */
export function prepareReply({ sessionId, json, request, elapsedMs }) {
  const servedFaces = Array.isArray(json?.faces) ? json.faces : [];
  return {
    sessionId,
    state: json?.state ?? 'unknown',
    phase: json?.phase ?? null,
    elapsedMs: json?.elapsedMs ?? null,
    faces: servedFaces,
    // What the container actually served, never what it was asked for. A container image
    // that predates the setting ignores `faces`, answers six and reports no faceCount at
    // all — echoing the request back would claim ten faces over an array of six, and every
    // consumer would be reading a number no pane exists for. faces[] is the ground truth.
    faceCount: servedFaces.length || (Number.isFinite(json?.faceCount) ? json.faceCount : request.faces),
    facesRequested: request.requested,
    facesClamped: request.clamped || json?.facesClamped === true,
    faceLimits: json?.faceLimits ?? { min: MIN_FACE_COUNT, max: MAX_FACE_COUNT, default: DEFAULT_FACE_COUNT },
    // The container's own account of which panes hold a working agent. The browser joins it
    // to faces[].paneId to say "agent working — sleep paused"; dropping it would leave that
    // permanently unprovable rather than merely unknown.
    busy: json?.busy ?? null,
    persistence: json?.persistence ?? null,
    invokedInMs: elapsedMs,
  };
}

// RetryableConflictException is documented as brief and expected while the service
// provisions or tears down a session, so a first 409 is not an answer.
export function retryableStatus(status) {
  return status === 409 || status === 429 || status >= 500;
}

export function retryDelayMs(attempt) {
  return Math.min(500 * 2 ** attempt, 8000);
}

export function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
