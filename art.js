// Image loading plus the procedurally drawn puzzle tiles (ported from puzzle_art.py).

const R = 192; // supersampled resolution of the procedural tiles

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load ' + src));
    img.src = src;
  });
}

const css = (c) => (c.length === 4 ? `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})` : `rgb(${c[0]},${c[1]},${c[2]})`);

function blank() {
  const c = document.createElement('canvas');
  c.width = c.height = R;
  return c;
}

// --- small pygame.draw-like helpers (width 0 = filled; outlines are drawn inside the shape)
function rrPath(g, x, y, w, h, r) {
  r = Math.min(r || 0, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function rect(g, color, [x, y, w, h], width = 0, radius = 0) {
  if (width) {
    rrPath(g, x + width / 2, y + width / 2, w - width, h - width, Math.max(0, radius - width / 2));
    g.strokeStyle = css(color); g.lineWidth = width; g.stroke();
  } else {
    rrPath(g, x, y, w, h, radius);
    g.fillStyle = css(color); g.fill();
  }
}
function circle(g, color, [cx, cy], r, width = 0) {
  g.beginPath();
  if (width) { g.arc(cx, cy, Math.max(0, r - width / 2), 0, Math.PI * 2); g.strokeStyle = css(color); g.lineWidth = width; g.stroke(); }
  else { g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = css(color); g.fill(); }
}
function ellipse(g, color, [x, y, w, h], width = 0) {
  g.beginPath();
  if (width) {
    g.ellipse(x + w / 2, y + h / 2, Math.max(0, w / 2 - width / 2), Math.max(0, h / 2 - width / 2), 0, 0, Math.PI * 2);
    g.strokeStyle = css(color); g.lineWidth = width; g.stroke();
  } else {
    g.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    g.fillStyle = css(color); g.fill();
  }
}
function line(g, color, a, b, width = 1) { lines(g, color, false, [a, b], width); }
function lines(g, color, closed, pts, width = 1) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  if (closed) g.closePath();
  g.strokeStyle = css(color); g.lineWidth = width; g.lineJoin = 'round'; g.lineCap = 'butt'; g.stroke();
}
function polygon(g, color, pts) {
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
  g.closePath(); g.fillStyle = css(color); g.fill();
}
export const helpers = { rect, circle, ellipse, line, lines, polygon };

const TAU = Math.PI * 2;

/** Build every procedural tile at 192x192. Returns {key: canvas}. */
export function createPuzzleTiles() {
  const tiles = {};
  const gold = [221, 176, 89], silver = [143, 192, 202];
  const stone = [79, 96, 79], edge = [43, 62, 52], light = [157, 170, 137];

  const disc = (g, c, r, tint) => {
    circle(g, [21, 37, 29, 85], [c[0] + 2, c[1] + 8], r + 3);
    circle(g, edge, c, r);
    circle(g, tint, c, r - 5);
    circle(g, light, c, r - 5, 2);
  };
  const emblem = (g, c, moon = false, tint = gold, radius = 13) => {
    const [x, y] = c;
    circle(g, tint, c, radius);
    if (moon) circle(g, stone, [x + Math.trunc(radius / 2), y - Math.trunc(radius / 3)], radius - 1);
    else for (let i = 0; i < 8; i++) {
      const a = i * TAU / 8;
      line(g, tint, [x + Math.cos(a) * (radius + 5), y + Math.sin(a) * (radius + 5)],
        [x + Math.cos(a) * (radius + 10), y + Math.sin(a) * (radius + 10)], 3);
    }
  };

  // Switch (off / on)
  for (const on of [false, true]) {
    const c = blank(), g = c.getContext('2d');
    disc(g, [96, 103], 68, stone);
    circle(g, gold, [96, 103], 53, 3);
    for (const angle of [45, 135, 225, 315]) {
      const a = angle * Math.PI / 180;
      const p = [Math.round(96 + 58 * Math.cos(a)), Math.round(103 + 58 * Math.sin(a))];
      circle(g, [187, 180, 135], p, 5);
      line(g, edge, [p[0] - 2, p[1]], [p[0] + 2, p[1]], 2);
    }
    rect(g, edge, [77, 72, 38, 65], 0, 17);
    rect(g, [118, 133, 109], [83, 77, 26, 53], 0, 12);
    const end = on ? [112, 72] : [80, 123];
    line(g, [29, 43, 34], [96, 105], end, 15);
    line(g, [206, 195, 145], [94, 101], [end[0] - 2, end[1] - 3], 7);
    circle(g, on ? silver : gold, end, 15);
    circle(g, [246, 228, 171], [end[0] - 4, end[1] - 5], 4);
    emblem(g, [50, 101], false, gold, 7);
    emblem(g, [143, 101], true, silver, 9);
    tiles[on ? 'S_on' : 'S'] = c;
  }

  // Gates (sun / moon, closed / open)
  for (const [k, tint] of [['G', gold], ['H', silver]]) {
    for (const opened of [false, true]) {
      const c = blank(), g = c.getContext('2d');
      ellipse(g, [26, 42, 30, 85], [15, 144, 164, 25]);
      for (const x of [23, 147]) {
        rect(g, edge, [x, 34, 25, 124], 0, 8);
        rect(g, stone, [x + 4, 38, 17, 114], 0, 5);
        rect(g, light, [x + 3, 28, 20, 12], 0, 3);
        circle(g, tint, [x + 12, 53], 6);
      }
      if (!opened) {
        for (const x of [50, 77, 104, 131]) {
          rect(g, [65, 70, 49], [x, 52, 15, 91], 0, 4);
          line(g, [142, 130, 83], [x + 3, 56], [x + 3, 138], 3);
        }
        for (const y of [66, 126]) {
          rect(g, [72, 88, 72], [40, y, 112, 12], 0, 3);
          line(g, tint, [44, y + 2], [147, y + 2], 2);
        }
        disc(g, [96, 99], 26, stone);
        emblem(g, [96, 99], k === 'H', tint, 10);
      } else {
        for (const x of [46, 136]) rect(g, [100, 110, 78], [x, 61, 10, 82], 0, 3);
        ellipse(g, [...tint, 95], [49, 148, 94, 10]);
      }
      tiles[k + (opened ? '_open' : '')] = c;
    }
  }

  // Portals: 16 animation frames for each pair
  for (const [pair, tint, number] of [['AB', [175, 144, 227], '1'], ['UV', [103, 209, 194], '2']]) {
    for (let frame = 0; frame < 16; frame++) {
      const c = blank(), g = c.getContext('2d');
      const phase = frame * TAU / 16;
      ellipse(g, [20, 38, 30, 65], [12, 132, 168, 35]);
      for (let pad = 16; pad > 1; pad -= 3) {
        ellipse(g, [...tint, 5 + pad], [27 - pad, 36 - Math.trunc(pad / 2), 138 + 2 * pad, 110 + pad], 8);
      }
      ellipse(g, edge, [22, 34, 148, 118]);
      ellipse(g, [109, 126, 111], [27, 37, 138, 108], 10);
      ellipse(g, [31, 53, 64], [37, 46, 118, 90]);
      for (let inset = 0; inset < 3; inset++) {
        const pts = [];
        for (let step = 0; step < 64; step++) {
          const a = step * TAU / 63;
          const wave = 1 + 0.04 * Math.sin(a * 3 + phase);
          pts.push([96 + Math.cos(a) * (55 - inset * 9) * wave, 91 + Math.sin(a) * (39 - inset * 6) * wave]);
        }
        lines(g, [...tint, 220 - inset * 55], true, pts, 5 - inset);
      }
      const spiral = [];
      for (let step = 0; step < 92; step++) {
        const a = phase + step * 0.13, r = 3 + step * 0.42;
        spiral.push([96 + Math.cos(a) * r, 91 + Math.sin(a) * r * 0.64]);
      }
      lines(g, [...tint, 95], false, spiral, 8);
      lines(g, [...tint, 195], false, spiral, 3);
      for (let i = 0; i < 8; i++) {
        const a = i * TAU / 8, cx = 96 + Math.cos(a) * 66, cy = 92 + Math.sin(a) * 50;
        polygon(g, tint, [[cx, cy - 4], [cx + 3, cy], [cx, cy + 4], [cx - 3, cy]]);
      }
      for (let i = 0; i < 3; i++) {
        const a = phase + i * TAU / 3;
        circle(g, [235, 245, 231], [Math.round(96 + Math.cos(a) * 43), Math.round(91 + Math.sin(a) * 29)], 4);
      }
      disc(g, [96, 150], 20, stone);
      g.font = 'bold 28px "DejaVu Sans", system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = css([241, 231, 195]);
      g.fillText(number, 96, 151);
      for (const k of pair) {
        tiles[`${k}_${frame}`] = c;
        if (frame === 0) tiles[k] = c;
      }
    }
  }

  // Stone lightning path
  {
    const c = blank(), g = c.getContext('2d');
    rect(g, [55, 75, 61, 100], [0, 20, 192, 158], 0, 14);
    rect(g, [114, 130, 107], [0, 15, 192, 151], 0, 14);
    line(g, [161, 170, 136], [0, 18], [192, 18], 3);
    line(g, [68, 89, 74], [0, 162], [192, 162], 4);
    for (const x of [13, 179]) for (const y of [32, 149]) circle(g, [181, 174, 131], [x, y], 4);
    lines(g, [83, 102, 86], false, [[110, 55], [87, 95], [107, 95], [82, 132]], 5);
    tiles.T = c;
  }
  return tiles;
}
