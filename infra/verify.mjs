// Self-check for the mint endpoint. Runs offline; touches no AWS.
//
//   node infra/verify.mjs
//
// Three things are worth proving before this function holds anyone's workspace open:
//
//   1. The zero-dependency SigV4 in infra/lambda/sigv4.mjs is byte-identical to
//      spike/harness/shell-client.mjs, which is the implementation already verified against
//      the live service. Rewriting a signer is only safe against an oracle.
//   2. The token verifier rejects the forgeries it exists to reject — alg none, alg
//      substitution, a tampered payload, a foreign issuer, a foreign app client.
//   3. A caller cannot reach a runtime that is not theirs, by any route the request can
//      express. This is the claim the whole design rests on, so it is tested by trying.

import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';

import { presignShellUrl as provenPresign, signRequest as provenSign } from '../spike/harness/shell-client.mjs';
import { buildInvocationsUrl, presignShellUrl, signHeaders } from './lambda/sigv4.mjs';

const REGION = 'us-east-1';
const USER_POOL_ID = 'us-east-1_TESTPOOL1';
const CLIENT_ID = '1example23client45id678';
const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const TABLE = 'coding-cube-workspaces';

const ALICE = '2f1c8a3e-4b5d-4f60-9a21-7c3e5d9b1a44';
const MALLORY = '9d7e6c5b-4a39-4827-b165-0f4e3d2c1b0a';
const ALICE_RUNTIME = `arn:aws:bedrock-agentcore:${REGION}:808175385344:runtime/cube_u_${ALICE.replace(/-/g, '_')}-AaBbCc1234`;
const MALLORY_RUNTIME = `arn:aws:bedrock-agentcore:${REGION}:808175385344:runtime/cube_u_${MALLORY.replace(/-/g, '_')}-DdEeFf5678`;

const registry = new Map([
  [`${ALICE}/default`, { runtime_arn: { S: ALICE_RUNTIME }, status: { S: 'ready' }, workspace_id: { S: 'default' } }],
  [`${MALLORY}/default`, { runtime_arn: { S: MALLORY_RUNTIME }, status: { S: 'ready' }, workspace_id: { S: 'default' } }],
]);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] };

let checks = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks += 1;
      process.stdout.write(`  ok  ${name}\n`);
    })
    .catch((error) => {
      process.stdout.write(`  FAIL ${name}\n       ${error.message}\n`);
      process.exitCode = 1;
    });
}

// ---------------------------------------------------------------- 1. SigV4 --

process.stdout.write('\nSigV4 parity with the implementation proven against live AgentCore\n');

const credentialSets = [
  { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  { accessKeyId: 'ASIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', sessionToken: 'FQoGZXIvYXdzEB//////////wEaDExAMPLE+token/with=padding' },
];
const date = new Date('2026-08-07T10:11:12.000Z');

for (const credentials of credentialSets) {
  const label = credentials.sessionToken ? 'temporary credentials' : 'long-lived credentials';
  await check(`presigned shell URL matches byte for byte (${label})`, async () => {
    const args = { region: REGION, runtimeArn: ALICE_RUNTIME, shellId: 'face-3', sessionId: `cube-default-${ALICE}`, qualifier: 'DEFAULT', expiresIn: 300, date };
    assert.equal(presignShellUrl({ ...args, credentials }), await provenPresign({ ...args, credentials, signer: 'raw' }));
  });
  await check(`signed /invocations headers match byte for byte (${label})`, async () => {
    const args = {
      method: 'POST',
      url: buildInvocationsUrl({ region: REGION, runtimeArn: ALICE_RUNTIME }),
      region: REGION,
      service: 'bedrock-agentcore',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': `cube-default-${ALICE}` },
      body: JSON.stringify({ op: 'state' }),
      credentials,
      date,
    };
    const proven = await provenSign(args);
    assert.equal(signHeaders(args).authorization, proven.authorization ?? proven.Authorization);
  });
  // The Worker path. site/lib/cloud.js signs /invocations with signer:'raw' because a
  // Cloudflare Function has no node and cannot carry @smithy, so the crypto.subtle branch has
  // to produce the same bytes as the branch that was proven against the live service.
  await check(`signRequest signer:'raw' matches the @smithy branch (${label})`, async () => {
    const args = {
      method: 'POST',
      url: buildInvocationsUrl({ region: REGION, runtimeArn: ALICE_RUNTIME }),
      region: REGION,
      service: 'bedrock-agentcore',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': `cube-default-${ALICE}` },
      body: JSON.stringify({ op: 'state', faces: 6 }),
      credentials,
      date,
    };
    const proven = await provenSign(args);
    const raw = await provenSign({ ...args, signer: 'raw' });
    assert.equal(raw.authorization, proven.authorization ?? proven.Authorization);
  });
}

await check('a presigned URL expiring beyond the 300s service maximum is refused', () => {
  assert.throws(() => presignShellUrl({ region: REGION, runtimeArn: ALICE_RUNTIME, shellId: 'face-1', sessionId: `cube-default-${ALICE}`, expiresIn: 900, credentials: credentialSets[0] }), /300/);
});

// ------------------------------------------------------- 2. token verifier --

// jwt.mjs and sigv4.mjs reach the network through the `https` module object, so replacing
// these two functions is enough to run the whole handler offline. No test seam exists in the
// production code, which is the point: what runs here is what deploys.
const realGet = https.get;
const realRequest = https.request;
let dynamoCalls = [];
let invocationCalls = [];

https.get = (url, callback) => {
  const response = Readable.from([Buffer.from(JSON.stringify(jwks))]);
  response.statusCode = String(url).includes(USER_POOL_ID) ? 200 : 404;
  queueMicrotask(() => callback(response));
  const call = new EventEmitter();
  call.setTimeout = () => call;
  call.destroy = () => call;
  return call;
};

https.request = (options, callback) => {
  const call = new EventEmitter();
  const chunks = [];
  call.setTimeout = () => call;
  call.destroy = () => call;
  call.write = (chunk) => chunks.push(chunk);
  call.end = () => {
    const payload = JSON.parse(Buffer.concat(chunks.map(Buffer.from)).toString('utf8') || '{}');
    let body = '{}';
    if (options.hostname.startsWith('dynamodb')) {
      dynamoCalls.push(payload);
      const key = `${payload.Key?.user_id?.S}/${payload.Key?.workspace_id?.S}`;
      body = JSON.stringify(registry.has(key) ? { Item: { user_id: { S: payload.Key.user_id.S }, ...registry.get(key) } } : {});
    } else {
      invocationCalls.push({ options, payload });
      body = JSON.stringify({ state: 'ready', faces: [1, 2, 3, 4, 5, 6], persistence: { durable: true } });
    }
    const response = Readable.from([Buffer.from(body)]);
    response.statusCode = 200;
    queueMicrotask(() => callback(response));
  };
  return call;
};

function sign(claims, { alg = 'RS256', kid = KID, key = privateKey } = {}) {
  const header = base64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  if (alg === 'none') return `${header}.${payload}.`;
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function base64url(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function accessToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub: ALICE, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, iat: now, exp: now + 3600, jti: randomUUID(), ...overrides });
}

const { AuthError, verifyCognitoAccessToken } = await import('./lambda/jwt.mjs');
const verify = (token) => verifyCognitoAccessToken(token, { region: REGION, userPoolId: USER_POOL_ID, clientId: CLIENT_ID });

process.stdout.write('\nCognito access-token verification\n');

await check('a well-formed token from the right pool and client is accepted', async () => {
  assert.equal((await verify(accessToken())).sub, ALICE);
});

const forgeries = [
  ['alg "none" is refused', () => sign({ sub: MALLORY, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: 4102444800 }, { alg: 'none' })],
  ['alg substitution to HS256 is refused', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'HS256', kid: KID, typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ sub: MALLORY, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: now + 3600 }));
    return `${header}.${payload}.${Buffer.from('forged').toString('base64url')}`;
  }],
  ['a tampered payload is refused', () => {
    const [header, , signature] = accessToken().split('.');
    const now = Math.floor(Date.now() / 1000);
    return `${header}.${base64url(JSON.stringify({ sub: MALLORY, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: now + 3600 }))}.${signature}`;
  }],
  ['a token signed by another key is refused', () => sign({ sub: ALICE, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600 }, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey })],
  ['an unknown kid is refused', () => sign({ sub: ALICE, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600 }, { kid: 'not-in-the-jwks' })],
  ['another pool\'s issuer is refused', () => accessToken({ iss: `https://cognito-idp.${REGION}.amazonaws.com/us-east-1_OTHERPOOL` })],
  ['another app client is refused', () => accessToken({ client_id: 'someone-elses-client' })],
  ['an id token presented as an access token is refused', () => accessToken({ token_use: 'id' })],
  ['an expired token is refused', () => accessToken({ exp: Math.floor(Date.now() / 1000) - 3600 })],
  ['a token with no sub is refused', () => accessToken({ sub: undefined })],
  ['a non-JWS string is refused', () => 'not.a.token.at.all'],
];

for (const [name, make] of forgeries) {
  await check(name, async () => {
    await assert.rejects(() => verify(make()), (error) => error instanceof AuthError);
  });
}

// -------------------------------------------------------- 3. the boundary --

process.env.CUBE_REGION = REGION;
process.env.AWS_REGION = REGION;
process.env.CUBE_TABLE = TABLE;
process.env.CUBE_USER_POOL_ID = USER_POOL_ID;
process.env.CUBE_APP_CLIENT_ID = CLIENT_ID;
process.env.CUBE_ALLOWED_ORIGINS = 'https://codingcube.codyh.xyz';
process.env.AWS_ACCESS_KEY_ID = 'ASIAIOSFODNN7EXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
process.env.AWS_SESSION_TOKEN = 'IQoJb3JpZ2luX2VjEXAMPLE';

const { handler } = await import('./lambda/mint.mjs');

function request(path, { token, query = {}, headers = {} } = {}) {
  dynamoCalls = [];
  invocationCalls = [];
  return handler({
    rawPath: path,
    requestContext: { http: { method: 'GET', path } },
    queryStringParameters: query,
    headers: { origin: 'https://codingcube.codyh.xyz', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

const json = (response) => JSON.parse(response.body || '{}');

process.stdout.write('\nThe authorization boundary\n');

await check('an unauthenticated /mint is 401', async () => {
  assert.equal((await request('/mint', { query: { shellId: 'face-1' } })).statusCode, 401);
});

await check('a forged token cannot mint', async () => {
  const forged = sign({ sub: ALICE, iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: 4102444800 }, { alg: 'none' });
  assert.equal((await request('/mint', { token: forged, query: { shellId: 'face-1' } })).statusCode, 401);
});

await check('a valid token mints only against its own runtime', async () => {
  const response = await request('/mint', { token: accessToken(), query: { shellId: 'face-2' } });
  assert.equal(response.statusCode, 200);
  const body = json(response);
  assert.ok(body.url.includes(encodeURIComponent(ALICE_RUNTIME)), 'the signed URL names Alice\'s runtime');
  assert.ok(!body.url.includes(encodeURIComponent(MALLORY_RUNTIME)));
  assert.equal(body.shellId, 'face-2');
  assert.ok(body.url.startsWith('wss://'));
});

await check('the DynamoDB partition key is always the verified sub, never anything from the request', async () => {
  await request('/mint', { token: accessToken(), query: { shellId: 'face-1', user_id: MALLORY, userId: MALLORY, sub: MALLORY } });
  const reads = dynamoCalls.filter((call) => call.Key);
  assert.ok(reads.length >= 1);
  for (const call of reads) assert.equal(call.Key.user_id.S, ALICE);
});

await check('naming another user\'s session id does not reach their runtime', async () => {
  const body = json(await request('/mint', { token: accessToken(), query: { shellId: 'face-1', sessionId: `cube-default-${MALLORY}` } }));
  // The session id is honoured — it is the caller's own choice of microVM — but the runtime
  // it lands on is Alice's, because the ARN came from Alice's registry row and not from here.
  assert.ok(body.url.includes(encodeURIComponent(ALICE_RUNTIME)));
  assert.ok(!body.url.includes(encodeURIComponent(MALLORY_RUNTIME)));
});

await check('a workspace id outside the caller\'s own row is a 404, not someone else\'s cube', async () => {
  const response = await request('/mint', { token: accessToken(), query: { shellId: 'face-1', workspaceId: 'mallorys-cube' } });
  assert.equal(response.statusCode, 404);
  assert.equal(dynamoCalls[0].Key.user_id.S, ALICE);
});

await check('a caller with no provisioned workspace is a 404', async () => {
  const stranger = sign({ sub: '00000000-0000-4000-8000-000000000000', iss: ISSUER, token_use: 'access', client_id: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600 });
  assert.equal((await request('/session', { token: stranger })).statusCode, 404);
});

await check('shellId is a closed set of six faces', async () => {
  const token = accessToken();
  for (const shellId of ['face-7', 'face-0', '../face-1', 'admin', '']) {
    assert.equal((await request('/mint', { token, query: { shellId } })).statusCode, 400, `${shellId} should be refused`);
  }
  for (let face = 0; face < 6; face += 1) {
    const response = await request('/mint', { token, query: { face: String(face) } });
    assert.equal(response.statusCode, 200);
    assert.equal(json(response).shellId, `face-${face + 1}`);
  }
});

await check('/prepare invokes the caller\'s own runtime and returns the face map', async () => {
  const response = await request('/prepare', { token: accessToken() });
  assert.equal(response.statusCode, 200);
  assert.equal(json(response).state, 'ready');
  assert.equal(json(response).faces.length, 6);
  assert.equal(invocationCalls.length, 1);
  // The wire path is singly encoded; the second layer exists only inside the canonical
  // request the signature is computed over.
  assert.ok(invocationCalls[0].options.path.includes(encodeURIComponent(ALICE_RUNTIME)));
  assert.ok(!invocationCalls[0].options.path.includes(encodeURIComponent(MALLORY_RUNTIME)));
});

await check('an unlisted origin is refused before the token is even read', async () => {
  const response = await request('/mint', { token: accessToken(), query: { shellId: 'face-1' }, headers: { origin: 'https://evil.example' } });
  assert.equal(response.statusCode, 403);
});

await check('an unknown route is a 404', async () => {
  assert.equal((await request('/admin', { token: accessToken() })).statusCode, 404);
});

await check('the response carries no cache and no Set-Cookie', async () => {
  const response = await request('/mint', { token: accessToken(), query: { shellId: 'face-1' } });
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
});

https.get = realGet;
https.request = realRequest;

process.stdout.write(`\n${process.exitCode ? 'FAILED' : `${checks} checks passed`}\n\n`);
