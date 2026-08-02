import http from 'node:http';
import { DEFAULT_HOST_ADDRESS, DEFAULT_HOST_PORT } from '../../public/app/connection-config.js';
import { paths } from './config.js';
import { readHerdrState, watchHerdrState } from './herdr-state.js';
import { createStaticResponder } from './static.js';
import { TerminalGrid } from './terminal-grid.js';
import { mountTerminalSocket } from './ws-router.js';

export function createRuntime(options = {}) {
  // Filled in after listen(), once tailscale detection has run; read per request.
  const exposure = options.exposure || { active: false, tsOrigin: null };
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
    exposure,
  ));
  const socketServer = mountTerminalSocket(server, terminalGrid, options.webOrigin, options.token, exposure);
  let stopPromise;

  const runtime = {
    server,
    socketServer,
    terminalGrid,
    exposure,
    async start() {
      await terminalGrid.prepare();
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(this.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(options.port ?? DEFAULT_HOST_PORT, options.host || DEFAULT_HOST_ADDRESS);
      });
    },
    address() {
      const info = server.address();
      if (!info || typeof info === 'string') return null;
      return { host: info.address, port: info.port };
    },
    stop() {
      if (stopPromise) return stopPromise;
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
