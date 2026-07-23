// TANK DUEL — authoritative game server
// The server runs the full game simulation. Both players are equal clients:
// they send inputs, receive snapshots, and predict their own tank locally.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store' // browsers always fetch the fresh game — no hard-refresh needed
  });
  res.end(html);
});

// ---------- GAME CONSTANTS (mirror the client exactly) ----------
const TILE = 32, COLS = 28, ROWS = 18;
const W = COLS * TILE, H = ROWS * TILE;
const T_RADIUS = 13, T_SPEED = 3.2, T_TURN = 0.065, T_TURRET = 0.088; // ~1.4x tuned (must match client)
const COLORS = ['#ffa62e', '#3ed6c0'];

function spawnPoint(i) {
  return i === 0
    ? { x: 2*TILE + TILE/2, y: 2*TILE + TILE/2, a: 0 }
    : { x: (COLS-3)*TILE + TILE/2, y: (ROWS-3)*TILE + TILE/2, a: Math.PI };
}

function genMap(gm) {
  const g = Array.from({length: ROWS}, () => Array(COLS).fill(0));
  for (let c = 0; c < COLS; c++) { g[0][c] = 2; g[ROWS-1][c] = 2; }
  for (let r = 0; r < ROWS; r++) { g[r][0] = 2; g[r][COLS-1] = 2; }
  const set = (c, r, v) => {
    if (c < 1 || r < 1 || c >= COLS-1 || r >= ROWS-1) return;
    g[r][c] = v;
    g[ROWS-1-r][COLS-1-c] = v;
  };
  const clusters = 16 + Math.floor(Math.random() * 8);
  for (let i = 0; i < clusters; i++) {
    const mat = Math.random() < 0.32 ? 2 : 1;
    const c0 = 1 + Math.floor(Math.random() * (COLS - 2));
    const r0 = 1 + Math.floor(Math.random() * (ROWS - 2));
    const s = Math.random();
    if (s < 0.4) { const len = 2 + Math.floor(Math.random() * 4); for (let k = 0; k < len; k++) set(c0 + k, r0, mat); }
    else if (s < 0.8) { const len = 2 + Math.floor(Math.random() * 3); for (let k = 0; k < len; k++) set(c0, r0 + k, mat); }
    else { set(c0, r0, mat); set(c0+1, r0, mat); set(c0, r0+1, mat); set(c0+1, r0+1, mat); }
  }
  const clearZone = (cc, rr) => {
    for (let r = rr-1; r <= rr+1; r++)
      for (let c = cc-1; c <= cc+1; c++)
        if (c > 0 && r > 0 && c < COLS-1 && r < ROWS-1) g[r][c] = 0;
  };
  clearZone(2, 2); clearZone(COLS-3, ROWS-3);
  if (gm === 'dom') {
    for (let r = 1; r < ROWS-1; r++) for (let c = 1; c < COLS-1; c++) {
      const dx = (c + 0.5) - COLS/2, dy = (r + 0.5) - ROWS/2;
      if (dx*dx + dy*dy < 2.4*2.4) g[r][c] = 0;
    }
  }
  const seen = Array.from({length: ROWS}, () => Array(COLS).fill(false));
  const q = [[2, 2]]; seen[2][2] = true;
  while (q.length) {
    const [c, r] = q.pop();
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      if (nc>=0 && nr>=0 && nc<COLS && nr<ROWS && !seen[nr][nc] && g[nr][nc] !== 2) {
        seen[nr][nc] = true; q.push([nc, nr]);
      }
    });
  }
  if (!seen[ROWS-3][COLS-3]) return genMap(gm);
  if (gm === 'dom' && !seen[Math.floor(ROWS/2)][Math.floor(COLS/2)]) return genMap(gm);
  return g;
}

// ---------- GAME SIMULATION ----------
class Game {
  constructor(gm) {
    this.gm = gm === 'dom' ? 'dom' : 'dm';
    this.scores = [0, 0];
    this.round = 1;
    this.lastWinner = 0;
    this.dom = { pts: [0,0], cap: [0,0], resp: [0,0], owner: -1, zone: { x: W/2, y: H/2, r: TILE*2 } };
    this.inputs = [{}, {}];
    this.events = [];
    this.bulletSeq = 0;
    this.shells = [[], []]; // each player's self-simulated shells (positions only)
    this.newRound(false);
  }

  newRound(keepDomPoints) {
    this.grid = genMap(this.gm);
    this.bullets = [];
    this.shells = [[], []];
    this.tanks = [0, 1].map(i => {
      const s = spawnPoint(i);
      return { id: i, x: s.x, y: s.y, angle: s.a, turret: s.a,
               hp: 3, alive: true, cooldown: 0,
               type: (this.tanks && this.tanks[i].type) || 'classic' };
    });
    this.dom.cap = [0,0]; this.dom.resp = [0,0]; this.dom.owner = -1;
    if (!keepDomPoints) this.dom.pts = [0,0];
    this.state = 'countdown';
    this.countdownT = 3600;
    this.prevAdv = [true, true]; // require a fresh press to advance
  }

  ev(e) { this.events.push(e); }

  solidAt(px, py) {
    const c = Math.floor(px / TILE), r = Math.floor(py / TILE);
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return 2;
    return this.grid[r][c];
  }

  circleHitsWall(x, y, rad) {
    const minC = Math.floor((x - rad) / TILE), maxC = Math.floor((x + rad) / TILE);
    const minR = Math.floor((y - rad) / TILE), maxR = Math.floor((y + rad) / TILE);
    for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) {
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return true;
      if (this.grid[r][c] !== 0) {
        const cx = Math.max(c*TILE, Math.min(x, c*TILE+TILE));
        const cy = Math.max(r*TILE, Math.min(y, r*TILE+TILE));
        if ((x-cx)**2 + (y-cy)**2 < rad*rad) return true;
      }
    }
    return false;
  }

  updateTank(t, dt) {
    if (!t.alive) return;
    const c = this.inputs[t.id] || {};
    if (c.ty && t.type !== c.ty) t.type = c.ty;
    if (c.left) { t.angle -= T_TURN; if (t.type === 'gunner') t.turret -= T_TURN; }
    if (c.right) { t.angle += T_TURN; if (t.type === 'gunner') t.turret += T_TURN; }
    if (t.type === 'gunner') {
      if (c.tl) t.turret -= T_TURRET;
      if (c.tr) t.turret += T_TURRET;
    } else {
      t.turret = t.angle;
    }
    let v = 0;
    if (c.fwd) v = T_SPEED;
    if (c.back) v = -T_SPEED * 0.62;
    const nx = t.x + Math.cos(t.angle) * v;
    const ny = t.y + Math.sin(t.angle) * v;
    if (!this.circleHitsWall(nx, t.y, T_RADIUS)) t.x = nx;
    if (!this.circleHitsWall(t.x, ny, T_RADIUS)) t.y = ny;

    const other = this.tanks[1 - t.id];
    if (other.alive) {
      const dx = t.x - other.x, dy = t.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < T_RADIUS * 2) {
        const push = (T_RADIUS*2 - d) / 2;
        const px = dx/d * push, py = dy/d * push;
        if (!this.circleHitsWall(t.x + px, t.y + py, T_RADIUS)) { t.x += px; t.y += py; }
      }
    }

  }

  fire(t) {
    if (this.bullets.filter(b => b.owner === t.id).length >= 4) return;
    t.cooldown = 380;
    const mx = t.x + Math.cos(t.turret) * 20;
    const my = t.y + Math.sin(t.turret) * 20;
    this.bullets.push({
      id: ++this.bulletSeq,
      x: mx, y: my,
      vx: Math.cos(t.turret) * 7.8, vy: Math.sin(t.turret) * 7.8,
      owner: t.id, bounces: 2, grace: 160, life: 4200
    });
    this.ev({ e: 'mz', x: mx | 0, y: my | 0, a: +t.turret.toFixed(2), o: t.id });
  }

  updateBullets(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt; b.grace -= dt;
      if (b.life <= 0) { this.bullets.splice(i, 1); continue; }
      let removed = false;
      for (let s = 0; s < 2 && !removed; s++) {
        const nx = b.x + b.vx / 2, ny = b.y + b.vy / 2;
        const hit = this.solidAt(nx, ny);
        if (hit !== 0) {
          const c = Math.floor(nx / TILE), r = Math.floor(ny / TILE);
          if (hit === 1) {
            this.grid[r][c] = 0;
            this.ev({ e: 'br', x: c*TILE + TILE/2, y: r*TILE + TILE/2 });
            this.bullets.splice(i, 1); removed = true; break;
          }
          if (b.bounces <= 0) {
            this.ev({ e: 'sp', x: b.x | 0, y: b.y | 0, c: '#cfd6dd', n: 7 });
            this.bullets.splice(i, 1); removed = true; break;
          }
          b.bounces--;
          const hx = this.solidAt(b.x + b.vx / 2, b.y) !== 0;
          const hy = this.solidAt(b.x, b.y + b.vy / 2) !== 0;
          if (hx) b.vx = -b.vx;
          if (hy) b.vy = -b.vy;
          if (!hx && !hy) { b.vx = -b.vx; b.vy = -b.vy; }
          this.ev({ e: 'sp', x: b.x | 0, y: b.y | 0, c: '#e8ecf0', n: 7 });
        } else { b.x = nx; b.y = ny; }
      }
      if (removed) continue;
      for (const t of this.tanks) {
        if (!t.alive) continue;
        if (t.id === b.owner && b.grace > 0) continue;
        if ((t.x-b.x)**2 + (t.y-b.y)**2 < (T_RADIUS+3)**2) {
          this.bullets.splice(i, 1);
          this.damage(t);
          break;
        }
      }
    }
  }

  damage(t) {
    t.hp--;
    this.ev({ e: 'sp', x: t.x | 0, y: t.y | 0, c: COLORS[t.id], n: 14 });
    this.ev({ e: 'sh', v: 6 });
    if (t.hp <= 0) {
      t.alive = false;
      this.ev({ e: 'bm', x: t.x | 0, y: t.y | 0, c: COLORS[t.id] });
      if (this.gm === 'dom') {
        this.dom.resp[t.id] = 2500;
        return;
      }
      this.lastWinner = 1 - t.id;
      this.scores[this.lastWinner]++;
      this.enterRoundOver();
    }
  }

  enterRoundOver() {
    this.state = 'roundOver';
    this.prevAdv = [!!(this.inputs[0].adv), !!(this.inputs[1].adv)];
  }

  respawn(i) {
    const t = this.tanks[i], s = spawnPoint(i);
    t.x = s.x; t.y = s.y; t.angle = s.a; t.turret = s.a;
    t.hp = 3; t.alive = true; t.cooldown = 500;
    this.ev({ e: 'sp', x: s.x | 0, y: s.y | 0, c: COLORS[i], n: 12 });
  }

  updateDom(dt) {
    const z = this.dom.zone;
    const inside = this.tanks.map(t => t.alive && Math.hypot(t.x - z.x, t.y - z.y) < z.r);
    if (this.dom.owner !== -1) {
      this.dom.pts[this.dom.owner] = Math.min(100, this.dom.pts[this.dom.owner] + dt / 1000);
      if (this.dom.pts[this.dom.owner] >= 100) {
        this.lastWinner = this.dom.owner;
        this.enterRoundOver();
        return;
      }
    }
    for (const i of [0, 1]) {
      const o = 1 - i;
      if (i === this.dom.owner) { this.dom.cap[i] = 0; continue; }
      if (inside[i] && !inside[o]) this.dom.cap[i] = Math.min(100, this.dom.cap[i] + 25 * dt / 1000);
      else if (!inside[i]) this.dom.cap[i] = Math.max(0, this.dom.cap[i] - 12.5 * dt / 1000);
      if (this.dom.cap[i] >= 100) {
        this.dom.cap[0] = 0; this.dom.cap[1] = 0;
        this.dom.owner = i;
        this.ev({ e: 'cp', w: i });
      }
    }
  }

  tick(dt) {
    if (this.state === 'countdown') {
      this.countdownT -= dt;
      if (this.countdownT <= 0) this.state = 'play';
    } else if (this.state === 'play') {
      for (const t of this.tanks) this.updateTank(t, dt);
      if (this.gm === 'dom') {
        this.updateDom(dt);
        for (const i of [0, 1]) {
          if (!this.tanks[i].alive) {
            this.dom.resp[i] -= dt;
            if (this.dom.resp[i] <= 0) this.respawn(i);
          }
        }
      }
    } else if (this.state === 'roundOver') {
      for (const i of [0, 1]) {
        const adv = !!(this.inputs[i] && this.inputs[i].adv);
        if (adv && !this.prevAdv[i]) {
          this.round++;
          this.newRound(false);
          return;
        }
        this.prevAdv[i] = adv;
      }
    }
  }

  makeSnap(q) {
    return {
      t: 'snap', q, ts: Date.now(),
      st: this.state, cd: Math.max(0, this.countdownT | 0),
      rd: this.round, sc: this.scores, wn: this.lastWinner,
      gm: this.gm,
      dm: this.gm === 'dom'
        ? { p: [this.dom.pts[0], this.dom.pts[1]],
            c: [+this.dom.cap[0].toFixed(1), +this.dom.cap[1].toFixed(1)],
            o: this.dom.owner, rs: [this.dom.resp[0] | 0, this.dom.resp[1] | 0] }
        : null,
      g: this.grid.flat().join(''),
      tk: this.tanks.map(t => ({
        x: +t.x.toFixed(1), y: +t.y.toFixed(1),
        a: +t.angle.toFixed(3), tu: +t.turret.toFixed(3),
        ty: t.type, hp: t.hp, al: t.alive ? 1 : 0
      })),
      bl: [
        ...this.shells[0].map(b => ({ i: '0-' + b.i, x: b.x, y: b.y, o: 0 })),
        ...this.shells[1].map(b => ({ i: '1-' + b.i, x: b.x, y: b.y, o: 1 }))
      ],
      ev: this.events.splice(0)
    };
  }
}

// ---------- ROOMS ----------
const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> room

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(c) ? genCode() : c;
}

function startRoom(room) {
  room.game = new Game(room.gm);
  let last = Date.now();
  let sendToggle = 0;
  room.timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(50, now - last);
    last = now;
    room.game.tick(dt);              // 60Hz simulation
    if (++sendToggle % 2 === 0) {    // 30Hz snapshots
      const base = room.game.makeSnap(++room.q);
      for (const i of [0, 1]) {
        const ws = room.clients[i];
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ ...base, ep: room.pings[i] || 0 })); } catch {}
        }
      }
    }
  }, 1000 / 60);
}

function closeRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  clearInterval(room.timer);
  rooms.delete(code);
}

wss.on('connection', ws => {
  ws.isAlive = true;
  if (ws._socket && ws._socket.setNoDelay) ws._socket.setNoDelay(true);
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }

    if (m.t === 'create') {
      const code = genCode();
      rooms.set(code, { code, gm: m.gm === 'dom' ? 'dom' : 'dm',
                        clients: [ws, null], pings: [0, 0], q: 0, game: null, timer: null });
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
      startRoom(room);

    } else if (m.t === 'input') {
      const room = rooms.get(ws.room);
      if (!room || !room.game) return;
      room.game.inputs[ws.idx] = m.k || {};
      if (Array.isArray(m.sh)) room.game.shells[ws.idx] = m.sh.slice(0, 8);
      if (m.pt) room.pings[ws.idx] = m.pt;

    } else if (m.t === 'hit') {
      // shooter authority: the attacker's screen decided this hit landed
      const room = rooms.get(ws.room);
      if (!room || !room.game) return;
      const g = room.game;
      if (g.state !== 'play') return;
      const tgt = g.tanks[m.tgt === 0 ? 0 : 1];
      if (tgt && tgt.alive) g.damage(tgt);

    } else if (m.t === 'brick') {
      const room = rooms.get(ws.room);
      if (!room || !room.game) return;
      const g = room.game;
      const c = m.c | 0, r = m.r | 0;
      if (c > 0 && r > 0 && c < COLS - 1 && r < ROWS - 1 && g.grid[r][c] === 1) {
        g.grid[r][c] = 0;
        g.ev({ e: 'br', x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 });
      }

    } else if (m.t === 'cmd') {
      const room = rooms.get(ws.room);
      if (!room || !room.game || ws.idx !== 0) return; // room creator only
      if (m.c === 'newmap') room.game.newRound(true);
      else if (m.c === 'reset') {
        room.game.scores = [0, 0];
        room.game.round = 1;
        room.game.newRound(false);
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (room) {
      const other = room.clients[ws.idx === 0 ? 1 : 0];
      if (other && other.readyState === 1) other.send(JSON.stringify({ t: 'peer_left' }));
      closeRoom(ws.room);
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

server.listen(PORT, () => console.log('Tank Duel authoritative server on port ' + PORT));
