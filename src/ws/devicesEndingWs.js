import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { listDevicesEndingSoon } from '../services/devicesEndingSoon.js';

/**
 * Admin WSS: /api/admin/ws/devices-ending?token=<admin jwt>
 * 1초마다 종료 예정 기기 목록 푸시 (잔여시간 실시간 갱신)
 */
export function attachDevicesEndingWs(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    try {
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname !== '/api/admin/ws/devices-ending') {
      socket.destroy();
      return;
    }
      const token = url.searchParams.get('token') || '';
      let payload;
      try {
        payload = jwt.verify(token, config.jwtSecret);
      } catch {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (payload?.role !== 'admin') {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (e) {
      console.error('[ws/devices-ending] upgrade', e?.message || e);
      try {
        socket.destroy();
      } catch (_) {}
    }
  });

  async function pushAll() {
    if (wss.clients.size === 0) return;
    let payload;
    try {
      const data = await listDevicesEndingSoon();
      payload = JSON.stringify({ type: 'devices_ending_soon', ...data });
    } catch (e) {
      console.error('[ws/devices-ending] list', e?.message || e);
      payload = JSON.stringify({ type: 'error', error: 'internal_error' });
    }
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch (_) {}
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', serverTime: new Date().toISOString() }));
        }
      } catch (_) {}
    });
    // 즉시 1회
    listDevicesEndingSoon()
      .then((data) => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'devices_ending_soon', ...data }));
      })
      .catch(() => {});
  });

  const tick = setInterval(() => {
    void pushAll();
  }, 1000);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        try {
          ws.terminate();
        } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_) {}
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(tick);
    clearInterval(heartbeat);
  });

  console.log('[ws] devices-ending attached at /api/admin/ws/devices-ending');
  return wss;
}
