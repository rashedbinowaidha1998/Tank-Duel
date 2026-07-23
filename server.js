// TANK DUEL — 4-player authoritative game server
// Lobby with names & teams, FFA or 2v2, deathmatch (last standing / first kill /
// kill points) and domination. The server runs the match; clients predict locally.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(html);
});

// ---------- GAME CONSTANTS (mirror the client exactly) ----------
const TILE = 32, COLS = 28, ROWS = 18;
const W = COLS * TILE, H = ROWS * TILE;
const T_RADIUS = 13, T_SPEED = 4.0, T_TURN = 0.075, T_TURRET = 0.10; // fast & furious (must match client)
const COLORS = ['#ffa62e', '#3ed6c0', '#c08cff', '#9df06b'];
const KILL_TARGET = 10;

function spawnPoint(i) {
  const pts = [
    { x: 2*TILE + TILE/2, y: 2*TILE + TILE/2, a: 0 },
    { x: (COLS-3)*TILE + TILE/2, y: (ROWS-3)*TILE + TILE/2, a: Math.PI },
    { x: (COLS-3)*TILE + TILE/2, y: 2*TILE + TILE/2, a: Math.PI },
    { x: 2*TILE + TILE/2, y: (ROWS-3)*TILE + TILE/2, a: 0 },
  ];
  return pts[i];
}

function eaglePoint(i) {
  const pts = [
    { x: 1*TILE + TILE/2, y: 1*TILE + TILE/2 },
    { x: (COLS-2)*TILE + TILE/2, y: (ROWS-2)*TILE + TILE/2 },
    { x: (COLS-2)*TILE + TILE/2, y: 1*TILE + TILE/2 },
    { x: 1*TILE + TILE/2, y: (ROWS-2)*TILE + TILE/2 },
  ];
  return pts[i];
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
  // all four corners are spawn zones now
  clearZone(2, 2); clearZone(COLS-3, ROWS-3);
  clearZone(COLS-3, 2); clearZone(2, ROWS-3);
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
  if (!seen[ROWS-3][COLS-3] || !seen[2][COLS-3] || !seen[ROWS-3][2]) return genMap(gm);
  if (gm === 'dom' && !seen[Math.floor(ROWS/2)][Math.floor(COLS/2)]) return genMap(gm);
  return g;
}

// ---------- GAME SIMULATION ----------
class Game {
  // cfg: { n, tm (teams mode), teams [per player], gm 'dm'|'dom'|'ctf', sub 'last'|'kills' }
  constructor(cfg) {
    this.n = cfg.n;
    this.tm = !!cfg.tm;
    this.teams = cfg.teams.slice(0, this.n);
    this.gm = ['dom','ctf','egl'].includes(cfg.gm) ? cfg.gm : 'dm';
    this.sub = ['last','kills'].includes(cfg.sub) ? cfg.sub : 'last';
    this.sideCount = this.tm ? 2 : this.n;
    this.ctfTarget = this.n * 25; // capture-the-flag win line: 25 points per player in the room
    this.scores = Array(this.n).fill(0);
    this.round = 1;
    this.winners = [];
    this.matchOver = false;
    this.inputs = Array.from({ length: this.n }, () => ({}));
    this.ammoRep = Array(this.n).fill(5); // each player's self-reported magazine
    this.shells = Array.from({ length: this.n }, () => []);
    this.events = [];
    this.dom = { pts: Array(this.sideCount).fill(0), cap: Array(this.sideCount).fill(0),
                 owner: -1, zone: { x: W/2, y: H/2, r: TILE*2 } };
    this.resp = Array(this.n).fill(0);
    this.newRound(true);
  }

  side(i) { return this.tm ? this.teams[i] : i; }
  sideScore(i) {
    return this.sideMembers(this.side(i)).reduce((a, j) => a + this.scores[j], 0);
  }
  sideMembers(s) {
    const out = [];
    for (let i = 0; i < this.n; i++) if (this.side(i) === s) out.push(i);
    return out;
  }
  respawnable() { return this.gm === 'dom' || this.gm === 'ctf' || this.gm === 'egl' || this.sub === 'kills'; }

  newRound(keepDomPoints) {
    const prev = this.tanks || [];
    this.grid = genMap(this.gm);
    this.tanks = [];
    for (let i = 0; i < this.n; i++) {
      const s = spawnPoint(i);
      const p = prev[i] || {};
      const t = { id: i, x: s.x, y: s.y, angle: s.a, turret: s.a,
                  hp: 3, alive: !p.gone && !p.elim, gone: !!p.gone, elim: !!p.elim,
                  type: p.type || 'gunner', inv: 0 };
      this.tanks.push(t);
    }
    this.shells = Array.from({ length: this.n }, () => []);
    this.dom.cap = Array(this.sideCount).fill(0);
    this.dom.owner = -1;
    this.resp = Array(this.n).fill(0);
    if (!keepDomPoints) this.dom.pts = Array(this.sideCount).fill(0);
    this.eagles = this.gm === 'egl'
      ? Array.from({ length: this.n }, (_, i) => ({ hp: 30, alive: true }))
      : null;
    this.flags = this.gm === 'ctf'
      ? Array.from({ length: this.n }, (_, i) => {
          const sp = spawnPoint(i);
          return { st: 0, x: sp.x, y: sp.y, by: -1, dropT: 0 }; // 0 home, 1 carried, 2 dropped
        })
      : null;
    this.winners = [];
    this.state = 'countdown';
    this.countdownT = 3600;
    this.prevAdv = Array(this.n).fill(true);
  }

  freshMatch() {
    this.scores = Array(this.n).fill(0);
    this.round = 1;
    this.matchOver = false;
    this.dom.pts = Array(this.sideCount).fill(0);
    this.newRound(true);
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
    const k = dt / 16.667;
    const c = this.inputs[t.id] || {};
    if (c.ty && t.type !== c.ty) t.type = c.ty;
    if (t.inv > 0) {
      t.inv -= dt;
      if ((c.fwd || c.back) && t.inv > 1000) t.inv = 1000; // moving forfeits most of the shield
      if (t.inv < 0) t.inv = 0;
    }
    if (c.left) { t.angle -= T_TURN * k; if (t.type === 'gunner') t.turret -= T_TURN * k; }
    if (c.right) { t.angle += T_TURN * k; if (t.type === 'gunner') t.turret += T_TURN * k; }
    if (t.type === 'gunner') {
      if (c.tl) t.turret -= T_TURRET * k;
      if (c.tr) t.turret += T_TURRET * k;
    } else {
      t.turret = t.angle;
    }
    let v = 0;
    if (c.fwd) v = T_SPEED * k;
    if (c.back) v = -T_SPEED * 0.62 * k;
    const nx = t.x + Math.cos(t.angle) * v;
    const ny = t.y + Math.sin(t.angle) * v;
    if (!this.circleHitsWall(nx, t.y, T_RADIUS)) t.x = nx;
    if (!this.circleHitsWall(t.x, ny, T_RADIUS)) t.y = ny;

    for (const other of this.tanks) {
      if (other === t || !other.alive) continue;
      const dx = t.x - other.x, dy = t.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < T_RADIUS * 2) {
        const push = (T_RADIUS*2 - d) / 2;
        if (!this.circleHitsWall(t.x + dx/d*push, t.y + dy/d*push, T_RADIUS)) {
          t.x += dx/d*push; t.y += dy/d*push;
        }
      }
    }
  }

  damage(t, by) {
    if (!t.alive) return;
    t.hp--;
    this.ev({ e: 'sp', x: t.x | 0, y: t.y | 0, c: COLORS[t.id], n: 14 });
    this.ev({ e: 'sh', v: 6 });
    if (t.hp > 0) return;

    t.alive = false;
    this.ev({ e: 'bm', x: t.x | 0, y: t.y | 0, c: COLORS[t.id] });

    if (this.gm === 'dom') { this.resp[t.id] = 2500; return; }

    const enemyKill = by != null && this.side(by) !== this.side(t.id);

    if (this.gm === 'egl') {
      if (enemyKill) {
        this.scores[by]++;
        this.ev({ e: 'cp', w: this.side(by) });
        if (this.sideScore(by) >= 10) {
          this.winners = this.sideMembers(this.side(by));
          this.matchOver = true;
          this.enterRoundOver();
          return;
        }
      }
      if (!t.elim) this.resp[t.id] = 2500;
      return;
    }

    if (this.gm === 'ctf') {
      // the fallen drop everything they were carrying
      for (const f of this.flags) {
        if (f.st === 1 && f.by === t.id) {
          f.st = 2; f.by = -1; f.x = t.x; f.y = t.y; f.dropT = 15000;
          this.ev({ e: 'fd', x: t.x | 0, y: t.y | 0 });
        }
      }
      if (enemyKill) {
        this.scores[by] += 2;
        this.ev({ e: 'kp', w: by });
        if (this.sideScore(by) >= this.ctfTarget) {
          this.winners = this.sideMembers(this.side(by));
          this.matchOver = true;
          this.enterRoundOver();
          return;
        }
      }
      this.resp[t.id] = 2500;
      return;
    }

    if (this.sub === 'kills') {
      if (enemyKill) {
        this.scores[by]++;
        this.ev({ e: 'cp', w: this.side(by) }); // score flash
        if (this.scores[by] >= KILL_TARGET) {
          this.winners = this.sideMembers(this.side(by));
          this.matchOver = true;
          this.enterRoundOver();
          return;
        }
      }
      this.resp[t.id] = 2500;
      return;
    }

    // 'last': elimination until one side remains
    const aliveSides = new Set(this.tanks.filter(x => x.alive && !x.gone).map(x => this.side(x.id)));
    if (aliveSides.size <= 1) {
      const s = aliveSides.size === 1 ? [...aliveSides][0] : (by != null ? this.side(by) : this.side(t.id));
      this.winners = this.sideMembers(s);
      for (const w of this.winners) this.scores[w]++;
      this.enterRoundOver();
    }
  }

  enterRoundOver() {
    this.state = 'roundOver';
    this.prevAdv = this.inputs.map(i => !!(i && i.adv));
  }

  respawn(i) {
    const t = this.tanks[i], s = spawnPoint(i);
    if (t.gone) return;
    t.x = s.x; t.y = s.y; t.angle = s.a; t.turret = s.a;
    t.hp = 3; t.alive = true;
    t.inv = 3000; // spawn shield: 3s, cut to 1s left the moment you drive
    this.ev({ e: 'sp', x: s.x | 0, y: s.y | 0, c: COLORS[i], n: 12 });
  }

  updateDom(dt) {
    const z = this.dom.zone;
    const insideSide = Array(this.sideCount).fill(false);
    for (const t of this.tanks) {
      if (t.alive && !t.gone && Math.hypot(t.x - z.x, t.y - z.y) < z.r) insideSide[this.side(t.id)] = true;
    }
    const sidesIn = insideSide.filter(Boolean).length;

    if (this.dom.owner !== -1) {
      this.dom.pts[this.dom.owner] = Math.min(100, this.dom.pts[this.dom.owner] + dt / 1000);
      if (this.dom.pts[this.dom.owner] >= 100) {
        this.winners = this.sideMembers(this.dom.owner);
        this.matchOver = true;
        this.enterRoundOver();
        return;
      }
    }

    for (let s = 0; s < this.sideCount; s++) {
      if (s === this.dom.owner) { this.dom.cap[s] = 0; continue; }
      if (insideSide[s] && sidesIn === 1) this.dom.cap[s] = Math.min(100, this.dom.cap[s] + 25 * dt / 1000);
      else if (!insideSide[s]) this.dom.cap[s] = Math.max(0, this.dom.cap[s] - 12.5 * dt / 1000);
      // multiple sides inside -> contested, meters freeze
      if (this.dom.cap[s] >= 100) {
        this.dom.cap = Array(this.sideCount).fill(0);
        this.dom.owner = s;
        this.ev({ e: 'cp', w: s });
      }
    }
  }

  updateCTF(dt) {
    const BASE_R = TILE * 1.3, TOUCH_R = T_RADIUS + 9;
    for (let o = 0; o < this.n; o++) {
      const f = this.flags[o];
      if (f.st === 1) { // carried: rides the carrier
        const c = this.tanks[f.by];
        if (!c || !c.alive || c.gone) { f.st = 2; f.by = -1; f.dropT = 15000; }
        else { f.x = c.x; f.y = c.y; }
        continue;
      }
      if (f.st === 2) {
        f.dropT -= dt;
        if (f.dropT <= 0) { // untouched too long: flies home
          const sp = spawnPoint(o);
          f.st = 0; f.x = sp.x; f.y = sp.y;
          this.ev({ e: 'fr', x: sp.x | 0, y: sp.y | 0, c: COLORS[o] });
          continue;
        }
      }
      for (const t of this.tanks) {
        if (!t.alive || t.gone) continue;
        if (Math.hypot(t.x - f.x, t.y - f.y) > TOUCH_R) continue;
        if (this.side(t.id) === this.side(o)) {
          // your own (or a teammate's) flag: touching it does nothing —
          // a dropped flag stays on the field until stolen again or the 15s timer flies it home
        } else { // touched by an enemy: stolen
          f.st = 1; f.by = t.id; f.x = t.x; f.y = t.y;
          this.ev({ e: 'fg', x: t.x | 0, y: t.y | 0, c: COLORS[o] });
          break;
        }
      }
    }
    // deliveries: carrier reaches their own base
    for (const t of this.tanks) {
      if (!t.alive || t.gone) continue;
      const sp = spawnPoint(t.id);
      if (Math.hypot(t.x - sp.x, t.y - sp.y) > BASE_R) continue;
      const carried = this.flags.filter(f => f.st === 1 && f.by === t.id);
      if (!carried.length) continue;
      const pts = carried.length === 1 ? 10 : carried.length === 2 ? 30 : 90;
      this.scores[t.id] += pts;
      for (const f of carried) {
        const o = this.flags.indexOf(f);
        const so = spawnPoint(o);
        f.st = 0; f.by = -1; f.x = so.x; f.y = so.y;
      }
      this.ev({ e: 'cap2', x: sp.x | 0, y: sp.y | 0, w: t.id, k: carried.length, p: pts });
      if (this.sideScore(t.id) >= this.ctfTarget) {
        this.winners = this.sideMembers(this.side(t.id));
        this.matchOver = true;
        this.enterRoundOver();
        return;
      }
    }
  }

  tick(dt) {
    if (this.state === 'countdown') {
      this.countdownT -= dt;
      if (this.countdownT <= 0) this.state = 'play';
    } else if (this.state === 'play') {
      for (const t of this.tanks) this.updateTank(t, dt);
      if (this.gm === 'dom') this.updateDom(dt);
      if (this.gm === 'ctf') this.updateCTF(dt);
      if (this.respawnable()) {
        for (let i = 0; i < this.n; i++) {
          if (!this.tanks[i].alive && !this.tanks[i].gone && !this.tanks[i].elim) {
            this.resp[i] -= dt;
            if (this.resp[i] <= 0) this.respawn(i);
          }
        }
      }
    } else if (this.state === 'roundOver') {
      for (let i = 0; i < this.n; i++) {
        const adv = !!(this.inputs[i] && this.inputs[i].adv);
        if (adv && !this.prevAdv[i]) {
          if (this.matchOver) this.freshMatch();
          else { this.round++; this.newRound(this.gm === 'dom'); }
          return;
        }
        this.prevAdv[i] = adv;
      }
    }
  }

  eagleHit(owner, by) {
    if (this.gm !== 'egl' || this.state !== 'play') return;
    const e = this.eagles[owner];
    const t = this.tanks[owner];
    if (!e || !e.alive || !t || t.gone || t.elim) return;
    if (this.side(owner) === this.side(by)) return; // friendly shells can't harm it
    e.hp--;
    const p = eaglePoint(owner);
    this.ev({ e: 'eh', x: p.x | 0, y: p.y | 0, c: COLORS[owner] });
    if (e.hp > 0) return;
    e.alive = false;
    t.elim = true;
    if (t.alive) { t.alive = false; this.ev({ e: 'bm', x: t.x | 0, y: t.y | 0, c: COLORS[owner] }); }
    this.ev({ e: 'ebm', x: p.x | 0, y: p.y | 0, c: COLORS[owner], w: owner });
    // last side standing?
    const sidesLeft = new Set(this.tanks.filter(x => !x.gone && !x.elim).map(x => this.side(x.id)));
    if (sidesLeft.size <= 1) {
      this.winners = sidesLeft.size === 1 ? this.sideMembers([...sidesLeft][0]) : [];
      this.matchOver = true;
      this.enterRoundOver();
    }
  }

  playerLeft(i) {
    const t = this.tanks[i];
    if (!t) return;
    t.gone = true;
    if (t.alive) {
      t.alive = false;
      this.ev({ e: 'bm', x: t.x | 0, y: t.y | 0, c: COLORS[i] });
    }
    // does the round resolve now?
    if (this.state === 'play' && this.gm === 'egl') {
      const sidesLeft = new Set(this.tanks.filter(x => !x.gone && !x.elim).map(x => this.side(x.id)));
      if (sidesLeft.size <= 1) {
        this.winners = sidesLeft.size === 1 ? this.sideMembers([...sidesLeft][0]) : [];
        this.matchOver = true;
        this.enterRoundOver();
        return;
      }
    }
    if (this.state === 'play' && this.gm === 'dm' && this.sub !== 'kills') {
      const aliveSides = new Set(this.tanks.filter(x => x.alive && !x.gone).map(x => this.side(x.id)));
      if (aliveSides.size === 1) {
        this.winners = this.sideMembers([...aliveSides][0]);
        for (const w of this.winners) this.scores[w]++;
        this.enterRoundOver();
      }
    }
  }

  activePlayers() { return this.tanks.filter(t => !t.gone).length; }

  makeSnap(q) {
    const bl = [];
    for (let i = 0; i < this.n; i++)
      for (const b of this.shells[i]) bl.push({ i: i + '-' + b.i, x: b.x, y: b.y, o: i });
    return {
      t: 'snap', q, ts: Date.now(),
      st: this.state, cd: Math.max(0, this.countdownT | 0),
      rd: this.round, sc: this.scores.map(x => Math.floor(x)),
      wi: this.winners, mo: this.matchOver ? 1 : 0,
      gm: this.gm, sub: this.sub, tm: this.tm ? 1 : 0,
      dm: this.gm === 'dom'
        ? { p: this.dom.pts.map(x => Math.floor(x)), c: this.dom.cap.map(x => +x.toFixed(1)), o: this.dom.owner }
        : null,
      rs: this.resp.map(x => Math.max(0, x | 0)),
      fg: this.gm === 'ctf' ? this.flags.map(f => ({ s: f.st, x: f.x | 0, y: f.y | 0, b: f.by })) : null,
      eg: this.gm === 'egl' ? this.eagles.map(e => ({ h: e.hp, a: e.alive ? 1 : 0 })) : null,
      g: this.grid.flat().join(''),
      tk: this.tanks.map(t => ({
        x: +t.x.toFixed(1), y: +t.y.toFixed(1),
        a: +t.angle.toFixed(3), tu: +t.turret.toFixed(3),
        ty: t.type, hp: t.hp, al: t.alive ? 1 : 0, gn: t.gone ? 1 : 0,
        am: this.ammoRep[t.id], iv: t.inv > 0 ? (t.inv | 0) : 0, el: t.elim ? 1 : 0
      })),
      bl,
      ev: this.events.splice(0)
    };
  }
}

// ---------- ROOMS & LOBBY ----------
const wss = new WebSocketServer({ server });
const rooms = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return rooms.has(c) ? genCode() : c;
}

function lobbyMsg(room) {
  return JSON.stringify({
    t: 'lobby',
    pl: room.clients.map((ws, i) => ({ n: room.names[i], team: room.teams[i] })),
    set: room.set,
    code: room.code
  });
}
function broadcastLobby(room) {
  const msg = lobbyMsg(room);
  for (const ws of room.clients) if (ws.readyState === 1) ws.send(msg);
}
function broadcast(room, str) {
  for (const ws of room.clients) if (ws.readyState === 1) ws.send(str);
}

function startRoom(room) {
  room.game = new Game({
    n: room.clients.length,
    tm: room.set.tm,
    teams: room.teams,
    gm: room.set.gm,
    sub: room.set.sub
  });
  room.started = true;
  broadcast(room, JSON.stringify({
    t: 'started',
    pl: room.clients.map((ws, i) => ({ n: room.names[i], team: room.teams[i] })),
    set: room.set
  }));
  let last = Date.now();
  let sendToggle = 0;
  room.timer = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(50, now - last);
    last = now;
    room.game.tick(dt);
    { // 60 snapshots/sec — your server and ping can afford the royal treatment
      const base = room.game.makeSnap(++room.q);
      room.clients.forEach((ws, i) => {
        if (ws && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ ...base, ep: room.pings[i] || 0 })); } catch {}
        }
      });
    }
  }, 1000 / 60);
}

function closeRoom(code, notify) {
  const room = rooms.get(code);
  if (!room) return;
  clearInterval(room.timer);
  if (notify) broadcast(room, JSON.stringify({ t: 'peer_left' }));
  rooms.delete(code);
}

wss.on('connection', ws => {
  ws.isAlive = true;
  if (ws._socket && ws._socket.setNoDelay) ws._socket.setNoDelay(true);
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    const room = rooms.get(ws.room);

    if (m.t === 'create') {
      const code = genCode();
      rooms.set(code, {
        code, clients: [ws], names: ['Player 1'], teams: [0],
        set: { gm: ['dm','dom','ctf','egl'].includes(m.gm) ? m.gm : 'dm', sub: 'last', tm: false },
        started: false, game: null, timer: null, pings: [0,0,0,0], q: 0
      });
      ws.room = code; ws.idx = 0;
      ws.send(JSON.stringify({ t: 'room', code }));
      ws.send(JSON.stringify({ t: 'ready', idx: 0 }));
      broadcastLobby(rooms.get(code));

    } else if (m.t === 'join') {
      const code = String(m.code || '').toUpperCase();
      const r = rooms.get(code);
      if (!r) { ws.send(JSON.stringify({ t: 'err', msg: 'ROOM NOT FOUND — CHECK THE CODE' })); return; }
      if (r.started) { ws.send(JSON.stringify({ t: 'err', msg: 'GAME ALREADY IN PROGRESS' })); return; }
      if (r.clients.length >= 4) { ws.send(JSON.stringify({ t: 'err', msg: 'ROOM IS FULL (4 MAX)' })); return; }
      const idx = r.clients.length;
      r.clients.push(ws);
      r.names.push('Player ' + (idx + 1));
      r.teams.push(r.set.tm ? idx % 2 : 0);
      ws.room = code; ws.idx = idx;
      ws.send(JSON.stringify({ t: 'ready', idx }));
      broadcastLobby(r);

    } else if (m.t === 'name') {
      if (!room || room.started) return;
      const n = String(m.n || '').replace(/[^\w \-\.]/g, '').trim().slice(0, 12);
      room.names[ws.idx] = n || ('Player ' + (ws.idx + 1));
      broadcastLobby(room);

    } else if (m.t === 'team') {
      if (!room || room.started || ws.idx !== 0 || !room.set.tm) return;
      const who = m.who | 0;
      if (who >= 0 && who < room.clients.length) {
        room.teams[who] = room.teams[who] === 0 ? 1 : 0;
        broadcastLobby(room);
      }

    } else if (m.t === 'set') {
      if (!room || room.started || ws.idx !== 0) return;
      if (m.k === 'gm' && ['dm','dom','ctf','egl'].includes(m.v)) room.set.gm = m.v;
      if (m.k === 'sub' && ['last','kills'].includes(m.v)) room.set.sub = m.v;
      if (m.k === 'tm') {
        room.set.tm = !!m.v;
        room.teams = room.teams.map((_, i) => room.set.tm ? i % 2 : 0);
      }
      broadcastLobby(room);

    } else if (m.t === 'start') {
      if (!room || room.started || ws.idx !== 0) return;
      if (room.clients.length < 2) { ws.send(JSON.stringify({ t: 'err', msg: 'NEED AT LEAST 2 PLAYERS' })); return; }
      if (room.set.tm) {
        const t0 = room.teams.some(t => t === 0), t1 = room.teams.some(t => t === 1);
        if (!t0 || !t1) { ws.send(JSON.stringify({ t: 'err', msg: 'BOTH TEAMS NEED AT LEAST 1 PLAYER' })); return; }
      }
      startRoom(room);

    } else if (m.t === 'input') {
      if (!room || !room.game) return;
      room.game.inputs[ws.idx] = m.k || {};
      if (typeof m.am === 'number') room.game.ammoRep[ws.idx] = Math.max(0, Math.min(5, m.am));
      if (Array.isArray(m.sh)) room.game.shells[ws.idx] = m.sh.slice(0, 8);
      if (m.pt) room.pings[ws.idx] = m.pt;

    } else if (m.t === 'hit') {
      if (!room || !room.game) return;
      const g = room.game;
      if (g.state !== 'play') return;
      const ti = m.tgt | 0;
      if (ti < 0 || ti >= g.n) return;
      const tgt = g.tanks[ti];
      if (!tgt || !tgt.alive || tgt.gone) return;
      if (tgt.inv > 0) return; // spawn shield: the referee waves it off
      // no friendly fire (self-hits allowed)
      if (ti !== ws.idx && g.side(ti) === g.side(ws.idx)) return;
      g.damage(tgt, ws.idx);

    } else if (m.t === 'cmd') {
      if (!room || !room.game || ws.idx !== 0) return;
      if (m.c === 'newmap') room.game.newRound(room.game.gm === 'dom');
      else if (m.c === 'reset') room.game.freshMatch();

    } else if (m.t === 'eagle') {
      if (!room || !room.game) return;
      room.game.eagleHit(m.tgt | 0, ws.idx);

    } else if (m.t === 'brick') {
      if (!room || !room.game) return;
      const g = room.game;
      const c = m.c | 0, r = m.r | 0;
      if (c > 0 && r > 0 && c < COLS - 1 && r < ROWS - 1 && g.grid[r][c] === 1) {
        g.grid[r][c] = 0;
        g.ev({ e: 'br', x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 });
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;

    if (!room.started) {
      if (ws.idx === 0) { closeRoom(ws.room, true); return; } // host left the lobby
      const i = room.clients.indexOf(ws);
      if (i > -1) {
        room.clients.splice(i, 1);
        room.names.splice(i, 1);
        room.teams.splice(i, 1);
        room.clients.forEach((c, j) => {
          c.idx = j;
          if (c.readyState === 1) c.send(JSON.stringify({ t: 'ready', idx: j }));
        });
        broadcastLobby(room);
      }
      return;
    }

    // in-game: the tank is abandoned, the match continues if 2+ remain
    room.game.playerLeft(ws.idx);
    const remaining = room.clients.filter(c => c !== ws && c.readyState === 1).length;
    if (remaining < 2) closeRoom(ws.room, true);
  });
});

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, () => console.log('Tank Duel 4-player authoritative server on port ' + PORT));
