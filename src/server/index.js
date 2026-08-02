import { execFile } from 'node:child_process';
import { pairingUrl } from '../../public/app/connection-config.js';
import { readServerOptions } from './config.js';
import { createRuntime } from './runtime.js';
import { offerServe, tailnetAddress } from './tailscale.js';

const options = readServerOptions();
const tailnet = options.expose && !process.env.HOST ? await tailnetAddress() : null;
if (options.expose && !tailnet) console.log('tailscale: not running, so the cube stays on this computer');

const runtime = createRuntime({
  ...options,
  hosts: tailnet ? [options.host, tailnet.ip] : [options.host],
});

runtime.start().then(({ host, port }) => {
  console.log(`cmux3d is listening at http://${host}:${port}/`);
  if (options.rotated) console.log('pairing code rotated; paired phones must pair again');

  if (tailnet) {
    const phoneOrigin = `http://${tailnet.dnsName}:${port}`;
    runtime.exposure.active = true;
    runtime.exposure.tsOrigin = phoneOrigin;
    console.log(`tailnet: ${phoneOrigin}`);
    console.log(`  open this on your phone:  ${phoneOrigin}/#token=${encodeURIComponent(options.token)}`);
    // Slow, and only decides whether the hosted page can also reach us, so it
    // resolves after the cube is already usable.
    upgradeToTls(port);
  }

  if (process.env.CMUX3D_OPEN === '0') return;
  const webUrl = pairingUrl(options.webOrigin, `http://127.0.0.1:${port}`, options.token);
  if (process.platform === 'darwin') execFile('open', [webUrl]);
  else console.log(`open ${webUrl}`);
}).catch((error) => {
  console.error(`cmux3d failed to start: ${error.message}`);
  process.exitCode = 1;
});

// The hosted page is https, so it can only reach this machine over TLS. That is
// what Tailscale Serve provides, and the only thing it needs is to be switched on.
async function upgradeToTls(port) {
  const serve = await offerServe(port).catch(() => null);
  if (!serve) return;

  if (serve.tsOrigin) {
    runtime.exposure.tsOrigin = serve.tsOrigin;
    console.log(`tailnet TLS: ${serve.tsOrigin}`);
    if (serve.funnel) console.log('  warning: funnel is on for this port — it is reachable from the public internet');
    console.log(`  ${options.webOrigin} now works on your phone too:`);
    console.log(`  ${pairingUrl(options.webOrigin, serve.tsOrigin, options.token)}`);
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
