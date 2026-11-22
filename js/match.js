// Appearance descriptors and matching of pieces to puzzle cells.
import { sample3, otsu, median } from './imageutil.js';

export const N = 8;          // descriptor grid is N x N
const INNER = 0.84;          // fraction of the cell/core that is sampled
const SUB = 3;               // sub-samples per descriptor cell (per axis)
const WL = 0.45;             // lightness weight (print vs photo lighting differs)

/** Descriptor of an axis-aligned cell in a rectified Lab image. */
export function cellDescriptor(lab, w, h, x0, y0, cw, ch, inner = INNER) {
  const d = new Float32Array(N * N * 3);
  const mx = (cw * (1 - inner)) / 2, my = (ch * (1 - inner)) / 2;
  const gw = (cw * inner) / N, gh = (ch * inner) / N;
  const px = [0, 0, 0];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
      const x = x0 + mx + (i + (a + 0.5) / SUB) * gw - 0.5;
      const y = y0 + my + (j + (b + 0.5) / SUB) * gh - 0.5;
      if (sample3(lab, w, h, x, y, px)) { s0 += px[0]; s1 += px[1]; s2 += px[2]; n++; }
    }
    const k = (j * N + i) * 3;
    if (n) { d[k] = s0 / n; d[k + 1] = s1 / n; d[k + 2] = s2 / n; }
  }
  return d;
}

/** Descriptors for every cell of a rectified image. */
export function gridDescriptors(lab, w, h, cols, rows, inner = INNER) {
  const cw = w / cols, ch = h / rows;
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push(cellDescriptor(lab, w, h, c * cw, r * ch, cw, ch, inner));
  return out;
}

/**
 * Descriptor of a loose piece's square core, rotated by `angle` (radians, clockwise in image space).
 * Returns { d, wt } where wt is the per-cell fraction of samples that fall on the piece.
 */
export function pieceDescriptor(lab, labels, w, h, piece, angle) {
  const d = new Float32Array(N * N * 3), wt = new Float32Array(N * N);
  const s = piece.side * INNER, g = s / N;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const px = [0, 0, 0];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let b = 0; b < SUB; b++) for (let a = 0; a < SUB; a++) {
      const u = -s / 2 + (i + (a + 0.5) / SUB) * g, v = -s / 2 + (j + (b + 0.5) / SUB) * g;
      const x = piece.cx + u * cos - v * sin, y = piece.cy + u * sin + v * cos;
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h || labels[yi * w + xi] !== piece.id) continue;
      if (sample3(lab, w, h, x, y, px)) { s0 += px[0]; s1 += px[1]; s2 += px[2]; n++; }
    }
    const k = j * N + i;
    wt[k] = n / (SUB * SUB);
    if (n) { d[k * 3] = s0 / n; d[k * 3 + 1] = s1 / n; d[k * 3 + 2] = s2 / n; }
  }
  return { d, wt };
}

// --- colour calibration (per-channel mean/std matching) -------------------
export function channelStats(descs, weights) {
  const s = [0, 0, 0], s2 = [0, 0, 0];
  let n = 0;
  descs.forEach((d, idx) => {
    const wt = weights ? weights[idx] : null;
    for (let k = 0; k < N * N; k++) {
      const w = wt ? wt[k] : 1;
      if (w <= 0) continue;
      for (let c = 0; c < 3; c++) { const v = d[k * 3 + c]; s[c] += v * w; s2[c] += v * v * w; }
      n += w;
    }
  });
  if (!n) return null;
  return s.map((v, c) => {
    const m = v / n;
    return { m, sd: Math.sqrt(Math.max(1e-3, s2[c] / n - m * m)) };
  });
}

/** Calibration mapping `from` stats to `to` stats, softened by `blend` (0 = identity). */
export function makeCalib(from, to, blend = 0.7) {
  if (!from || !to) return null;
  return from.map((f, c) => {
    let k = to[c].sd / f.sd;
    k = Math.max(0.6, Math.min(1.6, k));
    // full mapping v' = to.m + (v - f.m) * k, blended with identity
    return { gain: 1 - blend + blend * k, off: blend * (to[c].m - f.m * k) };
  });
}

export function applyCalib(d, cal) {
  if (!cal) return d;
  const o = new Float32Array(d.length);
  for (let k = 0; k < d.length; k += 3) for (let c = 0; c < 3; c++) o[k + c] = d[k + c] * cal[c].gain + cal[c].off;
  return o;
}

/** Weighted descriptor distance. */
export function descDist(a, b, wt) {
  let s = 0, n = 0;
  for (let k = 0; k < N * N; k++) {
    const w = wt ? wt[k] : 1;
    if (w <= 0.2) continue;
    const i = k * 3;
    const dL = a[i] - b[i], da = a[i + 1] - b[i + 1], db = a[i + 2] - b[i + 2];
    s += w * (WL * dL * dL + da * da + db * db);
    n += w;
  }
  return n > N * N * 0.25 ? Math.sqrt(s / n) : Infinity;
}

/**
 * Decide which cells of the built puzzle are already filled by comparing them with the box picture.
 * Iteratively estimates a colour calibration from the cells it believes are filled.
 */
export const DETECT_INNER = 0.5; // centre of the cell only: neighbours' tabs reach into empty cells

export function detectFilled(builtDescs, refDescs) {
  const n = refDescs.length;
  let cal = null, filled = new Uint8Array(n), dists = new Float32Array(n);
  for (let it = 0; it < 4; it++) {
    for (let i = 0; i < n; i++) dists[i] = descDist(applyCalib(builtDescs[i], cal), refDescs[i]);
    const finite = Array.from(dists).filter(Number.isFinite);
    // log space: filled vs empty differ by a factor rather than an offset
    const t = Math.exp(otsu(finite.map((v) => Math.log1p(v)))) - 1;
    const lo = finite.filter((v) => v <= t), hi = finite.filter((v) => v > t);
    const mLo = lo.length ? median(lo) : 0, mHi = hi.length ? median(hi) : Infinity;
    let thr;
    if (hi.length && mHi / Math.max(1, mLo) > 1.7) thr = t;
    else thr = mLo < 18 ? Infinity : 0; // no clear split: all filled or all empty
    for (let i = 0; i < n; i++) filled[i] = dists[i] <= thr ? 1 : 0;
    const fb = [], fr = [];
    for (let i = 0; i < n; i++) if (filled[i]) { fb.push(builtDescs[i]); fr.push(refDescs[i]); }
    if (fb.length < 3) break;
    cal = makeCalib(channelStats(fb), channelStats(fr), 0.8);
  }
  return { filled, dists };
}

const SAMPLE_ANGLES = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2);

/** Compute descriptors of each piece at its 4 possible orientations. */
export function describePieces(seg) {
  const { lab, labels, w, h, pieces } = seg;
  for (const p of pieces) {
    p.descs = SAMPLE_ANGLES.map((a) => pieceDescriptor(lab, labels, w, h, p, p.angle + a));
  }
}

/**
 * Score every (piece, empty cell) pair.
 * Returns { score: Float32Array[pieces*cells], rot: Uint8Array, cells: [cellIdx] }.
 */
export function scoreAll(pieces, refDescs, emptyCells) {
  // calibrate the pieces' colours against the region that is still empty: those are the same picture parts
  const pStats = channelStats(pieces.map((p) => p.descs[0].d), pieces.map((p) => p.descs[0].wt));
  const rStats = channelStats(emptyCells.map((c) => refDescs[c]));
  const cal = makeCalib(pStats, rStats, 0.6);
  const P = pieces.length, C = emptyCells.length;
  const score = new Float32Array(P * C), rot = new Uint8Array(P * C);
  pieces.forEach((p, pi) => {
    const cd = p.descs.map((x) => applyCalib(x.d, cal));
    for (let ci = 0; ci < C; ci++) {
      const ref = refDescs[emptyCells[ci]];
      let best = Infinity, bk = 0;
      for (let k = 0; k < 4; k++) {
        const v = descDist(cd[k], ref, p.descs[k].wt);
        if (v < best) { best = v; bk = k; }
      }
      score[pi * C + ci] = best; rot[pi * C + ci] = bk;
    }
  });
  return { score, rot, cells: emptyCells, cal };
}

/**
 * Assign pieces to the empty cells of one line.
 * Confidence combines how much better the cell is than other cells for that piece, and how much better the piece is
 * than other pieces for that cell (two-way softmax).
 */
export function solveLine(scored, pieces, lineCells, excludePieces = new Set()) {
  const { score, rot, cells } = scored;
  const C = cells.length, P = pieces.length;
  const colOf = new Map(cells.map((c, i) => [c, i]));
  const avail = pieces.map((_, i) => i).filter((i) => !excludePieces.has(pieces[i].idx));
  if (!avail.length) return [];
  // temperature: typical best score
  const bests = avail.map((pi) => { let b = Infinity; for (let ci = 0; ci < C; ci++) b = Math.min(b, score[pi * C + ci]); return b; });
  const tau = Math.max(2, median(bests.filter(Number.isFinite)) * 0.35);

  // per piece normaliser over all empty cells
  const pieceZ = new Map();
  for (const pi of avail) {
    let z = 0;
    for (let ci = 0; ci < C; ci++) z += Math.exp(-(score[pi * C + ci] - bests[avail.indexOf(pi)]) / tau);
    pieceZ.set(pi, { z, b: bests[avail.indexOf(pi)] });
  }
  const cand = [];
  for (const cell of lineCells) {
    const ci = colOf.get(cell);
    if (ci === undefined) continue;
    let cb = Infinity;
    for (const pi of avail) cb = Math.min(cb, score[pi * C + ci]);
    let cz = 0;
    for (const pi of avail) cz += Math.exp(-(score[pi * C + ci] - cb) / tau);
    for (const pi of avail) {
      const s = score[pi * C + ci];
      if (!Number.isFinite(s)) continue;
      const { z, b } = pieceZ.get(pi);
      const pCell = Math.exp(-(s - b) / tau) / z;
      const pPiece = Math.exp(-(s - cb) / tau) / cz;
      cand.push({ cell, pi, s, k: rot[pi * C + ci], conf: Math.sqrt(pCell * pPiece) });
    }
  }
  cand.sort((a, b) => b.conf - a.conf || a.s - b.s);
  const usedP = new Set(), usedC = new Set(), out = [];
  for (const c of cand) {
    if (usedP.has(c.pi) || usedC.has(c.cell)) continue;
    usedP.add(c.pi); usedC.add(c.cell);
    const piece = pieces[c.pi];
    out.push({ cell: c.cell, piece, score: c.s, confidence: c.conf, angle: piece.angle + SAMPLE_ANGLES[c.k] });
  }
  return out;
}

/**
 * Minimum-cost assignment (Hungarian algorithm, O(n^2 m)) for an n x m cost matrix with n <= m.
 * cost(i, j) returns a finite number. Returns an array: row i -> column index.
 */
function hungarian(n, m, cost) {
  const INF = 1e18;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(INF);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Int32Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

/**
 * Place as many pieces as possible at once: globally optimal one-to-one assignment of the available loose pieces
 * to all empty cells (minimum total appearance distance). Each placement gets the same two-way confidence used
 * for single lines. Returns [{ cell, piece, score, confidence, angle }].
 */
export function solveAll(scored, pieces, excludePieces = new Set()) {
  const { score, rot, cells } = scored;
  const C = cells.length;
  const avail = pieces.map((_, i) => i).filter((i) => !excludePieces.has(pieces[i].idx));
  const P = avail.length;
  if (!P || !C) return [];
  const BIG = 1e6;
  const s = (pi, ci) => { const v = score[pi * C + ci]; return Number.isFinite(v) ? v : BIG; };

  // assignment (rows = smaller side)
  const pairs = [];
  if (P <= C) {
    const a = hungarian(P, C, (i, j) => s(avail[i], j));
    a.forEach((ci, i) => ci >= 0 && pairs.push([avail[i], ci]));
  } else {
    const a = hungarian(C, P, (i, j) => s(avail[j], i));
    a.forEach((j, ci) => j >= 0 && pairs.push([avail[j], ci]));
  }

  // confidence: softmax over cells for the piece x softmax over pieces for the cell
  const bestP = new Map(), bestC = new Float64Array(C).fill(Infinity);
  for (const pi of avail) {
    let b = Infinity;
    for (let ci = 0; ci < C; ci++) { const v = score[pi * C + ci]; if (v < b) b = v; if (v < bestC[ci]) bestC[ci] = v; }
    bestP.set(pi, b);
  }
  const tau = Math.max(2, median([...bestP.values()].filter(Number.isFinite)) * 0.35);
  const out = [];
  for (const [pi, ci] of pairs) {
    const v = score[pi * C + ci];
    if (!Number.isFinite(v)) continue;
    let zp = 0, zc = 0;
    for (let cj = 0; cj < C; cj++) zp += Math.exp(-(score[pi * C + cj] - bestP.get(pi)) / tau);
    for (const pj of avail) zc += Math.exp(-(score[pj * C + ci] - bestC[ci]) / tau);
    const conf = Math.sqrt((Math.exp(-(v - bestP.get(pi)) / tau) / zp) * (Math.exp(-(v - bestC[ci]) / tau) / zc));
    const piece = pieces[pi];
    out.push({ cell: cells[ci], piece, score: v, confidence: conf, angle: piece.angle + SAMPLE_ANGLES[rot[pi * C + ci]] });
  }
  return out;
}
