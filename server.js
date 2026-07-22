// TANK DUEL CLASSIC — relay server
// The room creator's browser runs the match (host-authoritative, no prediction).
// The server serves the page and relays messages between the two players.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> { clients: [hostWs, guestWs] }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(c) ? genCode() : c;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  // send packets immediately, never batch (batching adds latency)
  if (ws._socket && ws._socket.setNoDelay) ws._socket.setNoDelay(true);
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }

    if (m.t === 'create') {
      const code = genCode();
      rooms.set(code, { clients: [ws, null] });
      ws.room = code; ws.idx = 0;
      ws.send(JSON.stringify({ t: 'room', code }));

    } else if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || !room.clients[0] || room.clients[0].readyState !== 1) {
        ws.send(JSON.stringify({ t: 'err', msg: 'ROOM NOT FOUND — CHECK THE CODE' }));
        return;
      }
      if (room.clients[1]) {
        ws.send(JSON.stringify({ t: 'err', msg: 'ROOM IS FULL' }));
        return;
      }
      room.clients[1] = ws;
      ws.room = code; ws.idx = 1;
      room.clients[0].send(JSON.stringify({ t: 'ready', idx: 0 }));
      ws.send(JSON.stringify({ t: 'ready', idx: 1 }));

    } else {
      // paired game traffic (snapshots / inputs): relay to the other player
      const room = rooms.get(ws.room);
      if (!room) return;
      const other = room.clients[ws.idx === 0 ? 1 : 0];
      if (other && other.readyState === 1) other.send(data.toString());
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (room) {
      const other = room.clients[ws.idx === 0 ? 1 : 0];
      if (other && other.readyState === 1) other.send(JSON.stringify({ t: 'peer_left' }));
      rooms.delete(ws.room);
    }
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Tank Duel Classic relay on port ' + PORT));
