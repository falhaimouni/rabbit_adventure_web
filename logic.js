// Pure game rules ported 1:1 from the Python version (config.py, level_mechanics.py,
// hazards.py, map_validator.py). No DOM or canvas here, so it is easy to test.

const S = 2.8; // GAMEPLAY_TIME_SCALE: gives hand gestures time to settle.
export const CFG = {
  TARGET_FPS: 60,
  MOVE_INTERVAL_MS: Math.round(150 * S * 6 / 7),
  LOG_INTERVAL_MS: Math.round(500 * S),
  FOX_INTERVAL_MS: Math.round(400 * S),
  PORTAL_FOX_INTERVAL_MS: Math.round(540 * S),
  PORTAL_FOX_GRACE_MS: Math.round(1200 * S),
  LIGHTNING_SAFE_MS: Math.round(2700 * S),
  LIGHTNING_ACTIVE_MS: Math.round(600 * S),
  TIDE_ACTIVE_MS: Math.round(900 * S),
  TIDE_PERIOD_MS: 8000,
  PLANK_LIFETIME_MS: Math.round(900 * S),
  TRACKING_STALE_MS: 250,
  GESTURE_SMOOTHING_MS: 45,
  GESTURE_SETTLE_MS: 30,
  GESTURE_AXIS_HYSTERESIS: 1.25,
};
CFG.ANIMATION_MS = CFG.MOVE_INTERVAL_MS;
CFG.TIDE_SAFE_MS = CFG.TIDE_PERIOD_MS - CFG.TIDE_ACTIVE_MS;

export const LEVEL_GUIDES = [
  ['Carrot Trail', 'Collect the carrots, then find the burrow.'],
  ['River Ride', 'Cross the river on the moving logs.'],
  ['Fox Forest', 'Collect the carrots. Stay ahead of the fox.'],
  ['Storm Switchyard', 'Step on switches to swap gates. Avoid lightning.'],
  ['Portal Hunt', 'Matching portals connect the gardens. The fox can follow.'],
  ['Sinking Causeway', 'Cross the planks quickly. Watch for waves.'],
];

export const DIRECTIONS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// ---------------------------------------------------------------- map validation
export function validateMap(map) {
  if (!map.length) return [false, 'empty map'];
  const w = map[0].length;
  if (map.some((r) => r.length !== w)) return [false, 'Map must be rectangular'];
  const valid = new Set('10EPCWLFRSGHABUVXT');
  let coins = 0, players = 0, exits = 0;
  for (const row of map) for (const c of row) {
    if (!valid.has(c)) return [false, `Invalid character '${c}'`];
    if (c === 'C') coins++; else if (c === 'P') players++; else if (c === 'E') exits++;
  }
  if (players !== 1) return [false, 'Map must contain exactly one start (P)'];
  if (exits !== 1) return [false, 'Map must contain exactly one exit (E)'];
  if (coins < 1) return [false, 'Map must contain at least one carrot (C)'];
  const count = (ch) => map.reduce((n, r) => n + [...r].filter((x) => x === ch).length, 0);
  for (const [a, b] of [['A', 'B'], ['U', 'V']]) {
    const ca = count(a), cb = count(b);
    if (!((ca === 0 && cb === 0) || (ca === 1 && cb === 1))) return [false, `Portals ${a}/${b} need one endpoint each`];
  }
  if (map.some((r) => /[GH]/.test(r)) && !map.some((r) => r.includes('S'))) return [false, 'Gate puzzles require a switch (S)'];
  for (let x = 0; x < w; x++) if (map[0][x] !== '1' || map[map.length - 1][x] !== '1') return [false, 'Map must be surrounded by walls'];
  for (const r of map) if (r[0] !== '1' || r[w - 1] !== '1') return [false, 'Map must be surrounded by walls'];
  return [true, 'ok'];
}

// ---------------------------------------------------------------- puzzle mechanics
const key = (x, y) => y * 1000 + x;
export { key };

export class LevelMechanics {
  constructor(grid) {
    this.grid = grid;
    this.portals = new Map(); // key -> [x, y]
    this.fragile = new Map(); // key -> bit
    this.gates = [];
    const endpoints = {};
    let fragileCount = 0;
    grid.forEach((row, y) => row.forEach((ch, x) => {
      if ('ABUV'.includes(ch)) endpoints[ch] = [x, y];
      else if (ch === 'X') this.fragile.set(key(x, y), 1 << fragileCount++);
      else if (ch === 'G' || ch === 'H') this.gates.push([x, y]);
    }));
    for (const [a, b] of [['A', 'B'], ['U', 'V']]) {
      if (endpoints[a] && endpoints[b]) {
        this.portals.set(key(...endpoints[a]), endpoints[b]);
        this.portals.set(key(...endpoints[b]), endpoints[a]);
      }
    }
  }

  fragileBit(x, y) { return this.fragile.get(key(x, y)) || 0; }

  blocked(x, y, state) {
    if (y < 0 || y >= this.grid.length || x < 0 || x >= this.grid[y].length) return true;
    const ch = this.grid[y][x];
    return ch === '1' || ch === 'R' ||
      (ch === 'G' && !state.sunOpen) || (ch === 'H' && state.sunOpen) ||
      (this.fragileBit(x, y) & state.collapsed) !== 0;
  }

  /** Resolve one tile move. Arrival never immediately retriggers a portal. */
  enter(origin, dest, state) {
    const [x, y] = dest;
    const ch = this.grid[y][x];
    const collapsed = state.collapsed | this.fragileBit(origin[0], origin[1]);
    const sunOpen = ch === 'S' ? !state.sunOpen : state.sunOpen;
    const landing = this.portals.get(key(x, y)) || dest;
    return [landing, { sunOpen, collapsed }];
  }

  textureKey(x, y, state) {
    const ch = this.grid[y][x];
    if (this.fragileBit(x, y) & state.collapsed) return 'W';
    if ((ch === 'G' && state.sunOpen) || (ch === 'H' && !state.sunOpen)) return ch + '_open';
    return ch;
  }
}

/** Breadth-first shortest walkable route (including portals in the portal hunt). */
export function nextFoxPosition(grid, origin, target, mech, state, usePortals = false) {
  const queue = [[origin, null]];
  const visited = new Set([key(...origin)]);
  for (let i = 0; i < queue.length; i++) {
    const [pos, first] = queue[i];
    if (pos[0] === target[0] && pos[1] === target[1]) return first || origin;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cx = pos[0] + dx, cy = pos[1] + dy;
      if (mech.blocked(cx, cy, state)) continue;
      if ('WE'.includes(grid[cy][cx])) continue;
      const landing = usePortals ? (mech.portals.get(key(cx, cy)) || [cx, cy]) : [cx, cy];
      const k = key(...landing);
      if (!visited.has(k)) {
        visited.add(k);
        queue.push([landing, first === null ? landing : first]);
      }
    }
  }
  return origin;
}

// ---------------------------------------------------------------- hazards
const LIGHTNING_CYCLE = CFG.LIGHTNING_SAFE_MS + CFG.LIGHTNING_ACTIVE_MS;

export function phaseAt(elapsed, safe, active, offset = 0) {
  const phase = (elapsed + offset) % (safe + active);
  return phase < safe ? ['safe', safe - phase] : ['active', safe + active - phase];
}

export function hazardPhase(level, tile, y, elapsed) {
  if (level === 3 && tile === 'T') {
    return phaseAt(elapsed, CFG.LIGHTNING_SAFE_MS, CFG.LIGHTNING_ACTIVE_MS, y === 8 ? Math.floor(LIGHTNING_CYCLE / 2) : 0);
  }
  if (level === 5 && tile === 'X') return phaseAt(elapsed, CFG.TIDE_SAFE_MS, CFG.TIDE_ACTIVE_MS);
  return ['safe', 0];
}

export class HazardField {
  constructor(level, grid) {
    this.level = level; this.grid = grid;
    this.elapsed = 0; this.plankStarted = 0;
    this.tiles = [];
    grid.forEach((row, y) => row.forEach((ch, x) => {
      if ((level === 3 && ch === 'T') || (level === 5 && ch === 'X')) this.tiles.push([x, y]);
    }));
  }
  advance(dt) { this.elapsed += dt; }
  arrive() { this.plankStarted = this.elapsed; }
  deadly(x, y) {
    const row = this.grid[y];
    if (!row || row[x] === undefined) return false;
    const tile = row[x];
    const [phase] = hazardPhase(this.level, tile, y, this.elapsed);
    return phase === 'active' ||
      (this.level === 5 && tile === 'X' && this.elapsed - this.plankStarted >= CFG.PLANK_LIFETIME_MS);
  }
  status(x, y) {
    if (this.level === 3 && [5, 8].some((row) => hazardPhase(3, 'T', row, this.elapsed)[0] === 'active')) return 'Lightning';
    if (this.level === 5 && hazardPhase(5, 'X', y, this.elapsed)[0] === 'active') return 'Tidal surge';
    return '';
  }
  activeTiles(mech, state) {
    return this.tiles.filter(([x, y]) =>
      !(mech.fragileBit(x, y) & state.collapsed) &&
      hazardPhase(this.level, this.grid[y][x], y, this.elapsed)[0] === 'active');
  }
}
