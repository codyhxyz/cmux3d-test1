import { execFile } from 'node:child_process';
import { pairingUrl } from '../../public/app/connection-config.js';
import { readServerOptions } from './config.js';
import { createRuntime } from './runtime.js';
import { detectExposure, tailnetAddress } from './tailscale.js';

const options = readServerOptions();
// Exposing means binding to the tailnet address itself: reachable from your other
// devices, invisible to the local network, and it needs no certificate.
const tailnet = options.expose && !process.env.HOST ? await tailnetAddress() : null;
if (options.expose && !tailnet) console.log('tailscale: not running, so the cube stays on this computer');

const runtime = createRuntime({ ...options, host: tailnet?.ip || options.host });

runtime.start().then(async ({ host, port }) => {
  console.log(`cmux3d is listening at http://${host}:${port}/`);
  if (options.rotated) console.log('pairing code rotated; paired phones must pair again');

  const phoneOrigin = tailnet ? `http://${tailnet.dnsName}:${port}` : null;
  if (phoneOrigin) {
    runtime.exposure.active = true;
    runtime.exposure.tsOrigin = phoneOrigin;
    console.log(`tailnet: ${phoneOrigin}`);
    console.log(`  open this on your phone:  ${phoneOrigin}/#token=${encodeURIComponent(options.token)}`);
  }

  await announceHostedRoute(port, phoneOrigin);

  if (process.env.CMUX3D_OPEN === '0') return;
  const webUrl = pairingUrl(options.webOrigin, `http://127.0.0.1:${port}`, options.token);
  if (process.platform === 'darwin') execFile('open', [webUrl]);
  else console.log(`open ${webUrl}`);
}).catch((error) => {
  console.error(`cmux3d failed to start: ${error.message}`);
  process.exitCode = 1;
});

// The hosted page is https, so it can only reach a host over TLS — that is the one
// route that needs `tailscale serve` and a tailnet certificate.
async function announceHostedRoute(port, phoneOrigin) {
  const exposure = await detectExposure({ optIn: false, port });
  if (!exposure.dnsName) return;

  if (exposure.active) {
    runtime.exposure.active = true;
    runtime.exposure.tsOrigin = exposure.tsOrigin;
    console.log(`tailnet TLS: ${exposure.tsOrigin} (tailscale serve)`);
    if (exposure.funnel) console.log('  warning: funnel is on for this port — it is reachable from the public internet');
    console.log(`  use ${options.webOrigin} from your phone:  ${pairingUrl(options.webOrigin, exposure.tsOrigin, options.token)}`);
    return;
  }

  if (!phoneOrigin) {
    console.log(`tailscale: ${exposure.dnsName}`);
    console.log('  put shells on your phone:  npm start -- --expose');
    return;
  }
  if (exposure.status?.certDomains.length) {
    console.log(`  to use ${options.webOrigin} on the phone instead:  ${exposure.serveCommand}`);
  }
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
