// Cognito access-token verification, on node:crypto only.
//
// The HTTP API in front of this Lambda already has a JWT authorizer, so this is the second
// of two independent checks. It is not redundant belt-and-braces: the day someone adds a
// Lambda Function URL, an ALB target, or a test route without the authorizer, this file is
// what still refuses. The handler treats a missing or unverifiable token as fatal, never as
// "the gateway must have checked it".

import { createPublicKey, createVerify } from 'node:crypto';
import https from 'node:https';

const CLOCK_SKEW_SECONDS = 60;
const JWKS_TTL_MS = 3_600_000;
const JWKS_MIN_REFETCH_MS = 60_000;

const jwks = { keys: new Map(), fetchedAt: 0, lastAttemptAt: 0, inflight: null };

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function verifyCognitoAccessToken(token, { region, userPoolId, clientId, now = Date.now() }) {
  if (typeof token !== 'string' || !token) throw new AuthError('no bearer token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('token is not a three-part JWS');

  const header = decodeSegment(parts[0], 'header');
  // Named algorithm, never "whatever the token says". `none` forges any claim set, and
  // accepting HS256 lets an attacker sign with the RSA public key as an HMAC secret — the
  // two classic JWT breaks, both closed by refusing to look at anything but RS256.
  if (header.alg !== 'RS256') throw new AuthError(`unsupported alg ${header.alg}; only RS256 is accepted`);
  if (!header.kid) throw new AuthError('token header has no kid');

  const key = await publicKeyFor(header.kid, { region, userPoolId });
  const verifier = createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`);
  if (!verifier.verify(key, Buffer.from(parts[2], 'base64url'))) throw new AuthError('signature does not verify');

  const claims = decodeSegment(parts[1], 'payload');
  const seconds = Math.floor(now / 1000);
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  if (claims.iss !== issuer) throw new AuthError(`issuer ${claims.iss} is not ${issuer}`);
  // Access tokens carry client_id; id tokens carry aud. Pinning token_use closes the swap.
  if (claims.token_use !== 'access') throw new AuthError(`token_use ${claims.token_use} is not access`);
  if (claims.client_id !== clientId) throw new AuthError('token was issued to a different app client');
  if (typeof claims.exp !== 'number' || seconds > claims.exp + CLOCK_SKEW_SECONDS) throw new AuthError('token has expired');
  if (typeof claims.nbf === 'number' && seconds < claims.nbf - CLOCK_SKEW_SECONDS) throw new AuthError('token is not valid yet');
  if (typeof claims.iat === 'number' && seconds < claims.iat - CLOCK_SKEW_SECONDS) throw new AuthError('token is dated in the future');
  // `sub` is the immutable pool-scoped user id and the only identifier used downstream.
  // Usernames and emails are mutable and can be re-registered; a workspace keyed on either
  // would follow the name to whoever holds it next.
  if (typeof claims.sub !== 'string' || claims.sub.length < 8) throw new AuthError('token has no usable sub');

  return claims;
}

function decodeSegment(segment, what) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new AuthError(`token ${what} is not JSON`);
  }
}

async function publicKeyFor(kid, options) {
  const fresh = Date.now() - jwks.fetchedAt < JWKS_TTL_MS;
  if (fresh && jwks.keys.has(kid)) return jwks.keys.get(kid);
  // A kid we have never seen is either a genuine Cognito rotation or a forged header. Both
  // arrive as a cache miss, so the refetch is rate-limited: without the floor, a flood of
  // junk kids turns this Lambda into a load generator against Cognito and burns its own
  // concurrency waiting on the network.
  if (!fresh || Date.now() - jwks.lastAttemptAt > JWKS_MIN_REFETCH_MS) await refreshJwks(options);
  const key = jwks.keys.get(kid);
  if (!key) throw new AuthError(`no signing key ${kid} in the pool's JWKS`);
  return key;
}

async function refreshJwks({ region, userPoolId }) {
  if (jwks.inflight) return jwks.inflight;
  jwks.lastAttemptAt = Date.now();
  jwks.inflight = (async () => {
    const url = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
    const document = JSON.parse(await get(url));
    const keys = new Map();
    for (const jwk of document.keys ?? []) {
      if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256')) continue;
      keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    }
    if (!keys.size) throw new AuthError('the pool published no usable RS256 keys');
    jwks.keys = keys;
    jwks.fetchedAt = Date.now();
  })().finally(() => {
    jwks.inflight = null;
  });
  return jwks.inflight;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const call = https.get(url, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new AuthError(`JWKS fetch returned ${response.statusCode}`));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    call.setTimeout(5000, () => call.destroy(new AuthError('JWKS fetch timed out')));
    call.on('error', reject);
  });
}
