// SigV4 on node:crypto, so the mint Lambda deploys as a zip of four source files with no
// npm install, no bundler and no dependency that can drift from what was reviewed. The
// canonical-request construction here is the one already verified byte-correct against the
// live service in spike/harness/shell-client.mjs — in particular the double-encoded path,
// which is required because the runtime ARN is already percent-encoded in the URI.

import { createHash, createHmac } from 'node:crypto';
import https from 'node:https';

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SESSION_ID_PARAM = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id';

export const MAX_PRESIGN_EXPIRY_SECONDS = 300;
export const MIN_SESSION_ID_LENGTH = 33;
export const MAX_SESSION_ID_LENGTH = 256;

// Read per call, never cached: Lambda rewrites these in place when the execution role's
// credentials rotate, and a container that cached them at module load signs with expired
// keys for the rest of its life.
export function credentialsFromEnvironment() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('no AWS credentials in the Lambda environment');
  return { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN };
}

export function dataPlaneHost(region) {
  if (!region) throw new Error('region is required');
  return `bedrock-agentcore.${region}.amazonaws.com`;
}

export function validateSessionId(sessionId) {
  const value = String(sessionId ?? '');
  if (value.length < MIN_SESSION_ID_LENGTH || value.length > MAX_SESSION_ID_LENGTH) {
    throw new Error(`runtimeSessionId must be ${MIN_SESSION_ID_LENGTH}-${MAX_SESSION_ID_LENGTH} characters; got ${value.length}`);
  }
  return value;
}

// The three values a shell URL grants access to — runtime, session, shell — all ride in the
// signed query string. A client that edits any of them invalidates the signature, which is
// what makes the authorization decision in mint.mjs stick after the URL leaves the Lambda.
export function presignShellUrl({
  region,
  runtimeArn,
  shellId,
  sessionId,
  qualifier = 'DEFAULT',
  expiresIn = MAX_PRESIGN_EXPIRY_SECONDS,
  credentials,
  date = new Date(),
}) {
  if (expiresIn > MAX_PRESIGN_EXPIRY_SECONDS) {
    throw new Error(`presigned URLs expire after at most ${MAX_PRESIGN_EXPIRY_SECONDS}s; got ${expiresIn}`);
  }
  validateSessionId(sessionId);
  const host = dataPlaneHost(region);
  const path = `/runtimes/${encodeURIComponent(runtimeArn)}/ws/shells`;
  const query = new Map([
    ['qualifier', qualifier],
    ['shellId', shellId],
    [SESSION_ID_PARAM, sessionId],
  ]);
  const canonicalQuery = presignQuery({
    method: 'GET',
    host,
    path,
    query,
    region,
    service: 'bedrock-agentcore',
    credentials,
    expiresIn,
    date,
  });
  return `wss://${host}${path}?${canonicalQuery}`;
}

export function buildInvocationsUrl({ region, runtimeArn, qualifier = 'DEFAULT' }) {
  return `https://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/invocations?qualifier=${encodeURIComponent(qualifier)}`;
}

export function buildStopSessionUrl({ region, runtimeArn, qualifier = 'DEFAULT' }) {
  return `https://${dataPlaneHost(region)}/runtimes/${encodeURIComponent(runtimeArn)}/stopruntimesession?qualifier=${encodeURIComponent(qualifier)}`;
}

// SigV4 header auth for the two calls the Lambda makes itself: DynamoDB and /invocations.
export async function signedFetch({ method = 'POST', url, region, service, headers = {}, body = '', credentials, timeoutMs = 45_000 }) {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return request({ method, target, headers: signHeaders({ method, url, region, service, headers, body: payload, credentials }), payload, timeoutMs });
}

// Split out from signedFetch so the signature can be compared against the @smithy signer
// without making a network call. Returns the headers to put on the wire, host excluded —
// node's https client sets that from the URL and would otherwise send it twice.
export function signHeaders({ method = 'POST', url, region, service, headers = {}, body = '', credentials, date = new Date() }) {
  const target = new URL(url);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const { longDate, shortDate } = formatDate(date);
  const scope = `${shortDate}/${region}/${service}/aws4_request`;

  const signable = new Map();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) signable.set(name.toLowerCase(), String(value).trim());
  }
  const payloadHash = payload ? sha256Hex(payload) : EMPTY_BODY_SHA256;
  signable.set('host', target.host);
  signable.set('x-amz-date', longDate);
  // Optional for non-S3 services, but @smithy's signer sends and signs it, and @smithy is
  // what the working spike minter uses against this same endpoint. Matching it byte for byte
  // is what lets infra/lambda/sigv4.mjs be diffed against a known-good oracle.
  signable.set('x-amz-content-sha256', payloadHash);
  if (credentials.sessionToken) signable.set('x-amz-security-token', credentials.sessionToken);

  const names = [...signable.keys()].sort();
  const canonicalHeaders = names.map((name) => `${name}:${signable.get(name)}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = canonicalQueryString(new Map([...target.searchParams.entries()]));

  const canonicalRequest = [method, canonicalUri(target.pathname), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', longDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = signingKey(credentials.secretAccessKey, shortDate, region, service, stringToSign);

  const wire = Object.fromEntries(names.map((name) => [name, signable.get(name)]));
  wire.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete wire.host;
  return wire;
}

function request({ method, target, headers, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const call = https.request(
      { method, hostname: target.hostname, path: `${target.pathname}${target.search}`, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    call.setTimeout(timeoutMs, () => call.destroy(new Error(`request to ${target.host} timed out after ${timeoutMs}ms`)));
    call.on('error', reject);
    if (payload) call.write(payload);
    call.end();
  });
}

function presignQuery({ method, host, path, query, region, service, credentials, expiresIn, date }) {
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
  // botocore's SigV4QueryAuth hashes an empty body rather than sending UNSIGNED-PAYLOAD for
  // https URLs, and that is the oracle this must match.
  const canonicalRequest = [method, canonicalUri(path), canonicalQuery, `host:${host}\n`, 'host', EMPTY_BODY_SHA256].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', longDate, scope, sha256Hex(canonicalRequest)].join('\n');
  return `${canonicalQuery}&X-Amz-Signature=${signingKey(credentials.secretAccessKey, shortDate, region, service, stringToSign)}`;
}

function canonicalQueryString(params) {
  return [...params.entries()]
    .map(([key, value]) => [escapeUri(key), escapeUri(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

// Non-S3 services double-encode the canonical path; the ARN in the path is already
// percent-encoded, so its %3A becomes %253A here.
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

function signingKey(secretAccessKey, shortDate, region, service, stringToSign) {
  let key = Buffer.from(`AWS4${secretAccessKey}`, 'utf8');
  for (const part of [shortDate, region, service, 'aws4_request']) key = createHmac('sha256', key).update(part, 'utf8').digest();
  return createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex');
}

function sha256Hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}
