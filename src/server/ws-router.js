import { WebSocketServer } from 'ws';

export function mountTerminalSocket(httpServer, terminalGrid) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
    try {
      terminalGrid.attach(face, slot, ws);
    } catch (error) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', message: error.message }));
      }
      ws.close(1011, 'terminal attach failed');
    }
  });

  return wss;
}
