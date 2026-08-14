import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pairingUrl } from '../../public/app/connection-config.js';
import { attachCloud } from './cloud/gateway.js';
import { readServerOptions } from './config.js';
import { createRuntime } from './runtime.js';
import { createTailnetIdentity, offerServe, tailnetAddress } from './tailscale.js';
import { stateDir } from './token-store.js';

const options = readServerOptions();
if (options.cloudRequested && !options.cloud) {
  console.error('--cloud needs a runtime: set CUBE_RUNTIME_ARN, or pass --runtime-arn <arn>.');
  process.exit(2);
}
const useTailnet = options.expose || options.serveOnly;
const tailnet = useTailnet && process.env.CODING_CUBE_LOCAL_ONLY !== '1' ? await tailnetAddress() : null;
const peers = tailnet && options.trustTailnet
  ? createTailnetIdentity({ allowedLogins: options.tailscaleUsers })
  : null;

const runtime = createRuntime({
  ...options,
  hosts: options.expose && tailnet ? [options.host, tailnet.ip] : [options.host],
  tailnet: peers,
});

// Before listen(), because mounting takes over the server's 'request' listener.
const minter = options.cloud
  ? attachCloud(runtime.server, {
    cloud: options.cloud,
    webOrigin: options.webOrigin,
    token: options.token,
    exposure: runtime.exposure,
    tailnet: peers,
    log: (line) => console.log(line),
  })
  : null;

runtime.start().then(({ host, port }) => {
  console.log(`coding-cube is listening at http://${host}:${port}/`);
  if (options.rotated) console.log('pairing code rotated; paired phones must pair again');

  if (minter) {
    console.log('');
    console.log(`  cloud   : ${minter.runtimeArn}`);
    console.log(`  aws     : ${minter.profile ? `profile ${minter.profile}` : 'default credential chain (expires with `aws login`)'}`);
    console.log(`  session : ${minter.sessionId}${minter.pinSession ? ' (pinned)' : ' (the browser names its own)'}`);
    console.log('  Pick Cloud (AgentCore) in Computers; six faces attach to one runtime session.');
    console.log('');
  }

  if (options.expose && tailnet) {
    const phoneOrigin = `http://${tailnet.dnsName}:${port}`;
    runtime.exposure.active = true;
    runtime.exposure.tsOrigin = phoneOrigin;
    console.log('');
    console.log('  On your phone, open:');
    console.log(`  \x1b[1m${phoneOrigin}\x1b[0m${peers ? '' : `/#token=${encodeURIComponent(options.token)}`}`);
    if (peers) console.log('  (no code needed — Tailscale already knows your devices)');
    console.log('');
  }

  // Not conditional on Tailscale or the cloud: pair finds whatever this machine can actually
  // offer a phone, and says so when that is nothing.
  console.log(`  On a phone: run \x1b[1m${pairCommand()}\x1b[0m and scan the QR.`);

  // TLS is deliberately separate from direct tailnet binding: a cloud gateway
  // stays on loopback and lets Tailscale Serve authenticate every request.
  if (tailnet) upgradeToTls(port);

  if (process.env.CODING_CUBE_OPEN === '0') return;
  const webUrl = pairingUrl(options.webOrigin, `http://127.0.0.1:${port}`, options.token);
  if (process.platform === 'darwin') execFile('open', [webUrl]);
  else console.log(`open ${webUrl}`);
}).catch((error) => {
  console.error(`coding-cube failed to start: ${error.message}`);
  process.exitCode = 1;
});

// The spelling that will actually work from here. install.sh writes a launcher but never
// puts it on PATH, and `npm run pair` only exists inside a checkout — printing a word the
// reader's shell cannot find is worse than printing a long path.
function pairCommand() {
  const launcher = path.join(stateDir(), 'bin', 'coding-cube');
  const onPath = String(process.env.PATH || '')
    .split(path.delimiter)
    .some((entry) => entry && fs.existsSync(path.join(entry, 'coding-cube')));
  if (onPath) return 'coding-cube pair';
  return fs.existsSync(launcher) ? `${launcher} pair` : 'npm run pair';
}

// The hosted page is https, so it can only reach this machine over TLS. That is
// what Tailscale Serve provides, and the only thing it needs is to be switched on.
async function upgradeToTls(port) {
  const serve = await offerServe(port).catch(() => null);
  if (!serve) return;

  if (serve.tsOrigin) {
    runtime.exposure.active = true;
    runtime.exposure.tsOrigin = serve.tsOrigin;
    console.log(`tailnet TLS: ${serve.tsOrigin}`);
    if (serve.funnel) console.log('  warning: funnel is on for this port — it is reachable from the public internet');
    console.log(`  ${options.webOrigin} now works on your phone too:`);
    console.log(`  ${pairingUrl(options.webOrigin, serve.tsOrigin, peers ? '' : options.token)}`);
    return;
  }
  if (!serve.enableUrl) return;

  console.log('');
  console.log(`  Want ${options.webOrigin} itself to work on your phone? Turn on Tailscale Serve once:`);
  console.log(`  ${serve.enableUrl}`);
  console.log('  Then restart with --expose. The address above works either way.');
}

async function shutdown() {
  try {
    await runtime.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
