import { readServerOptions } from './config.js';
import { createRuntime } from './runtime.js';

const options = readServerOptions();
const runtime = createRuntime(options);

runtime.start().then(({ host, port }) => {
  console.log(`cmux3d is listening at http://${host}:${port}/`);
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
