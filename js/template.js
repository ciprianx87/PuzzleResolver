// Picture matching by masked template correlation.
//
// Each loose piece is cut out of its photo (core plus tabs, the cloth showing through its blanks masked out) and
// slid over the box picture around every empty cell. The score is the normalised cross-correlation per Lab channel:
// it compares the *structure* of the picture (edges, windows, girders) and ignores the overall brightness and
// contrast, which differ a lot between the box print and the pieces photographed on the table. Two small extra
// terms bring the lost information back where it is reliable: the colour (calibrated box -> table on the assembled
// cells) and the amount of contrast (a striped piece doesn't belong in a plain patch of sky).
//
// Before matching, the box picture is bent onto the puzzle: a photo of a box lid is never perfectly flat, and the
// assembled cells show by how much each part of it is shifted (up to half a cell in practice). Correcting that lets
// the search window stay small, which keeps look-alike neighbours apart.
//
// Measured on a real 1000-piece puzzle (pieces cut from the built photo with the outlines of real loose pieces):
// the right cell comes first for ~80% of the pieces among ~430 empty cells, against ~4% for 8x8 colour descriptors.

import { toLab, getImageData } from './imageutil.js';

export const TF = 1.3;                 // the template covers the core plus the tabs (in core sizes)
const G0 = 8, G1 = 16;                 // pixels per cell: coarse pass over all cells, fine pass over the best ones
const FINE_TOP = 30;                   // cells per piece re-scored in the fine pass
const SHIFT = 0.25;                    // search window around each cell (cells), after the box correction
const VAR_FLOOR = 4;                   // minimum variance per pixel (Lab^2): plain patches don't correlate by chance
const WCH = [0.5, 0.25, 0.25];         // channel weights (L, a, b)
const WLAB = [0.45, 1, 1];             // colour distance weights
export const COLOUR_W = 0.004;         // score per unit of calibrated colour distance
export const CONTRAST_W = 0.02;        // score per unit of squared contrast mismatch (in residual s.d.)
const HUB_K = 5;                       // neighbourhood for the hub correction (see templateScores)
const SUB = 3;                         // supersampling per template pixel (per axis)
const ANGLES = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2);

// ------------------------------------------------------------------ images

function resampleLab(canvas, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return { L: blur3(toLab(getImageData(c)), w, h), w, h };
}

/** Small separable blur ([1 2 1]/4) of an interleaved 3-channel image. */
function blur3(a, w, h) {
  const t = new Float32Array(a.length), o = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const l = Math.max(0, x - 1), r = Math.min(w - 1, x + 1), i = (y * w + x) * 3;
    for (let ch = 0; ch < 3; ch++) t[i + ch] = 0.25 * a[(y * w + l) * 3 + ch] + 0.5 * a[i + ch] + 0.25 * a[(y * w + r) * 3 + ch];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = Math.max(0, y - 1), d = Math.min(h - 1, y + 1), i = (y * w + x) * 3;
    for (let ch = 0; ch < 3; ch++) o[i + ch] = 0.25 * t[(u * w + x) * 3 + ch] + 0.5 * t[i + ch] + 0.25 * t[(d * w + x) * 3 + ch];
  }
  return o;
}

/** Pad an image by `pad` pixels on every side (edge replicate), so patches near the edge need no bounds checks. */
function padImage(img, pad) {
  const { L, w, h } = img, W = w + 2 * pad, H = h + 2 * pad, out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - pad));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - pad)), i = (y * W + x) * 3, j = (sy * w + sx) * 3;
      out[i] = L[j]; out[i + 1] = L[j + 1]; out[i + 2] = L[j + 2];
    }
  }
  return { L: out, w: W, h: H, pad };
}

function bilinear(L, w, h, x, y, out) {
  x = Math.min(w - 1.001, Math.max(0, x)); y = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 3, i10 = i00 + 3, i01 = i00 + w * 3, i11 = i01 + 3;
  for (let ch = 0; ch < 3; ch++) {
    out[ch] = (L[i00 + ch] * (1 - fx) + L[i10 + ch] * fx) * (1 - fy) + (L[i01 + ch] * (1 - fx) + L[i11 + ch] * fx) * fy;
  }
}

// ------------------------------------------------------------------ correlation

/**
 * Prepare a template for correlation: pixel list inside the mask, zero-mean values per channel and their norms.
 * t: Float32Array(p*p*3), m: Uint8Array(p*p) (1 = on the piece).
 */
function prepare(t, m, p, wch = WCH) {
  const idx = [];
  for (let i = 0; i < p * p; i++) if (m[i]) idx.push(i);
  const n = idx.length;
  if (n < p * p * 0.25) return null;
  const mean = [0, 0, 0];
  for (const i of idx) for (let ch = 0; ch < 3; ch++) mean[ch] += t[i * 3 + ch];
  for (let ch = 0; ch < 3; ch++) mean[ch] /= n;
  const tc = new Float32Array(n * 3), norm = [0, 0, 0];
  idx.forEach((i, k) => { for (let ch = 0; ch < 3; ch++) { const v = t[i * 3 + ch] - mean[ch]; tc[k * 3 + ch] = v; norm[ch] += v * v; } });
  return { idx: Int32Array.from(idx), tc, n, norm: norm.map((v) => Math.sqrt(Math.max(v, n * VAR_FLOOR))), p, wch };
}

/** Masked NCC (channel-weighted) of a prepared template with the padded image patch whose top-left is (x0, y0). */
function nccAt(img, tp, x0, y0) {
  const { L, w } = img, { idx, tc, n, norm, p, wch } = tp;
  let s0 = 0, s1 = 0, s2 = 0, b0 = 0, b1 = 0, b2 = 0, q0 = 0, q1 = 0, q2 = 0;
  const base = (y0 * w + x0) * 3, row = w * 3;
  for (let k = 0; k < n; k++) {
    const i = idx[k], py = (i / p) | 0, px = i - py * p;
    const j = base + py * row + px * 3, kk = k * 3;
    const v0 = L[j], v1 = L[j + 1], v2 = L[j + 2];
    s0 += tc[kk] * v0; s1 += tc[kk + 1] * v1; s2 += tc[kk + 2] * v2;
    b0 += v0; b1 += v1; b2 += v2;
    q0 += v0 * v0; q1 += v1 * v1; q2 += v2 * v2;
  }
  const f = n * VAR_FLOOR;
  return wch[0] * s0 / (norm[0] * Math.sqrt(Math.max(q0 - b0 * b0 / n, f))) +
    wch[1] * s1 / (norm[1] * Math.sqrt(Math.max(q1 - b1 * b1 / n, f))) +
    wch[2] * s2 / (norm[2] * Math.sqrt(Math.max(q2 - b2 * b2 / n, f)));
}

/** Best NCC of a template around cell (c, r) of a padded image at G px/cell: steps x steps offsets within +-SHIFT. */
function bestAround(img, tp, G, c, r, steps, field) {
  const p = tp.p, pad = img.pad;
  const fx = field ? field.dx(c + 0.5, r + 0.5) * G : 0, fy = field ? field.dy(c + 0.5, r + 0.5) * G : 0;
  const cx = pad + (c + 0.5) * G + fx - p / 2, cy = pad + (r + 0.5) * G + fy - p / 2;
  let best = -9;
  for (let a = 0; a < steps; a++) for (let b = 0; b < steps; b++) {
    const ox = steps > 1 ? (-SHIFT + (2 * SHIFT * b) / (steps - 1)) * G : 0, oy = steps > 1 ? (-SHIFT + (2 * SHIFT * a) / (steps - 1)) * G : 0;
    const x0 = Math.round(cx + ox), y0 = Math.round(cy + oy);
    if (x0 < 0 || y0 < 0 || x0 + p > img.w || y0 + p > img.h) continue;
    const v = nccAt(img, tp, x0, y0);
    if (v > best) best = v;
  }
  return best;
}

// ------------------------------------------------------------------ box model

/**
 * Everything about the box picture the matcher needs, learned once per box/built photo pair.
 * boxCanvas / builtCanvas: both rectified to the same grid (any size); assembled: cell indices assembled in the
 * built photo. Returns { field, img0, img1 (padded Lab at G0 / G1, corrected), cellColour, cellContrast, cal }.
 */
export function boxModel(boxCanvas, builtCanvas, assembled, cols, rows) {
  const box1 = resampleLab(boxCanvas, cols * G1, rows * G1);
  const blt1 = builtCanvas ? resampleLab(builtCanvas, cols * G1, rows * G1) : null;
  const field = blt1 && assembled.length >= 20 ? fitField(box1, blt1, assembled, cols, rows) : null;
  // bend the box picture onto the puzzle
  const W = cols * G1, H = rows * G1, cor = new Float32Array(W * H * 3), px = [0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = (x + 0.5) / G1, gy = (y + 0.5) / G1;
    const sx = x + (field ? field.dx(gx, gy) * G1 : 0), sy = y + (field ? field.dy(gx, gy) * G1 : 0);
    bilinear(box1.L, W, H, sx, sy, px);
    const i = (y * W + x) * 3;
    cor[i] = px[0]; cor[i + 1] = px[1]; cor[i + 2] = px[2];
  }
  const img1 = { L: cor, w: W, h: H };
  const img0 = { L: halve(cor, W, H), w: W / 2, h: H / 2 };
  // per-cell colour (3x3 means) and log contrast, and their calibration to the table from the assembled cells
  const stat = (img) => {
    const out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(cellStats(img.L, img.w, c * G1 + 1, r * G1 + 1, G1 - 2, null));
    return out;
  };
  const bs = stat(img1), qs = blt1 ? stat(blt1) : null;
  const cal = calibrate(bs, qs, assembled);
  return {
    field, img0: padImage(img0, G0 * 2), img1: padImage(img1, G1 * 2), cols, rows,
    covered: qs ? coveredCells(bs, qs, assembled, cal) : new Set(),
    colour: bs.map((s) => s.grid.map((v) => (v ? applyAffine(cal.colour, v) : null))),
    contrast: bs.map((s) => s.lsd.map((v, ch) => cal.contrast[ch][0] * v + cal.contrast[ch][1])),
    res: cal.res,
  };
}

function halve(L, w, h) {
  const W = w / 2, H = h / 2, o = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++) {
    const i = ((2 * y) * w + 2 * x) * 3 + ch;
    o[(y * W + x) * 3 + ch] = 0.25 * (L[i] + L[i + 3] + L[i + w * 3] + L[i + w * 3 + 3]);
  }
  return o;
}

/** 3x3 grid of mean colours and log contrast per channel of a square patch (optionally masked). */
function cellStats(L, w, x0, y0, s, mask, ms) {
  const grid = [], sum = [0, 0, 0], sq = [0, 0, 0];
  let n = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const g = [0, 0, 0];
    let k = 0;
    for (let y = Math.floor((a * s) / 3); y < Math.floor(((a + 1) * s) / 3); y++) {
      for (let x = Math.floor((b * s) / 3); x < Math.floor(((b + 1) * s) / 3); x++) {
        if (mask && !mask[(y + y0) * ms + x + x0]) continue;
        const i = ((y0 + y) * w + x0 + x) * 3;
        for (let ch = 0; ch < 3; ch++) { const v = L[i + ch]; g[ch] += v; sum[ch] += v; sq[ch] += v * v; }
        k++; n++;
      }
    }
    grid.push(k > 2 ? g.map((v) => v / k) : null);
  }
  const lsd = sum.map((v, ch) => Math.log(Math.sqrt(Math.max(0, sq[ch] / Math.max(1, n) - (v / Math.max(1, n)) ** 2)) + 1));
  return { grid, lsd, n };
}

/**
 * Cells of the box photo that can't be part of the puzzle picture: a sticker, a starburst or an inset printed over it.
 * Their colours, mapped to the table, appear nowhere in the assembled puzzle (more than COVER_DIST from every
 * assembled colour over most of the cell).
 */
const COVER_DIST = 10;
function coveredCells(bs, qs, assembled, cal) {
  const ref = [];
  for (const i of assembled) for (const v of qs[i].grid) if (v) ref.push(v);
  const out = new Set();
  if (ref.length < 50) return out;
  bs.forEach((s, i) => {
    let far = 0, n = 0;
    for (const v of s.grid) {
      if (!v) continue;
      const c = applyAffine(cal.colour, v);
      let dmin = Infinity;
      for (const r of ref) {
        const d = WLAB[0] * (c[0] - r[0]) ** 2 + WLAB[1] * (c[1] - r[1]) ** 2 + WLAB[2] * (c[2] - r[2]) ** 2;
        if (d < dmin) dmin = d;
      }
      n++; if (dmin > COVER_DIST * COVER_DIST) far++;
    }
    if (n && far / n > 0.5) out.add(i);
  });
  return out;
}

function applyAffine(M, v) {
  return [0, 1, 2].map((ch) => M[ch][0] * v[0] + M[ch][1] * v[1] + M[ch][2] * v[2] + M[ch][3]);
}

/** Least squares for small systems: rows X (each with a trailing 1), targets y; returns coefficients. */
function lsq(X, y) {
  const m = X[0].length, A = Array.from({ length: m }, () => new Float64Array(m)), b = new Float64Array(m);
  X.forEach((x, i) => { for (let u = 0; u < m; u++) { b[u] += x[u] * y[i]; for (let v = 0; v < m; v++) A[u][v] += x[u] * x[v]; } });
  for (let u = 0; u < m; u++) A[u][u] += 1e-6;
  // Gaussian elimination
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < m; c++) {
    let p = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= m; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[m] / row[i]);
}

/** Colour (affine Lab) and contrast (linear in log s.d.) maps from the box to the table, fitted on assembled cells. */
function calibrate(bs, qs, assembled) {
  const ident = { colour: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], contrast: [[1, 0], [1, 0], [1, 0]], res: [0.35, 0.3, 0.35] };
  if (!qs || assembled.length < 20) return ident;
  const X = [], Y = [[], [], []];
  for (const i of assembled) for (let g = 0; g < 9; g++) {
    const a = bs[i].grid[g], b = qs[i].grid[g];
    if (!a || !b) continue;
    X.push([a[0], a[1], a[2], 1]);
    for (let ch = 0; ch < 3; ch++) Y[ch].push(b[ch]);
  }
  // robust: drop the worst-fitting fifth (covered box parts, cells the grid misses) and fit again
  let use = X.map((_, k) => k), colour = null;
  for (let it = 0; it < 3; it++) {
    colour = Y.map((y) => lsq(use.map((k) => X[k]), use.map((k) => y[k])));
    if (colour.some((r) => !r)) return ident;
    const err = use.map((k) => { const v = applyAffine(colour, X[k]); return (v[0] - Y[0][k]) ** 2 * WLAB[0] + (v[1] - Y[1][k]) ** 2 + (v[2] - Y[2][k]) ** 2; });
    const lim = err.slice().sort((a, b) => a - b)[Math.floor(err.length * 0.8)];
    use = use.filter((_, j) => err[j] <= lim);
  }
  const contrast = [0, 1, 2].map((ch) => lsq(assembled.map((i) => [bs[i].lsd[ch], 1]), assembled.map((i) => qs[i].lsd[ch])));
  if (colour.some((r) => !r) || contrast.some((r) => !r)) return ident;
  const res = [0, 1, 2].map((ch) => {
    let s = 0;
    for (const i of assembled) s += (qs[i].lsd[ch] - (contrast[ch][0] * bs[i].lsd[ch] + contrast[ch][1])) ** 2;
    return Math.max(0.15, Math.sqrt(s / assembled.length));
  });
  return { colour, contrast, res };
}

/**
 * Smooth shift field between the box picture and the built puzzle: each assembled cell of the built photo is
 * searched in the box picture (within one cell); a robust quadratic in (col, row) is fitted to the shifts found.
 * Returns { dx(gx, gy), dy(gx, gy) } in cells, or null.
 */
function fitField(box1, blt1, assembled, cols, rows) {
  const G = G1, p = Math.round(G * 0.85), box = padImage(box1, G * 2);
  const pts = [];
  const t = new Float32Array(p * p * 3), m = new Uint8Array(p * p).fill(1);
  for (const i of assembled) {
    const c = i % cols, r = (i / cols) | 0;
    const x0 = Math.round((c + 0.5) * G - p / 2), y0 = Math.round((r + 0.5) * G - p / 2);
    for (let y = 0; y < p; y++) for (let x = 0; x < p; x++) for (let ch = 0; ch < 3; ch++) {
      t[(y * p + x) * 3 + ch] = blt1.L[((y0 + y) * blt1.w + x0 + x) * 3 + ch];
    }
    const tp = prepare(t, m, p);
    if (!tp) continue;
    // coarse search (step 2 px) within one cell, then refine
    let best = -9, bx = 0, by = 0;
    for (let dy = -G; dy <= G; dy += 2) for (let dx = -G; dx <= G; dx += 2) {
      const v = nccAt(box, tp, x0 + dx + box.pad, y0 + dy + box.pad);
      if (v > best) { best = v; bx = dx; by = dy; }
    }
    const cx = bx, cy = by;
    for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) {
      if (Math.abs(dx) > G || Math.abs(dy) > G) continue;
      const v = nccAt(box, tp, x0 + dx + box.pad, y0 + dy + box.pad);
      if (v > best) { best = v; bx = dx; by = dy; }
    }
    if (best > 0.5) pts.push({ gx: c + 0.5, gy: r + 0.5, dx: bx / G, dy: by / G });
  }
  if (pts.length < 15) return null;
  const basis = (gx, gy) => { const x = gx / cols - 0.5, y = gy / rows - 0.5; return [1, y, y * y, x, x * y, x * x]; };
  let use = pts, cx = null, cy = null;
  for (let it = 0; it < 4; it++) {
    const X = use.map((q) => basis(q.gx, q.gy));
    cx = lsq(X, use.map((q) => q.dx)); cy = lsq(X, use.map((q) => q.dy));
    if (!cx || !cy) return null;
    const res = pts.map((q) => { const b = basis(q.gx, q.gy); return Math.hypot(dot(b, cx) - q.dx, dot(b, cy) - q.dy); });
    const lim = Math.max(0.15, res.slice().sort((a, b) => a - b)[Math.floor(res.length * 0.75)]);
    use = pts.filter((_, k) => res[k] < lim);
    if (use.length < 10) break;
  }
  return { dx: (gx, gy) => dot(basis(gx, gy), cx), dy: (gx, gy) => dot(basis(gx, gy), cy), n: pts.length };
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// ------------------------------------------------------------------ pieces

/**
 * Templates of a loose piece at its 4 orientations and both resolutions, plus its photo's cloth colour (for white
 * balance). Sampled from the pieces photo in Lab; samples off the piece (blanks, cloth) are masked out.
 */
export function pieceTemplates(lab, labels, w, h, piece) {
  const out = {};
  for (const G of [G0, G1]) {
    const p = Math.round(G * TF);
    out[G] = ANGLES.map((a) => sampleTemplate(lab, labels, w, h, piece, piece.angle + a, p));
  }
  return out;
}

function sampleTemplate(lab, labels, w, h, piece, angle, p) {
  const t = new Float32Array(p * p * 3), m = new Uint8Array(p * p);
  const s = piece.side * TF, g = s / p, cos = Math.cos(angle), sin = Math.sin(angle);
  for (let j = 0; j < p; j++) for (let i = 0; i < p; i++) {
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
      const u = -s / 2 + (i + (a + 0.5) / SUB) * g, v = -s / 2 + (j + (b + 0.5) / SUB) * g;
      const x = Math.round(piece.cx + u * cos - v * sin), y = Math.round(piece.cy + u * sin + v * cos);
      if (x < 0 || y < 0 || x >= w || y >= h || labels[y * w + x] !== piece.id) continue;
      const k = (y * w + x) * 3;
      s0 += lab[k]; s1 += lab[k + 1]; s2 += lab[k + 2]; n++;
    }
    const k = j * p + i;
    if (n >= SUB * SUB * 0.75) { m[k] = 1; t[k * 3] = s0 / n; t[k * 3 + 1] = s1 / n; t[k * 3 + 2] = s2 / n; }
  }
  return { t, m, p };
}

/** Median Lab colour of the cloth (label 0) in a segmented photo, sampled sparsely. */
export function clothColour(lab, labels, w, h) {
  const vs = [[], [], []];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = y * w + x;
    if (labels[i]) continue;
    for (let ch = 0; ch < 3; ch++) vs[ch].push(lab[i * 3 + ch]);
  }
  if (vs[0].length < 50) return null;
  return vs.map((a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
}

// Lab <-> XYZ (D65) for white balancing with the cloth (von Kries scaling in XYZ)
const Xn = 0.95047, Zn = 1.08883;
function labToXyz(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t > 0.206897 ? t * t * t : (t - 16 / 116) / 7.787);
  return [inv(fx) * Xn, inv(fy), inv(fz) * Zn];
}
function xyzToLab(X, Y, Z) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / Xn), fy = f(Y), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function whiteBalance(cloth, refCloth) {
  if (!cloth || !refCloth) return null;
  const a = labToXyz(...cloth), b = labToXyz(...refCloth);
  const g = a.map((v, i) => b[i] / Math.max(1e-4, v));
  return (lab) => { const x = labToXyz(lab[0], lab[1], lab[2]); return xyzToLab(x[0] * g[0], x[1] * g[1], x[2] * g[2]); };
}

// ------------------------------------------------------------------ scoring

/**
 * Score every (piece, empty cell, rotation). Returns { s4: Float32Array(P*C*4) } where higher is better, already
 * corrected for hubs: some cells (a glossy dome on the box, a crease) look a bit like every piece and would attract
 * all of them. Each score is taken relative to how well the piece matches its own best cells and how well the cell
 * matches its own best pieces (cross-domain similarity local scaling).
 * refCloth: cloth colour in the built photo (the colour calibration was learned there).
 * gray: grey-scale mode, lightness only and no colour or contrast terms, so the light of each photo doesn't matter
 * (the shape and line-continuation cues in match.js then carry more of the decision).
 */
export const GRAY_WCH = [1, 0, 0];
export async function templateScores(pieces, model, emptyCells, refCloth, onProgress, gray = false) {
  const wch = gray ? GRAY_WCH : WCH;
  const P = pieces.length, C = emptyCells.length, { cols } = model;
  const s4 = new Float32Array(P * C * 4).fill(-1);
  const coarse = new Float32Array(P * C * 4).fill(-1);
  const cellCR = emptyCells.map((i) => [i % cols, (i / cols) | 0]);
  for (let pi = 0; pi < P; pi++) {
    const piece = pieces[pi], T = piece.templates;
    if (!T) continue;
    const t0 = T[G0].map((x) => prepare(x.t, x.m, x.p, wch)), t1 = T[G1].map((x) => prepare(x.t, x.m, x.p, wch));
    // coarse pass: every cell, 3x3 offsets
    for (let ci = 0; ci < C; ci++) {
      const [c, r] = cellCR[ci];
      for (let k = 0; k < 4; k++) if (t0[k]) coarse[(pi * C + ci) * 4 + k] = bestAround(model.img0, t0[k], G0, c, r, 3, null);
    }
    // fine pass on the best cells (5x5 offsets at double resolution); the others keep their coarse score
    const best = new Float32Array(C);
    for (let ci = 0; ci < C; ci++) { let b = -9; for (let k = 0; k < 4; k++) b = Math.max(b, coarse[(pi * C + ci) * 4 + k]); best[ci] = b; }
    const order = Array.from(best.keys()).sort((a, b) => best[b] - best[a]).slice(0, FINE_TOP);
    const fineSet = new Set(order);
    let dsum = 0, dn = 0;
    for (const ci of order) {
      const [c, r] = cellCR[ci];
      for (let k = 0; k < 4; k++) {
        if (!t1[k]) continue;
        const v = bestAround(model.img1, t1[k], G1, c, r, 5, null), j = (pi * C + ci) * 4 + k;
        dsum += coarse[j] - v; dn++;
        s4[j] = v;
      }
    }
    const shift = dn ? dsum / dn : 0; // the fine pass scores lower on average (more detail): keep both comparable
    for (let ci = 0; ci < C; ci++) {
      if (fineSet.has(ci)) continue;
      for (let k = 0; k < 4; k++) s4[(pi * C + ci) * 4 + k] = coarse[(pi * C + ci) * 4 + k] - shift;
    }
    // colour and contrast of the core
    const wb = whiteBalance(piece.cloth, refCloth);
    for (let k = 0; k < 4 && !gray; k++) {
      const x = T[G1][k], p = x.p, c0 = Math.round((p * (1 - 1 / TF)) / 2), sz = p - 2 * c0;
      let L = x.t;
      if (wb) { L = new Float32Array(x.t.length); for (let i = 0; i < p * p; i++) if (x.m[i]) { const v = wb([x.t[i * 3], x.t[i * 3 + 1], x.t[i * 3 + 2]]); L[i * 3] = v[0]; L[i * 3 + 1] = v[1]; L[i * 3 + 2] = v[2]; } }
      const st = cellStats(L, p, c0, c0, sz, x.m, p);
      if (st.n < 10) continue;
      for (let ci = 0; ci < C; ci++) {
        const cell = emptyCells[ci], bc = model.colour[cell], bk = model.contrast[cell];
        let d = 0, nd = 0;
        for (let g = 0; g < 9; g++) {
          const a = st.grid[g], b = bc[g];
          if (!a || !b) continue;
          d += Math.sqrt(WLAB[0] * (a[0] - b[0]) ** 2 + WLAB[1] * (a[1] - b[1]) ** 2 + WLAB[2] * (a[2] - b[2]) ** 2); nd++;
        }
        let z = 0;
        for (let ch = 0; ch < 3; ch++) z += ((st.lsd[ch] - bk[ch]) / model.res[ch]) ** 2;
        s4[(pi * C + ci) * 4 + k] -= (nd ? COLOUR_W * d / nd : 0) + CONTRAST_W * z / 3;
      }
    }
    if (onProgress && pi % 8 === 7) await onProgress(pi + 1, P);
  }
  // hub correction
  const bestPC = new Float32Array(P * C);
  for (let i = 0; i < P * C; i++) bestPC[i] = Math.max(s4[i * 4], s4[i * 4 + 1], s4[i * 4 + 2], s4[i * 4 + 3]);
  const topMean = (vals) => { vals.sort((a, b) => b - a); let s = 0; const k = Math.min(HUB_K, vals.length); for (let i = 0; i < k; i++) s += vals[i]; return k ? s / k : 0; };
  const rp = new Float32Array(P), rc = new Float32Array(C);
  for (let pi = 0; pi < P; pi++) rp[pi] = topMean(Array.from(bestPC.subarray(pi * C, (pi + 1) * C)));
  for (let ci = 0; ci < C; ci++) { const v = []; for (let pi = 0; pi < P; pi++) v.push(bestPC[pi * C + ci]); rc[ci] = topMean(v); }
  for (let pi = 0; pi < P; pi++) for (let ci = 0; ci < C; ci++) for (let k = 0; k < 4; k++) {
    const j = (pi * C + ci) * 4 + k;
    s4[j] = pieces[pi].templates && !model.covered.has(emptyCells[ci]) ? 2 * s4[j] - rp[pi] - rc[ci] : -1;
  }
  return { s4, gray };
}
