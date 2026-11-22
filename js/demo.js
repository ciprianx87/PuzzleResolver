// Synthetic demo: generates a box photo, a partially built puzzle and a photo of loose pieces.

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/** A colourful procedural picture with plenty of local variation. */
function drawPicture(w, h, R) {
  const c = makeCanvas(w, h), ctx = c.getContext('2d');
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.6);
  sky.addColorStop(0, '#1e3c72'); sky.addColorStop(0.6, '#e96443'); sky.addColorStop(1, '#ffd26f');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
  // sun
  const sun = ctx.createRadialGradient(w * 0.72, h * 0.35, 5, w * 0.72, h * 0.35, h * 0.2);
  sun.addColorStop(0, '#fff7c2'); sun.addColorStop(1, 'rgba(255,200,80,0)');
  ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(w * 0.72, h * 0.35, h * 0.2, 0, 7); ctx.fill();
  // clouds
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + R() * 0.4})`;
    const x = R() * w, y = R() * h * 0.35;
    for (let k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(x + k * 18, y + R() * 8, 26, 12, 0, 0, 7); ctx.fill(); }
  }
  // mountains
  const mcol = ['#4b3869', '#6a4c93', '#2d4059'];
  mcol.forEach((col, m) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += w / 12) ctx.lineTo(x, h * (0.42 + m * 0.07) + Math.sin(x * 0.02 + m * 2) * 30 + R() * 25);
    ctx.lineTo(w, h); ctx.fill();
  });
  // lake
  const lake = ctx.createLinearGradient(0, h * 0.62, 0, h);
  lake.addColorStop(0, '#3a7bd5'); lake.addColorStop(1, '#00d2ff');
  ctx.fillStyle = lake; ctx.fillRect(0, h * 0.64, w * 0.55, h * 0.36);
  // meadow
  ctx.fillStyle = '#4caf50'; ctx.beginPath(); ctx.moveTo(w * 0.5, h); ctx.quadraticCurveTo(w * 0.55, h * 0.62, w, h * 0.6); ctx.lineTo(w, h); ctx.fill();
  // houses
  const roofs = ['#d7263d', '#f46036', '#2e294e', '#1b998b', '#c5d86d', '#ff6f91'];
  for (let i = 0; i < 7; i++) {
    const x = w * 0.56 + i * w * 0.06, y = h * 0.66 + (i % 3) * h * 0.08, s = 26 + R() * 14;
    ctx.fillStyle = ['#f6f5ae', '#ffffff', '#ffd6a5', '#caffbf'][i % 4]; ctx.fillRect(x, y, s, s * 0.8);
    ctx.fillStyle = roofs[i % roofs.length]; ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + s / 2, y - s * 0.6); ctx.lineTo(x + s + 5, y); ctx.fill();
    ctx.fillStyle = '#3d2c8d'; ctx.fillRect(x + s * 0.4, y + s * 0.35, s * 0.22, s * 0.45);
  }
  // trees
  for (let i = 0; i < 14; i++) {
    const x = w * 0.5 + R() * w * 0.5, y = h * 0.82 + R() * h * 0.15;
    ctx.fillStyle = '#5d4037'; ctx.fillRect(x - 3, y, 6, 16);
    ctx.fillStyle = ['#1b5e20', '#2e7d32', '#388e3c', '#9ccc65'][i % 4];
    ctx.beginPath(); ctx.moveTo(x - 14, y + 4); ctx.lineTo(x, y - 30); ctx.lineTo(x + 14, y + 4); ctx.fill();
  }
  // balloons
  for (let i = 0; i < 6; i++) {
    const x = R() * w * 0.6 + w * 0.05, y = h * 0.1 + R() * h * 0.35;
    ctx.fillStyle = roofs[(i + 2) % roofs.length];
    ctx.beginPath(); ctx.ellipse(x, y, 16, 20, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 13, y - 3, 26, 5);
    ctx.strokeStyle = '#333'; ctx.beginPath(); ctx.moveTo(x, y + 20); ctx.lineTo(x, y + 34); ctx.stroke();
    ctx.fillStyle = '#795548'; ctx.fillRect(x - 5, y + 32, 10, 7);
  }
  // boats
  for (let i = 0; i < 4; i++) {
    const x = w * 0.05 + R() * w * 0.4, y = h * 0.72 + R() * h * 0.22;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 30, y); ctx.lineTo(x + 24, y + 8); ctx.lineTo(x + 6, y + 8); ctx.fill();
    ctx.fillStyle = roofs[i]; ctx.beginPath(); ctx.moveTo(x + 15, y - 2); ctx.lineTo(x + 15, y - 28); ctx.lineTo(x + 30, y - 4); ctx.fill();
  }
  return c;
}

// --- jigsaw shapes ---------------------------------------------------------
function bez(p0, p1, p2, p3, n, out) {
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y });
  }
}

/** Points of an edge from A to B with a tab of signed amplitude `amp` (absolute +y / +x direction), centre at `t`. */
function edgePts(A, B, amp, t = 0.5) {
  const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const nx = horizontal ? 0 : 1, ny = horizontal ? 1 : 0; // absolute normal
  const P = (s, o) => ({ x: A.x + dx * s + nx * o * L, y: A.y + dy * s + ny * o * L });
  const pts = [{ ...A }];
  if (!amp) { pts.push({ ...B }); return pts; }
  const h = amp;
  pts.push(P(t - 0.13, 0));
  bez(P(t - 0.13, 0), P(t - 0.08, 0), P(t - 0.2, h), P(t, h), 10, pts);
  bez(P(t, h), P(t + 0.2, h), P(t + 0.08, 0), P(t + 0.13, 0), 10, pts);
  pts.push({ ...B });
  return pts;
}

function buildShapes(cols, rows, S, R) {
  const hT = [], vT = [], hPos = [], vPos = [];
  for (let r = 0; r <= rows; r++) { hT.push([]); hPos.push([]); for (let c = 0; c < cols; c++) { hT[r].push(r === 0 || r === rows ? 0 : (R() < 0.5 ? 1 : -1) * 0.24); hPos[r].push(0.5 + (R() - 0.5) * 0.1); } }
  for (let r = 0; r < rows; r++) { vT.push([]); vPos.push([]); for (let c = 0; c <= cols; c++) { vT[r].push(c === 0 || c === cols ? 0 : (R() < 0.5 ? 1 : -1) * 0.24); vPos[r].push(0.5 + (R() - 0.5) * 0.1); } }
  const shapes = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const TL = { x: c * S, y: r * S }, TR = { x: (c + 1) * S, y: r * S }, BR = { x: (c + 1) * S, y: (r + 1) * S }, BL = { x: c * S, y: (r + 1) * S };
    const top = edgePts(TL, TR, hT[r][c], hPos[r][c]);
    const right = edgePts(TR, BR, vT[r][c + 1], vPos[r][c + 1]);
    const bottom = edgePts(BL, BR, hT[r + 1][c], hPos[r + 1][c]).reverse();
    const left = edgePts(TL, BL, vT[r][c], vPos[r][c]).reverse();
    shapes.push([...top, ...right.slice(1), ...bottom.slice(1), ...left.slice(1)]);
  }
  return shapes;
}

function pathOf(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function addNoise(canvas, R, amount, tint = [1, 1, 1]) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] * tint[0] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * tint[1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * tint[2] + n));
  }
  ctx.putImageData(id, 0, 0);
}

function texture(ctx, w, h, base, streak, R, vertical = false) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) {
    ctx.strokeStyle = streak.replace('A', (0.03 + R() * 0.08).toFixed(3));
    ctx.lineWidth = 1 + R() * 3;
    ctx.beginPath();
    if (vertical) { const x = R() * w; ctx.moveTo(x, 0); ctx.bezierCurveTo(x + 10, h * 0.3, x - 10, h * 0.6, x + 4, h); }
    else { const y = R() * h; ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.3, y + 8, w * 0.6, y - 8, w, y + 3); }
    ctx.stroke();
  }
}

const tp = (m, x, y) => { const p = m.transformPoint(new DOMPoint(x, y)); return { x: p.x, y: p.y }; };

export function generateDemo(seed = 7) {
  const R = rng(seed);
  const cols = 8, rows = 6, S = 70, PW = cols * S, PH = rows * S;
  const pic = drawPicture(PW, PH, R);
  const shapes = buildShapes(cols, rows, S, R);

  // 1. box photo: picture printed on a box lid, slightly rotated, on a dark table
  const box = makeCanvas(900, 720), bctx = box.getContext('2d');
  texture(bctx, 900, 720, '#3b2f2a', 'rgba(0,0,0,A)', R);
  const mBox = new DOMMatrix().translate(450, 360).rotate(-3).scale(1.32).translate(-PW / 2, -PH / 2);
  bctx.setTransform(mBox);
  bctx.fillStyle = '#f2efe6'; bctx.fillRect(-26, -26, PW + 52, PH + 70);
  bctx.fillStyle = '#222'; bctx.font = 'bold 22px serif'; bctx.fillText('SUNSET VALLEY · 48', 0, PH + 32);
  bctx.drawImage(pic, 0, 0);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  addNoise(box, R, 10, [1.04, 1.0, 0.95]);
  const boxQuad = [tp(mBox, 0, 0), tp(mBox, PW, 0), tp(mBox, PW, PH), tp(mBox, 0, PH)];

  // 2. built puzzle: border + top rows done, on a wooden table
  const filled = new Set();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (r === 0 || r === rows - 1 || c === 0 || c === cols - 1 || r === 1 || (r === 2 && c < 4)) filled.add(r * cols + c);
  }
  const built = makeCanvas(1000, 800), uctx = built.getContext('2d');
  texture(uctx, 1000, 800, '#a9764b', 'rgba(60,30,10,A)', R);
  const mBuilt = new DOMMatrix().translate(500, 400).rotate(2).scale(1.45).translate(-PW / 2, -PH / 2);
  for (const idx of filled) {
    uctx.save(); uctx.setTransform(mBuilt);
    pathOf(uctx, shapes[idx]); uctx.clip(); uctx.drawImage(pic, 0, 0);
    uctx.restore();
    uctx.save(); uctx.setTransform(mBuilt); pathOf(uctx, shapes[idx]);
    uctx.strokeStyle = 'rgba(0,0,0,0.35)'; uctx.lineWidth = 0.7; uctx.stroke(); uctx.restore();
  }
  addNoise(built, R, 12, [1.06, 1.0, 0.92]);
  const builtQuad = [tp(mBuilt, 0, 0), tp(mBuilt, PW, 0), tp(mBuilt, PW, PH), tp(mBuilt, 0, PH)];

  // 3. loose pieces scattered on a green cloth, random rotation
  const loose = [];
  for (let i = 0; i < cols * rows; i++) if (!filled.has(i)) loose.push(i);
  // add a few distractor-free shuffles
  for (let i = loose.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [loose[i], loose[j]] = [loose[j], loose[i]]; }
  const pieces = makeCanvas(1100, 820), pctx = pieces.getContext('2d');
  const g = pctx.createLinearGradient(0, 0, 1100, 820);
  g.addColorStop(0, '#2f6b3a'); g.addColorStop(1, '#245a30');
  pctx.fillStyle = g; pctx.fillRect(0, 0, 1100, 820);
  const gc = 5, gr = Math.ceil(loose.length / gc);
  const truth = [];
  loose.forEach((idx, k) => {
    const c = idx % cols, r = (idx / cols) | 0;
    const gx = k % gc, gy = (k / gc) | 0;
    const x = 130 + gx * 210 + (R() - 0.5) * 40, y = 140 + gy * (560 / Math.max(1, gr - 1)) + (R() - 0.5) * 30;
    const rotDeg = R() * 360;
    truth.push({ cell: idx, x, y, rot: rotDeg });
    const m = new DOMMatrix().translate(x, y).rotate(rotDeg).scale(1.7).translate(-(c + 0.5) * S, -(r + 0.5) * S);
    pctx.save(); pctx.setTransform(m);
    pctx.shadowColor = 'rgba(0,0,0,0.35)'; pctx.shadowBlur = 4;
    pathOf(pctx, shapes[idx]); pctx.fillStyle = '#ddd'; pctx.fill();
    pctx.shadowColor = 'transparent';
    pathOf(pctx, shapes[idx]); pctx.clip(); pctx.drawImage(pic, 0, 0);
    pctx.restore();
  });
  addNoise(pieces, R, 12, [0.97, 1.0, 1.05]);

  return { box, boxQuad, built, builtQuad, pieces, cols, rows, count: cols * rows, truth, filled };
}
