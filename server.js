// TANK DUEL — game server
// Serves the game page and relays messages between two players in a room.
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
const rooms = new Map(); // code -> { host, guest }

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(c) ? genCode() : c;
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }

    if (m.t === 'create') {
      const code = genCode();
      rooms.set(code, { host: ws, guest: null });
      ws.room = code;
      ws.send(JSON.stringify({ t: 'room', code }));

    } else if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.host.readyState !== 1) {
        ws.send(JSON.stringify({ t: 'err', msg: 'ROOM NOT FOUND — CHECK THE CODE' }));
        return;
      }
      if (room.guest) {
        ws.send(JSON.stringify({ t: 'err', msg: 'ROOM IS FULL' }));
        return;
      }
      room.guest = ws;
      ws.room = code;
      ws.partner = room.host;
      room.host.partner = ws;
      const ready = JSON.stringify({ t: 'ready' });
      room.host.send(ready);
      ws.send(ready);

    } else if (ws.partner && ws.partner.readyState === 1) {
      // paired: relay game traffic (snapshots / inputs) to the other player
      ws.partner.send(data.toString());
    }
  });

  ws.on('close', () => {
    if (ws.partner && ws.partner.readyState === 1) {
      ws.partner.send(JSON.stringify({ t: 'peer_left' }));
      ws.partner.partner = null;
    }
    if (ws.room) {
      const r = rooms.get(ws.room);
      if (r && (r.host === ws || r.guest === ws)) rooms.delete(ws.room);
    }
  });
});

// heartbeat: drop dead connections, clean their rooms
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Tank Duel server running on port ' + PORT));
