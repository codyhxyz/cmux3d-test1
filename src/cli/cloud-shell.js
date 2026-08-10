#!/usr/bin/env node
// The cloud connection on its own: a shell on the AgentCore workspace, in this terminal.
// No browser, no gateway, no pairing code, and no cube — the rotating six-shell GUI is a
// separate module that happens to reach the same machine, and nothing here depends on it.
//
// The website needs a minter because a browser cannot hold AWS credentials and an https
// page cannot fetch 127.0.0.1. Neither constraint applies to a terminal: this process has
// the credentials, so it signs its own shell URL and connects straight to AgentCore.
//
// Files live on /mnt/workspace, one filesystem for the whole runtime. Both clients land
// in the same files; only the way in differs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { readCloudOptions } from '../server/config.js';
import { stateDir } from '../server/token-store.js';
import {
  buildInvocationsUrl,
  faceShellId,
  openShellSession,
  presignShellUrl,
  signRequest,
} from '../../spike/harness/shell-client.mjs';

// The session id the hosted site derives for its single operator (site/lib/cloud.js).
// Defaulting to it is what makes this terminal and the website's Cloud face land in one
// workspace rather than two that merely look alike.
const OPERATOR = 'operator';

async function operatorSessionId() {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(OPERATOR));
  return `cube-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

// Named once, remembered after. Nothing else about this command has to be typed, and a
// command you have to look up is one you do not run.
function stateFile(name) {
  return path.join(stateDir(), name);
}

function remembered(name) {
  try {
    return fs.readFileSync(stateFile(name), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function remember(name, value) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile(name), `${value}\n`, { mode: 0o600 });
}

function usage() {
  return [
    'usage: cloud [--face N] [--runtime-arn ARN] [--session ID]',
    '',
    'No runtime ARN. Name it once and it is remembered in ~/.coding-cube/runtime:',
    '',
    '  cloud --runtime-arn arn:aws:bedrock-agentcore:us-east-1:ACCOUNT:runtime/NAME-ID',
    '',
    'spike/aws/create-runtime.sh builds one and prints its ARN.',
  ].join('\n');
}

const note = (line) => process.stderr.write(`${line}\n`);

// /mnt/workspace materialises on the first /invocations call and not on a shell
// connection, so a shell opened before this runs would type into storage that evaporates
// at the idle timeout — with no error, which is the whole reason it is awaited here.
async function prepare({ region, runtimeArn, qualifier, sessionId }) {
  const url = buildInvocationsUrl({ region, runtimeArn, qualifier });
  const body = JSON.stringify({ op: 'state' });
  const headers = await signRequest({
    method: 'POST',
    url,
    region,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': sessionId,
    },
    body,
  });
  const response = await fetch(url, { method: 'POST', headers, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`the runtime answered ${response.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the runtime answered ${response.status} with something that is not JSON: ${text.slice(0, 200)}`);
  }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const faceFlag = argv.indexOf('--face');
  const face = faceFlag === -1 ? 1 : Number(argv[faceFlag + 1]);
  if (!Number.isInteger(face) || face < 1 || face > 10) {
    note('--face takes 1 through 10; AgentCore allows ten concurrent shells per session.');
    return 64;
  }

  // Remembered too, and for the same reason as the ARN: the profile exists to stop the
  // daily `aws login` expiry, so needing to retype it every time defeats the point of
  // having one. The assignment has to land before the SDK builds its provider chain,
  // which reads AWS_PROFILE once at construction.
  const named = process.env.CUBE_AWS_PROFILE || process.env.AWS_PROFILE;
  const profile = named || remembered('profile');
  if (profile) process.env.AWS_PROFILE = profile;

  const knownArn = remembered('runtime');
  const cloud = readCloudOptions(
    { ...process.env, CUBE_RUNTIME_ARN: process.env.CUBE_RUNTIME_ARN || knownArn || '' },
    argv,
    { force: true },
  );
  if (!cloud) {
    note(usage());
    return 64;
  }

  const sessionId = cloud.sessionId || (await operatorSessionId());
  const shellId = faceShellId(face - 1);
  const region = cloud.region;

  note(`runtime : ${cloud.runtimeArn.split('/').pop()} (${region})`);
  note(`session : ${sessionId}`);
  note(`shell   : ${shellId}${profile ? ` · profile ${profile}` : ''}`);
  note('waking  : …');

  const startedAt = Date.now();
  const state = await prepare({ region, runtimeArn: cloud.runtimeArn, qualifier: cloud.qualifier, sessionId });
  const durable = state.persistence?.durable && state.mount?.present;
  const where = state.persistence?.workdir ?? '/mnt/workspace/work';
  note(`ready   : ${Date.now() - startedAt} ms · ${state.faces?.length ?? '?'} faces · ${where}`);
  // Said plainly because it is the only thing here that can lose work. The mount is one
  // filesystem for the whole runtime — a different session id lands in the same files —
  // so the risk is never "wrong session", it is a mount that did not come up at all.
  if (!durable) note('          NOT DURABLE — the workspace mount is missing; files will vanish at idle');

  // Only after the runtime answered. Remembering an ARN that never worked would make the
  // next run fail with no flag left to blame.
  if (cloud.runtimeArn !== knownArn || (named && named !== remembered('profile'))) {
    remember('runtime', cloud.runtimeArn);
    if (profile) remember('profile', profile);
    note(`saved   : ${stateDir()} — plain \`cloud\` from now on`);
  }

  const stdin = process.stdin;
  const raw = Boolean(stdin.isTTY);
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });

  const session = await openShellSession({
    shellId,
    sessionId,
    resize: size(),
    // A platform shell is a bare PTY with an undocumented cwd, HOME and TERM. cube-face
    // is the image's own answer to that, and going through it is what puts this terminal
    // on the same herdr terminal the cube's face N shows — not a lookalike beside it.
    bootstrap: `exec /usr/local/bin/cube-face ${face}\n`,
    mint: async () => ({
      url: await presignShellUrl({
        region,
        runtimeArn: cloud.runtimeArn,
        shellId,
        sessionId,
        qualifier: cloud.qualifier,
        expiresIn: cloud.expiresIn,
      }),
      shellId,
      sessionId,
    }),
  });

  note(raw ? `attached: face ${face} — ctrl-] to detach\n` : `attached: face ${face}\n`);

  const onData = (payload) => process.stdout.write(payload);
  const bind = (connection) => {
    connection.on('stdout', onData);
    connection.on('stderr', onData);
  };
  bind(session.current());
  session.on('connect', bind);
  // A 1-hour TTL close and a 15-minute idle drop are ordinary for a shell left open all
  // day. The remote shell survives both; only the socket is replaced.
  session.on('disconnect', (result) => {
    if (result.classification.reconnect) note(`\r\n[reconnecting — ${result.classification.reason}]\r\n`);
  });

  if (raw) stdin.setRawMode(true);
  stdin.resume();
  process.stdout.on('resize', () => session.resize(size().cols, size().rows));

  const exit = await new Promise((resolve) => {
    // Raw mode hands ctrl-c and every other control character to the remote shell, which
    // is the point — so the one key that means "come back" has to be caught here, before
    // the write. ctrl-] is telnet's, and no interactive program on the far side wants it.
    const DETACH = 0x1d;
    stdin.on('data', (chunk) => {
      if (raw && chunk.includes(DETACH)) {
        session.write(chunk.subarray(0, chunk.indexOf(DETACH)));
        resolve(0);
        return;
      }
      session.write(chunk);
    });
    session.on('stop', (result) => resolve(result?.error ? 1 : 0));
    // The far shell exiting is the other ordinary way out. Anything else and the
    // disconnect handler above has already said so.
    session.current().on('exit', () => resolve(0));
    // Piped input, not a terminal: the writes are already queued, so give the shell a
    // moment to answer rather than closing the socket on top of its own output.
    stdin.on('end', () => setTimeout(() => resolve(0), 2000));
  });

  if (raw) stdin.setRawMode(false);
  session.close(1000, 'done');
  note('\r\ndetached — the shell keeps running in the cloud.');
  return exit;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    note(`\r\n${error.message}`);
    process.exit(1);
  },
);
