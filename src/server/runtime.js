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
  const respond = createStaticResponder(
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
    options.tailnet,
  );
  // Loopback keeps working for this machine while a second address serves the
  // tailnet, so exposing the cube never takes the desktop flow away.
  const hosts = options.hosts?.length ? options.hosts : [options.host || DEFAULT_HOST_ADDRESS];
  const servers = hosts.map(() => http.createServer(respond));
  const server = servers[0];
  const socketServers = servers.map((each) => mountTerminalSocket(each, terminalGrid, options.webOrigin, options.token, exposure, options.tailnet));
  const socketServer = socketServers[0];
  let stopPromise;

  const runtime = {
    server,
    socketServer,
    terminalGrid,
    exposure,
    async start() {
      await terminalGrid.prepare();
      // Sequential, because port 0 lets the OS choose and the extra listeners have
      // to reuse whatever the first one was given.
      for (const [index, each] of servers.entries()) {
        await new Promise((resolve, reject) => {
          const onError = (error) => {
            each.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            each.off('error', onError);
            resolve();
          };
          each.once('error', onError);
          each.once('listening', onListening);
          each.listen(this.address()?.port ?? options.port ?? DEFAULT_HOST_PORT, hosts[index]);
        });
      }
      return this.address();
    },
    address() {
      const info = server.address();
      if (!info || typeof info === 'string') return null;
      return { host: info.address, port: info.port };
    },
    stop() {
      if (stopPromise) return stopPromise;
      terminalGrid.closeAll();
      for (const sockets of socketServers) {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
      }
      stopPromise = Promise.all(servers.map((each) => new Promise((resolve) => {
        each.close(resolve);
        each.closeAllConnections();
      })));
      return stopPromise;
    },
  };

  return runtime;
}
