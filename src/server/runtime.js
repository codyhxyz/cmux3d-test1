import http from 'node:http';
import { DEFAULT_COMPANION_HOST, DEFAULT_COMPANION_PORT } from '../../public/app/connection-config.js';
import { paths } from './config.js';
import { readHerdrState, watchHerdrState } from './herdr-state.js';
import { createStaticResponder } from './static.js';
import { TerminalGrid } from './terminal-grid.js';
import { mountTerminalSocket } from './ws-router.js';

export function createRuntime(options = {}) {
  const terminalGrid = new TerminalGrid({
    cwd: options.cwd,
    shell: options.shell,
    herdr: options.herdr,
    workspace: options.workspace,
  });
  const readState = options.herdr ? async () => {
    const state = await readHerdrState(options.herdr, options.workspace);
    terminalGrid.setTargets(state.map(({ terminalId }) => terminalId));
    return state;
  } : null;
  const server = http.createServer(createStaticResponder(
    options.publicRoot || paths.public,
    readState,
    options.herdr ? (onChange, onDisconnect) => watchHerdrState(
      options.herdr,
      onChange,
      onDisconnect,
      options.workspace,
    ) : null,
    options.webOrigin,
    options.token,
  ));
  const socketServer = mountTerminalSocket(server, terminalGrid, options.webOrigin, options.token);
  const startupIdleMs = options.startupIdleMs ?? 60_000;
  const disconnectedIdleMs = options.disconnectedIdleMs ?? 10_000;
  let idleTimer;
  let stopPromise;

  const clearIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdleTimer = (delay) => {
    clearIdleTimer();
    idleTimer = setTimeout(async () => {
      if (socketServer.clients.size) return;
      await runtime.stop();
      options.onIdle?.();
    }, delay);
    idleTimer.unref();
  };

  socketServer.on('connection', (client) => {
    clearIdleTimer();
    client.once('close', () => queueMicrotask(() => {
      if (!socketServer.clients.size) armIdleTimer(disconnectedIdleMs);
    }));
  });

  const runtime = {
    server,
    socketServer,
    terminalGrid,
    async start() {
      await terminalGrid.prepare();
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          armIdleTimer(startupIdleMs);
          resolve(this.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port ?? DEFAULT_COMPANION_PORT, options.host || DEFAULT_COMPANION_HOST);
      });
    },
    address() {
      const info = server.address();
      if (!info || typeof info === 'string') return null;
      return { host: info.address, port: info.port };
    },
    stop() {
      if (stopPromise) return stopPromise;
      clearIdleTimer();
      terminalGrid.closeAll();
      for (const client of socketServer.clients) client.terminate();
      socketServer.close();
      stopPromise = new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
      return stopPromise;
    },
  };

  return runtime;
}
