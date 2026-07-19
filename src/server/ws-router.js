import { WebSocketServer } from 'ws';
import { browserOriginAllowed, hostedRequestAuthorized } from './origin.js';

export function mountTerminalSocket(httpServer, terminalGrid, webOrigin, token) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!browserOriginAllowed(req.headers.origin, webOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!hostedRequestAuthorized(req, requestUrl, webOrigin, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== '/ws/pty') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, requestUrl);
    });
  });

  wss.on('connection', (ws, _req, requestUrl) => {
    const face = requestUrl.searchParams.get('face');
    const slot = requestUrl.searchParams.get('slot');
    terminalGrid.attach(face, slot, ws).catch((error) => {
      console.error('terminal attach failed:', error);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
      ws.close(1011, 'terminal attach failed');
    });
  });

  return wss;
}
