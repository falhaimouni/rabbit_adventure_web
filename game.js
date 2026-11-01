// Rabbit Adventure - browser edition. Game loop, rendering, input and screens.
import { CFG, LEVEL_GUIDES, DIRECTIONS, validateMap, LevelMechanics, nextFoxPosition, HazardField, hazardPhase } from './logic.js';
import { LEVELS } from './levels.js';
import { loadImage, createPuzzleTiles, helpers } from './art.js';
import { HandTracker } from './hands.js';
import { Sound } from './audio.js';

const $ = (s) => document.querySelector(s);
const el = {
  title: $('#title'), game: $('#game'), help: $('#help'), modal: $('#modal'), loading: $('#loading'),
  board: $('#board'), stage: $('#stage'), cam: $('#cam'), camCard: $('#cam-card'), camMsg: $('#cam-msg'),
  camLabel: $('#cam-label'), camStatus: $('.cam-status'), btnCam: $('#btn-cam'),
  hudLevel: $('#hud-level'), hudTitle: $('#hud-title'), hudCarrots: $('#hud-carrots'),
  hint: $('#hint'), status: $('#status'), mute: $('#btn-mute'), full: $('#btn-full'),
};
const sound = new Sound();
const tracker = new HandTracker();
const hasPointerAPI = 'PointerEvent' in window;

// ============================================================ textures
const CELLS = { 1: [1, 0], P: [2, 0], C: [0, 1], E: [1, 1], W: [2, 1], L: [0, 2], F: [1, 2], R: [2, 2] };
let atlasImg, groundImg, puzzleTiles;
const texCache = new Map();

function makeCanvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function flipped(src, T) {
  const c = makeCanvas(T), g = c.getContext('2d');
  g.translate(T, 0); g.scale(-1, 1); g.drawImage(src, 0, 0, T, T);
  return c;
}

function buildTextures(T) {
  if (texCache.has(T)) return texCache.get(T);
  const tex = {}, cell = atlasImg.width / 3;
  for (const [k, [col, row]] of Object.entries(CELLS)) {
    const c = makeCanvas(T), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(atlasImg, col * cell, row * cell, cell, cell, 0, 0, T, T);
    tex[k] = c;
  }
  const ground = makeCanvas(T), gg = ground.getContext('2d');
  gg.imageSmoothingQuality = 'high';
  gg.drawImage(groundImg, 0, 0, T, T);
  gg.globalCompositeOperation = 'multiply'; gg.fillStyle = 'rgb(221,231,210)'; gg.fillRect(0, 0, T, T);
  tex['0'] = ground;
  Object.assign(tex, puzzleTiles);
  // Fragile plank: water + log + cracks
  const plank = makeCanvas(T), pg = plank.getContext('2d');
  pg.drawImage(tex.W, 0, 0); pg.drawImage(tex.L, 0, 0);
  helpers.lines(pg, [59, 47, 31], false, [[T / 2, T / 3], [T / 2 - T / 16, T / 2], [T / 2 + T / 16, T / 2 + T / 16], [T / 2, 2 * T / 3]], Math.max(1, T / 32));
  tex.X = plank;
  tex.P_left = flipped(tex.P, T);
  tex.F_right = flipped(tex.F, T);
  texCache.set(T, tex);
  if (texCache.size > 3) texCache.delete(texCache.keys().next().value);
  return tex;
}

// ============================================================ motion helpers
class MoveRepeater {
  constructor(interval) { this.interval = interval; this.next = 0; }
  /** Move immediately at first, then limit every step, including direction changes. */
  poll(direction, now) {
    if (!direction) return null;
    if (now >= this.next) { this.next = now + this.interval; return direction; }
    return null;
  }
}
class AnimatedPosition {
  constructor(x, y, duration = 120) { this.start = this.target = [x, y]; this.startedAt = 0; this.duration = duration; }
  position(now) {
    const p = Math.min(1, Math.max(0, (now - this.startedAt) / this.duration));
    return [this.start[0] + (this.target[0] - this.start[0]) * p, this.start[1] + (this.target[1] - this.start[1]) * p];
  }
  moveTo(x, y, now, snap = false) {
    this.start = snap ? [x, y] : this.position(now);
    this.target = [x, y]; this.startedAt = now;
  }
}

// ============================================================ a single level
class Level {
  constructor(index) {
    this.index = index;
    this.grid = LEVELS[index].map((r) => [...r]);
    this.w = this.grid[0].length; this.h = this.grid.length;
    let px = 1, py = 1;
    this.grid.forEach((row, y) => row.forEach((ch, x) => { if (ch === 'P') { px = x; py = y; } }));
    this.px = px; this.py = py; this.grid[py][px] = '0';
    this.mech = new LevelMechanics(this.grid);
    this.puzzle = { sunOpen: false, collapsed: 0 };

    this.logs = [];
    if (index === 1) {
      for (let x = 0; x < this.w; x++) {
        if (this.grid[1][x] === 'W') {
          const direction = x % 2 === 0 ? 1 : -1;
          for (let y = 1; y < this.h - 1; y += 3) this.logs.push({ x, y, direction, timer: 0, anim: new AnimatedPosition(x, y, CFG.ANIMATION_MS) });
        }
      }
    }
    this.foxes = [];
    const portalFox = index === 4;
    this.grid.forEach((row, y) => row.forEach((ch, x) => {
      if (ch === 'F') {
        this.foxes.push({ x, y, facing: 'left', interval: portalFox ? CFG.PORTAL_FOX_INTERVAL_MS : CFG.FOX_INTERVAL_MS,
          timer: -(portalFox ? CFG.PORTAL_FOX_GRACE_MS : 0), anim: new AnimatedPosition(x, y, CFG.ANIMATION_MS) });
        this.grid[y][x] = '0';
      }
    }));
    this.hazards = new HazardField(index, this.grid);
    this.portals = []; this.switches = [];
    this.grid.forEach((row, y) => row.forEach((ch, x) => {
      if ('ABUV'.includes(ch)) this.portals.push([x, y, ch]);
      else if (ch === 'S') this.switches.push([x, y]);
    }));
    this.facing = 'right';
    this.coins = this.grid.reduce((n, r) => n + r.filter((c) => c === 'C').length, 0);
    this.initialCoins = this.coins;
    this.gameOver = false; this.won = false; this.finished = false;
    this.moves = 0; this.elapsed = 0; this.now = 0;
    this.anim = new AnimatedPosition(px, py, CFG.ANIMATION_MS);
    this.repeater = new MoveRepeater(CFG.MOVE_INTERVAL_MS);
    this.particles = [];
    this.T = 0;
  }

  get title() { return LEVEL_GUIDES[this.index][0]; }
  get hint() { return LEVEL_GUIDES[this.index][1]; }

  // ---------------------------------------------------------- rendering setup
  layout(T) {
    this.T = T;
    this.tex = buildTextures(T);
    this.bg = makeCanvas(this.w * T, this.h * T);
    this.bgCtx = this.bg.getContext('2d');
    this.bgCtx.imageSmoothingQuality = 'high';
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.redrawTile(x, y);
  }
  redrawTile(x, y) {
    const T = this.T, g = this.bgCtx;
    g.drawImage(this.tex['0'], x * T, y * T, T, T);
    const k = this.mech.textureKey(x, y, this.puzzle);
    if (k !== '0') g.drawImage(this.tex[k] || this.tex['0'], x * T, y * T, T, T);
  }

  // ---------------------------------------------------------- rules
  move(dx, dy, dir, now) {
    if (dx) this.facing = dir; // up/down keep the last horizontal facing
    const nx = this.px + dx, ny = this.py + dy;
    if (!(nx >= 0 && nx < this.w && ny >= 0 && ny < this.h)) return;
    const target = this.grid[ny][nx];
    const onLog = this.logs.some((l) => l.x === nx && l.y === ny);
    if (this.mech.fragileBit(nx, ny) & this.puzzle.collapsed) { this.gameOver = true; return; }
    if (this.mech.blocked(nx, ny, this.puzzle)) return;
    if (target === 'W' && !onLog) { this.gameOver = true; return; }

    this.moves++;
    const origin = [this.px, this.py], prev = this.puzzle;
    const [[lx, ly], next] = this.mech.enter(origin, [nx, ny], this.puzzle);
    this.px = lx; this.py = ly; this.puzzle = next;
    this.hazards.arrive();
    const teleported = lx !== nx || ly !== ny;
    this.anim.moveTo(lx, ly, now, teleported);
    if (prev.sunOpen !== next.sunOpen) for (const g of this.mech.gates) this.redrawTile(g[0], g[1]);
    if (prev.collapsed !== next.collapsed) this.redrawTile(origin[0], origin[1]);
    if (this.hazards.deadly(lx, ly) || this.foxes.some((f) => f.x === lx && f.y === ly)) { this.gameOver = true; return; }
    const t = this.grid[ly][lx];
    if (t === 'C') {
      this.grid[ly][lx] = '0'; this.coins--;
      this.collect(lx + 0.5, ly + 0.5);
      this.redrawTile(lx, ly);
    } else if (t === 'E' && this.coins === 0) {
      this.won = true;
    }
  }

  collect(x, y) {
    sound.play('collect');
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, s = (15 + Math.random() * 45) / 64;
      this.particles.push([x, y, Math.cos(a) * s, Math.sin(a) * s - 15 / 64, 0.65]);
    }
  }

  update(dt, now, direction) {
    this.now = now; this.elapsed += dt; this.hazards.advance(dt);
    if (!this.won && this.hazards.deadly(this.px, this.py)) this.gameOver = true;
    const step = this.repeater.poll(direction, now);
    if (step && !this.gameOver && !this.won) this.move(...DIRECTIONS[step], step, now);
    if (this.won && now - this.anim.startedAt >= CFG.ANIMATION_MS) { this.finished = true; return; }

    if (this.index === 1 && !this.gameOver && !this.won) {
      let onAny = false;
      for (const log of this.logs) {
        log.timer += dt;
        while (log.timer >= CFG.LOG_INTERVAL_MS) {
          log.timer -= CFG.LOG_INTERVAL_MS;
          if (this.px === log.x && this.py === log.y) { this.py += log.direction; this.anim.moveTo(this.px, this.py, now); }
          log.y += log.direction;
          let wrapped = false;
          if (log.y >= this.h - 1) { log.y = 1; wrapped = true; } else if (log.y <= 0) { log.y = this.h - 2; wrapped = true; }
          log.anim.moveTo(log.x, log.y, now, wrapped);
        }
        if (this.px === log.x && this.py === log.y) onAny = true;
      }
      const under = this.grid[this.py] && this.grid[this.py][this.px];
      if (under === 'W' && !onAny) this.gameOver = true;
      if (this.py <= 0 || this.py >= this.h - 1) this.gameOver = true;
    }

    // Contact is checked before a fox moves, so stepping onto one is always fatal.
    if (this.foxes.length && !this.gameOver && !this.won) {
      for (const fox of this.foxes) {
        if (fox.x === this.px && fox.y === this.py) { this.gameOver = true; break; }
        fox.timer += dt;
        while (fox.timer >= fox.interval) {
          fox.timer -= fox.interval;
          const prev = [fox.x, fox.y];
          [fox.x, fox.y] = nextFoxPosition(this.grid, prev, [this.px, this.py], this.mech, this.puzzle, this.index === 4);
          const teleported = Math.abs(fox.x - prev[0]) + Math.abs(fox.y - prev[1]) > 1;
          if (!teleported && fox.x !== prev[0]) fox.facing = fox.x > prev[0] ? 'right' : 'left';
          fox.anim.moveTo(fox.x, fox.y, now, teleported);
          if (fox.x === this.px && fox.y === this.py) { this.gameOver = true; break; }
        }
        if (this.gameOver) break;
      }
    }
  }

  // ---------------------------------------------------------- drawing
  tile(g, k, x, y) { g.drawImage(this.tex[k] || this.tex['0'], Math.round(x), Math.round(y), this.T, this.T); }

  draw(g, now, dt) {
    const T = this.T, k = T / 64;
    g.clearRect(0, 0, this.w * T, this.h * T);
    g.drawImage(this.bg, 0, 0);
    const frame = Math.floor(this.hazards.elapsed / 90) % 16;
    for (const [x, y, ch] of this.portals) { this.tile(g, '0', x * T, y * T); this.tile(g, `${ch}_${frame}`, x * T, y * T); }
    for (const [x, y] of this.switches) { this.tile(g, '0', x * T, y * T); this.tile(g, this.puzzle.sunOpen ? 'S_on' : 'S', x * T, y * T); }
    this.drawHazards(g, T, k);
    for (const log of this.logs) { const [x, y] = log.anim.position(now); this.tile(g, 'L', x * T, y * T); }
    for (const fox of this.foxes) { const [x, y] = fox.anim.position(now); this.tile(g, fox.facing === 'right' ? 'F_right' : 'F', x * T, y * T); }
    const [x, y] = this.anim.position(now);
    this.tile(g, this.facing === 'left' ? 'P_left' : 'P', x * T, y * T);

    // collection sparkles
    const alive = [];
    for (const p of this.particles) {
      p[4] -= dt / 1000;
      if (p[4] <= 0) continue;
      p[0] += p[2] * dt / 1000; p[1] += p[3] * dt / 1000;
      g.beginPath(); g.arc(p[0] * T, p[1] * T, Math.max(1, p[4] * 5 * k), 0, Math.PI * 2);
      g.fillStyle = 'rgb(239,201,115)'; g.fill();
      alive.push(p);
    }
    this.particles = alive;

    if (this.coins === 0) {
      g.strokeStyle = 'rgb(213,234,156)'; g.lineWidth = Math.max(1, 2 * k);
      this.grid.forEach((row, gy) => row.forEach((ch, gx) => {
        if (ch === 'E') { g.beginPath(); g.arc((gx + 0.5) * T, (gy + 0.5) * T, T / 2 - 3 * k, 0, Math.PI * 2); g.stroke(); }
      }));
    }
  }

  drawHazards(g, T, k) {
    const active = this.hazards.activeTiles(this.mech, this.puzzle);
    if (!active.length) return;
    const phase = this.hazards.elapsed / 1000;
    const L = helpers.lines;
    for (const [x, y] of active) {
      const tile = this.grid[y][x], left = x * T, top = y * T;
      if (tile === 'T') {
        const pts = [];
        for (let step = 0; step < 9; step++) {
          pts.push([left + step * T / 8, top + T * 0.5 + Math.sin((x * 8 + step) * 1.7 + Math.trunc(phase * 12)) * T * 0.12]);
        }
        L(g, [100, 175, 219, 55], false, pts, 21 * k);
        L(g, [141, 206, 238, 160], false, pts, 8 * k);
        L(g, [247, 251, 223, 255], false, pts, Math.max(1, 2 * k));
        const cx = left + T * 0.5;
        const bolt = [[cx + 8 * k, top + 9 * k], [cx - 7 * k, top + T * 0.45], [cx + 5 * k, top + T * 0.48], [cx - 9 * k, top + T - 9 * k]];
        L(g, [117, 192, 239, 95], false, bolt, 13 * k);
        L(g, [235, 250, 244, 255], false, bolt, Math.max(1, 3 * k));
      } else {
        g.fillStyle = 'rgba(38,134,159,0.41)'; g.fillRect(left, top, T, T);
        for (let row = 0; row < 3; row++) {
          const pts = [];
          for (let step = 0; step < 13; step++) {
            pts.push([left + step * T / 12, top + (row + 0.5) * T / 3 + Math.sin(step * 0.6 + phase * 7 + x) * 4 * k]);
          }
          L(g, [131, 221, 227, 160], false, pts, 7 * k);
          L(g, [227, 246, 224, 230], false, pts, Math.max(1, 2 * k));
        }
      }
    }
  }

  statusText() {
    const gate = this.mech.gates.length
      ? (this.puzzle.sunOpen ? 'Sun gates open / Moon gates closed' : 'Moon gates open / Sun gates closed') : '';
    let danger = this.hazards.status(this.px, this.py);
    if (this.index === 4) {
      const wake = Math.max(0, CFG.PORTAL_FOX_GRACE_MS + CFG.PORTAL_FOX_INTERVAL_MS - this.hazards.elapsed);
      danger = wake ? `Fox wakes in ${(wake / 1000).toFixed(1)}s` : 'The fox can follow you through portals. Keep moving.';
    }
    return [gate, danger].filter(Boolean).join('  /  ');
  }
}

// ============================================================ app state
const app = { level: null, index: 0, modal: null, last: 0, uiCache: {} };
const ctx = el.board.getContext('2d');

function layoutBoard() {
  const level = app.level;
  if (!level || el.game.classList.contains('hidden')) return;
  const r = el.stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const availW = r.width - 18, availH = r.height - 18;
  if (availW < 40 || availH < 40) return;
  const cssTile = Math.floor(Math.min(availW / level.w, availH / level.h));
  const T = Math.max(8, Math.floor(cssTile * dpr));
  if (T === level.T && el.board.width === level.w * T) return;
  el.board.width = level.w * T; el.board.height = level.h * T;
  el.board.style.width = `${(level.w * T) / dpr}px`; el.board.style.height = `${(level.h * T) / dpr}px`;
  ctx.imageSmoothingQuality = 'high';
  level.layout(T);
}

function setText(node, key, value) {
  if (app.uiCache[key] !== value) { app.uiCache[key] = value; node.textContent = value; }
}

function updateHud() {
  const l = app.level;
  setText(el.hudLevel, 'lvl', `${String(l.index + 1).padStart(2, '0')} / ${String(LEVELS.length).padStart(2, '0')}`);
  setText(el.hudTitle, 'title', l.title);
  setText(el.hudCarrots, 'carrots', `Carrots  ${l.initialCoins - l.coins} / ${l.initialCoins}`);
  const hint = l.coins === 0 ? 'All carrots collected! Head to the burrow.' : l.hint;
  const hk = `${l.title}|${hint}`;
  if (app.uiCache.hint !== hk) { app.uiCache.hint = hk; el.hint.innerHTML = ''; const b = document.createElement('b'); b.textContent = l.title; el.hint.append(b, ` · ${hint}`); }
  setText(el.status, 'status', l.statusText());
}

function updateCamUI() {
  const st = tracker.snapshot();
  const drawn = tracker.active ? tracker.drawPreview(el.cam).drawn : false;
  el.camCard.classList.toggle('live', drawn);
  let label, go = false, msg, btn;
  if (tracker.active && st.status === 'Camera active') {
    label = st.direction ? st.direction.toUpperCase() : st.gesture; go = !!st.direction; btn = 'Turn off hand control'; msg = '';
  } else if (tracker.active) {
    label = 'Starting camera…'; btn = 'Cancel'; msg = 'Allow camera access if asked. Loading hand tracking…';
  } else if (st.status && st.status !== 'off') {
    label = 'Keyboard ready'; btn = 'Try hand control again'; msg = `${st.status}.\nKeyboard and touch still work.`;
  } else {
    label = 'Camera off'; btn = 'Turn on hand control'; msg = 'Point with one finger to move.\nVideo stays on your device.';
  }
  setText(el.camLabel, 'camLabel', label);
  el.camStatus.classList.toggle('go', go);
  setText(el.btnCam, 'camBtn', btn);
  if (app.uiCache.camMsg !== msg) {
    app.uiCache.camMsg = msg; el.camMsg.innerHTML = '';
    msg.split('\n').forEach((line, i) => { if (i) el.camMsg.append(document.createElement('br')); el.camMsg.append(line); });
  }
}

// ============================================================ input
const KEY_DIR = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
const held = [];
const padHeld = new Map(); // pointerId -> direction (on-screen pad)
let stickDir = null;       // swipe direction on the board

function currentDirection(now) {
  if (held.length) return KEY_DIR[held[held.length - 1]];
  if (padHeld.size) return [...padHeld.values()].pop();
  if (stickDir) return stickDir;
  if (tracker.active) return tracker.snapshot(now).direction;
  return null;
}
function clearInput() { held.length = 0; padHeld.clear(); stickDir = null; document.querySelectorAll('#dpad .down').forEach((b) => b.classList.remove('down')); }

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  sound.unlock();
  const code = e.code;
  if (app.modal) {
    if (code === 'Enter' || code === 'Space' || code === 'KeyR' || (app.modal === 'pause' && (code === 'KeyP' || code === 'Escape'))) {
      e.preventDefault(); $('#modal-primary').click();
    } else if (code === 'KeyM' || code === 'Escape') { e.preventDefault(); $('#modal-secondary').click(); }
    return;
  }
  if (!el.help.classList.contains('hidden')) {
    if (code === 'Escape' || code === 'KeyH') { e.preventDefault(); el.help.classList.add('hidden'); }
    else if (code === 'Enter' || code === 'Space') { e.preventDefault(); el.help.classList.add('hidden'); begin(false); }
    return;
  }
  if (!app.level) { // title screen
    if (code === 'Enter' || code === 'Space') { e.preventDefault(); begin(false); }
    else if (code === 'KeyH') el.help.classList.remove('hidden');
    else if (code === 'KeyF') toggleFullscreen();
    return;
  }
  if (code in KEY_DIR) { e.preventDefault(); if (!held.includes(code)) held.push(code); return; }
  if (e.repeat) return;
  if (code === 'KeyP' || code === 'Escape') showModal('pause');
  else if (code === 'KeyR') startLevel(app.index);
  else if (code === 'KeyM') toggleMute();
  else if (code === 'KeyF') toggleFullscreen();
});
window.addEventListener('keyup', (e) => { const i = held.indexOf(e.code); if (i >= 0) held.splice(i, 1); });
window.addEventListener('blur', clearInput);
document.addEventListener('visibilitychange', () => {
  clearInput();
  if (document.hidden && app.level && !app.modal) showModal('pause');
});
window.addEventListener('pointerdown', (e) => {
  sound.unlock();
  if (e.pointerType === 'touch') document.body.classList.add('touch');
}, { passive: true });

// On-screen pad
document.querySelectorAll('#dpad button').forEach((b) => {
  const dir = b.dataset.dir;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault(); sound.unlock();
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    padHeld.set(e.pointerId, dir); b.classList.add('down');
  });
  const release = (e) => { padHeld.delete(e.pointerId); b.classList.remove('down'); };
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('lostpointercapture', release);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});

// Swipe / drag on the board acts like a floating joystick.
{
  let anchor = null, id = null;
  const DEAD = 22, FOLLOW = 44;
  el.stage.addEventListener('pointerdown', (e) => {
    if (!app.level || app.modal) return;
    anchor = [e.clientX, e.clientY]; id = e.pointerId; stickDir = null;
    try { el.stage.setPointerCapture(id); } catch (err) { /* ignore */ }
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!anchor || e.pointerId !== id) return;
    let dx = e.clientX - anchor[0], dy = e.clientY - anchor[1];
    const len = Math.hypot(dx, dy);
    if (len < DEAD) return;
    stickDir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    if (len > FOLLOW) { anchor = [e.clientX - (dx / len) * FOLLOW, e.clientY - (dy / len) * FOLLOW]; }
  });
  const end = (e) => { if (e.pointerId === id) { anchor = null; id = null; stickDir = null; } };
  el.stage.addEventListener('pointerup', end);
  el.stage.addEventListener('pointercancel', end);
}

// ============================================================ screens & modals
function begin(withHand) {
  sound.unlock();
  el.help.classList.add('hidden');
  app.index = 0;
  startLevel(0);
  if (withHand) tracker.start();
}

function startLevel(index) {
  hideModal();
  clearInput();
  app.index = index;
  app.level = new Level(index);
  app.uiCache = {};
  el.title.classList.add('hidden');
  el.game.classList.remove('hidden');
  document.title = `Rabbit Adventure - Level ${index + 1}: ${app.level.title}`;
  el.board.width = 1; // force layout
  layoutBoard();
  requestAnimationFrame(layoutBoard); // the stage may only get its final size after display switches
  app.last = performance.now();
}

function toTitle() {
  hideModal();
  clearInput();
  tracker.stop();
  app.level = null;
  el.game.classList.add('hidden');
  el.title.classList.remove('hidden');
  document.title = 'Rabbit Adventure | The Woodland Trials';
}

const MODALS = {
  pause: { kicker: 'TAKE A BREATHER', title: 'A moment in the woods.', copy: 'Your adventure is waiting. Take your time, then follow the trail.', primary: 'Resume adventure', action: 'resume' },
  lost: { kicker: 'THE FOREST HAS ANOTHER CHANCE', title: 'Every trail takes practice.', copy: 'The forest caught you this time. Try a new route, watch the hazards, and keep your harvest safe.', primary: 'Try again', action: 'restart' },
  next: { kicker: 'TRIAL COMPLETE', title: 'A little closer to home.', copy: '', primary: 'Next trial  ›', action: 'next' },
  complete: { kicker: 'THE WOODLAND IS CELEBRATING', title: 'Home, sweet home.', copy: 'Six trails. One brave little rabbit. The harvest is safe, the basket is full, and a cozy burrow is waiting for you.', primary: 'Play again', action: 'again' },
};
let modalAction = null;

function statsLine(l) {
  return `${l.initialCoins - l.coins} / ${l.initialCoins} carrots   /   ${l.moves} steps   /   ${(l.elapsed / 1000).toFixed(1)}s`;
}

function showModal(kind) {
  const m = MODALS[kind], l = app.level;
  app.modal = kind; modalAction = m.action;
  clearInput();
  $('#modal-kicker').textContent = m.kicker;
  $('#modal-title').textContent = m.title;
  $('#modal-copy').textContent = kind === 'next'
    ? `${l.title} complete. Your harvest is safe. A new corner of the forest awaits.` : m.copy;
  $('#modal-stats').textContent = kind === 'pause' ? '' : (kind === 'complete' ? `ALL SIX TRIALS COMPLETE   /   ${statsLine(l)}` : statsLine(l));
  $('#modal-primary').textContent = m.primary;
  el.modal.classList.toggle('complete', kind === 'complete');
  el.modal.classList.remove('hidden');
  $('#modal-primary').focus({ preventScroll: true });
}
function hideModal() { app.modal = null; el.modal.classList.add('hidden'); el.modal.classList.remove('complete'); }

$('#modal-primary').addEventListener('click', () => {
  const action = modalAction;
  if (action === 'resume') {
    hideModal(); clearInput();
    app.level.repeater = new MoveRepeater(CFG.MOVE_INTERVAL_MS);
    app.last = performance.now();
  } else if (action === 'restart') startLevel(app.index);
  else if (action === 'next') startLevel(app.index + 1);
  else if (action === 'again') startLevel(0);
});
$('#modal-secondary').addEventListener('click', toTitle);

$('#btn-play').addEventListener('click', () => begin(false));
$('#btn-play-hand').addEventListener('click', () => begin(true));
$('#btn-help').addEventListener('click', () => el.help.classList.remove('hidden'));
$('#btn-help-start').addEventListener('click', () => begin(false));
$('#btn-help-close').addEventListener('click', () => el.help.classList.add('hidden'));
$('#btn-pause').addEventListener('click', () => { if (app.level && !app.modal) showModal('pause'); });
$('#btn-retry').addEventListener('click', () => { if (app.level) startLevel(app.index); });
el.mute.addEventListener('click', toggleMute);
el.btnCam.addEventListener('click', () => { sound.unlock(); if (tracker.active) tracker.stop(); else tracker.start(); });

function toggleMute() { sound.muted = !sound.muted; el.mute.classList.toggle('off', sound.muted); }
const fsRoot = document.documentElement;
const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
if (!canFullscreen) el.full.style.display = 'none';
function toggleFullscreen() {
  if (!canFullscreen) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fsEl) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen).call(fsRoot);
  } catch (err) { /* ignore */ }
}
el.full.addEventListener('click', toggleFullscreen);

// ============================================================ main loop
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(100, Math.max(0, t - app.last));
  app.last = t;
  const level = app.level;
  if (level) {
    if (!level.T) layoutBoard();
    if (level.T) {
      const live = !app.modal;
      if (live) level.update(dt, t, currentDirection(t));
      level.draw(ctx, t, live ? dt : 0);
      updateHud();
      if (live) {
        if (level.gameOver) { sound.play('lost'); showModal('lost'); }
        else if (level.finished) {
          const final = level.index + 1 === LEVELS.length;
          sound.play('win'); showModal(final ? 'complete' : 'next');
        }
      }
    }
    updateCamUI();
  }
}

// ============================================================ boot
function makePetals() {
  const box = $('.petals'), tints = ['#e8ba5a', '#f3d997', '#acc071'];
  for (let i = 0; i < 32; i++) {
    const p = document.createElement('i');
    p.style.left = `${(i * 137) % 100}%`; p.style.background = tints[i % 3];
    p.style.animationDuration = `${9 + (i % 5) * 2.2}s`; p.style.animationDelay = `-${(i * 1.7) % 12}s`;
    p.style.setProperty('--dx', `${(i % 2 ? 1 : -1) * (20 + (i % 7) * 9)}px`);
    box.append(p);
  }
}

async function boot() {
  if (matchMedia('(any-pointer: coarse)').matches || navigator.maxTouchPoints > 0) document.body.classList.add('touch');
  for (const [i, level] of LEVELS.entries()) {
    const [ok, msg] = validateMap(level);
    if (!ok) throw new Error(`Level ${i + 1}: ${msg}`);
  }
  [atlasImg, groundImg] = await Promise.all([loadImage('assets/tiles.webp'), loadImage('assets/ground.webp')]);
  loadImage('assets/title.webp').catch(() => {});
  puzzleTiles = createPuzzleTiles();
  makePetals();
  new ResizeObserver(() => requestAnimationFrame(layoutBoard)).observe(el.stage);
  window.addEventListener('orientationchange', () => setTimeout(layoutBoard, 250));
  requestAnimationFrame((t) => { app.last = t; frame(t); });
  el.loading.classList.add('done');
  setTimeout(() => el.loading.remove(), 400);
}

boot().catch((err) => {
  console.error(err);
  el.loading.querySelector('p').textContent = `Could not start the game: ${err.message}`;
  el.loading.querySelector('.spinner').remove();
});

// Handy for automated tests / debugging in the console.
window.rabbit = { app, tracker, sound, startLevel, showModal, hazardPhase, get level() { return app.level; } };
