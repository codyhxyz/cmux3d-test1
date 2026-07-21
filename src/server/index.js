import { execFile } from 'node:child_process';
import { readServerOptions } from './config.js';
import { createRuntime } from './runtime.js';

const options = readServerOptions();
const runtime = createRuntime(options);

runtime.start().then(({ host, port }) => {
  const localUrl = `http://${host}:${port}/`;
  const webUrl = `${options.webOrigin}/#token=${encodeURIComponent(options.token)}`;
  console.log(`cmux3d is listening at ${localUrl}`);
  if (process.env.CMUX3D_OPEN === '0') return;
  if (process.platform === 'darwin') execFile('open', [webUrl]);
  else console.log(`open ${webUrl}`);
}).catch((error) => {
  console.error(`cmux3d failed to start: ${error.message}`);
  process.exitCode = 1;
});

async function shutdown() {
  try {
    await runtime.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
