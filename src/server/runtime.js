import http from 'node:http';
import { paths } from './config.js';
import { readHerdrState, watchHerdrState } from './herdr-state.js';
import { createStaticResponder } from './static.js';
import { TerminalGrid } from './terminal-grid.js';
import { mountTerminalSocket } from './ws-router.js';

export function createRuntime(options = {}) {
  const terminalGrid = new TerminalGrid({ cwd: options.cwd, shell: options.shell, herdr: options.herdr });
  const server = http.createServer(createStaticResponder(
    options.publicRoot || paths.public,
    options.herdr ? () => readHerdrState(options.herdr) : null,
    options.herdr ? (onChange, onDisconnect) => watchHerdrState(options.herdr, onChange, onDisconnect) : null,
  ));
  const socketServer = mountTerminalSocket(server, terminalGrid);

  return {
    server,
    socketServer,
    terminalGrid,
    start() {
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
        server.listen(options.port ?? 8064, options.host || '127.0.0.1');
      });
    },
    address() {
      const info = server.address();
      if (!info || typeof info === 'string') return null;
      return { host: info.address, port: info.port };
    },
    stop() {
      terminalGrid.closeAll();
      socketServer.close();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
