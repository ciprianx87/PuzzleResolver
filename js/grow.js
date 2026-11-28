// Growing the puzzle outwards from the assembled pieces, with backtracking.
//
// The one-shot assignment (solveAll) places every loose piece at once, each judged only against the box picture and
// the assembled neighbours in the built photo. When the puzzle is built for real, every piece that goes in becomes a
// new neighbour: its tabs and blanks, its outline and the lines of its picture must fit the next pieces too. This
// search does the same: it repeatedly fills the gap next to the assembled (or already proposed) pieces where one
// piece fits clearly best, trying each piece at all 4 rotations, and lets the proposed pieces constrain the next gaps.
// A wrong early choice would mislead everything after it, so several alternative partial solutions are kept (a beam
// search: bounded backtracking). The one that places the most pieces well wins.

import { lineScore, NL } from './edges.js';
import { profileDist } from './outline.js';

const BEAM = 6;          // partial solutions kept
const BRANCH = 3;        // alternatives tried at each step
const TOP = 30;          // candidate pieces per cell (by their own score); pairwise fit re-ranks those
const MAX_STEPS = 80;
const SHAPE_PENALTY = 9, OUTLINE_W = 120, OUTLINE_CENTER = 0.06, OUTLINE_UNKNOWN = 0.07;
const LINE_W = 15;

/**
 * scored: from scoreAll ({ score, score4, cells }); pieces; cols, rows; filled: cells already in the puzzle (assembled
 * or marked as placed); exclude: piece indices already placed. Returns placements in the order they were proposed:
 * [{ cell, piece, score, confidence, angle, step, after }] (after: the earlier step this placement leans on, or -1).
 */
export function growSolve(scored, pieces, cols, rows, filled, exclude = new Set()) {
  const { score, score4, cells } = scored;
  const C = cells.length, P = pieces.length;
  if (!C || !P) return [];
  const colOf = new Map(cells.map((c, i) => [c, i]));
  const avail = new Set(pieces.map((_, i) => i).filter((i) => !exclude.has(pieces[i].idx)));
  const pair = pairTable(pieces);

  // per cell: baseline (median over pieces of their best score there) and the candidate pieces
  const base = new Float32Array(C), cand = [];
  for (let ci = 0; ci < C; ci++) {
    const v = [];
    for (const pi of avail) v.push([pi, score[pi * C + ci]]);
    v.sort((a, b) => a[1] - b[1]);
    base[ci] = v.length ? v[v.length >> 1][1] : 0;
    cand.push(v.slice(0, TOP).map((x) => x[0]));
  }
  // temperature as in solveAll
  const bests = [];
  for (const pi of avail) { let b = Infinity; for (let ci = 0; ci < C; ci++) b = Math.min(b, score[pi * C + ci]); bests.push(b); }
  bests.sort((a, b) => a - b);
  const tau = Math.max(2, (bests[bests.length >> 1] || 0) * 0.35);

  const nbr = (cell, t) => {
    const c = cell % cols, r = (cell / cols) | 0;
    if (t === 0) return r > 0 ? cell - cols : -1;
    if (t === 1) return c < cols - 1 ? cell + 1 : -1;
    if (t === 2) return r < rows - 1 ? cell + cols : -1;
    return c > 0 ? cell - 1 : -1;
  };

  /** Best placement at one cell given a partial solution: sorted [{ pi, k, cost }] over the candidate pieces. */
  const options = (st, cell) => {
    const ci = colOf.get(cell), out = [];
    const nb = [0, 1, 2, 3].map((t) => { const n = nbr(cell, t); return n >= 0 ? st.placed.get(n) : null; });
    for (const pi of cand[ci]) {
      if (st.used.has(pi)) continue;
      let best = Infinity, bk = 0;
      for (let k = 0; k < 4; k++) {
        let v = score4[(pi * C + ci) * 4 + k];
        for (let t = 0; t < 4; t++) {
          const q = nb[t];
          if (q) v += pair(pi, (t + k) % 4, q.pi, (t + 2 + q.k) % 4);
        }
        if (v < best) { best = v; bk = k; }
      }
      out.push({ pi, k: bk, cost: best });
    }
    out.sort((a, b) => a.cost - b.cost);
    return out;
  };

  /**
   * The gap where one piece fits most clearly: { cell, ci, opts, conf } or null. Two-way, like solveAll: the piece
   * must beat the other pieces for this gap, and suit this gap better than the other open gaps.
   */
  const nextCell = (st) => {
    const open = [];
    const pieceBest = new Map(); // piece -> [min cost over open gaps, sum of exp]
    for (let ci = 0; ci < C; ci++) {
      const cell = cells[ci];
      if (st.placed.has(cell)) continue;
      let touches = false;
      for (let t = 0; t < 4 && !touches; t++) { const n = nbr(cell, t); if (n >= 0 && (filled[n] || st.placed.has(n))) touches = true; }
      if (!touches) continue;
      const opts = options(st, cell);
      if (!opts.length) continue;
      open.push({ cell, ci, opts });
      for (const o of opts) { const b = pieceBest.get(o.pi); if (!b || o.cost < b) pieceBest.set(o.pi, o.cost); }
    }
    const pieceZ = new Map();
    for (const g of open) for (const o of g.opts) pieceZ.set(o.pi, (pieceZ.get(o.pi) || 0) + Math.exp(-(o.cost - pieceBest.get(o.pi)) / tau));
    let pick = null;
    for (const g of open) {
      const o = g.opts[0];
      if (o.cost - base[g.ci] >= 0) continue; // not better than a typical piece: no evidence
      let z = 0;
      for (const x of g.opts) z += Math.exp(-(x.cost - o.cost) / tau);
      const pp = Math.exp(-(o.cost - pieceBest.get(o.pi)) / tau) / pieceZ.get(o.pi);
      const conf = Math.sqrt(pp / z);
      if (!pick || conf > pick.conf) pick = { ...g, conf, pieceBest, pieceZ };
    }
    return pick;
  };

  let beam = [{ placed: new Map(), used: new Set(), total: 0, steps: [] }];
  const done = [];
  for (let step = 0; step < MAX_STEPS && beam.length; step++) {
    const next = [];
    for (const st of beam) {
      const pick = nextCell(st);
      if (!pick) { done.push(st); continue; }
      for (const o of pick.opts.slice(0, BRANCH)) {
        const rel = o.cost - base[pick.ci];
        if (rel >= 0) break;
        // a weaker alternative only branches when it is close to the best one
        if (o !== pick.opts[0] && o.cost - pick.opts[0].cost > tau * 2) break;
        let z = 1;
        for (const x of pick.opts) if (x.pi !== o.pi) z += Math.exp(-(x.cost - o.cost) / tau);
        const pp = Math.exp(-(o.cost - pick.pieceBest.get(o.pi)) / tau) / pick.pieceZ.get(o.pi);
        const placed = new Map(st.placed); placed.set(pick.cell, { pi: o.pi, k: o.k });
        const used = new Set(st.used); used.add(o.pi);
        // a placement is only as sure as the proposed pieces it leans on (and theirs, and so on): one doubtful step
        // must not make everything built on it look certain, as the choice narrows when fewer pieces are left
        let after = -1, conf = Math.sqrt(pp / z);
        for (let t = 0; t < 4; t++) {
          const n = nbr(pick.cell, t), q = n >= 0 ? st.placed.get(n) : null;
          if (!q) continue;
          const j = st.steps.findIndex((s) => s.cell === n);
          after = Math.max(after, j);
          conf = Math.min(conf, st.steps[j].conf);
        }
        next.push({ placed, used, total: st.total + rel,
          steps: [...st.steps, { cell: pick.cell, pi: o.pi, k: o.k, cost: o.cost, conf, after }] });
      }
    }
    // keep the best partial solutions; identical sets of placements are kept once
    next.sort((a, b) => a.total - b.total);
    const seen = new Set();
    beam = [];
    for (const st of next) {
      const key = [...st.placed].map(([c, q]) => `${c}:${q.pi}:${q.k}`).sort().join(',');
      if (seen.has(key)) continue;
      seen.add(key); beam.push(st);
      if (beam.length >= BEAM) break;
    }
  }
  done.push(...beam);
  if (!done.length) return [];
  done.sort((a, b) => a.total - b.total);
  return done[0].steps.map((s, i) => {
    const piece = pieces[s.pi];
    return { cell: s.cell, piece, score: s.cost, confidence: s.conf, angle: piece.angle + (s.k * Math.PI) / 2, step: i, after: s.after };
  });
}

/**
 * Cost of side a of piece pa sitting against side b of piece pb (lower = better fit): tab against blank, outlines
 * that interlock, and lines of the picture that continue across the seam. Memoised.
 */
function pairTable(pieces) {
  const P = pieces.length, memo = new Float32Array(P * 4 * P * 4).fill(NaN);
  return (pa, a, pb, b) => {
    const i = (pa * 4 + a) * P * 4 + pb * 4 + b;
    if (!Number.isNaN(memo[i])) return memo[i];
    const A = pieces[pa], B = pieces[pb];
    let v = 0;
    const sa = A.sides && A.sides[a], sb = B.sides && B.sides[b];
    if (sa && sb && (sa === 'F' || sb === 'F' || sa === sb)) v += SHAPE_PENALTY;
    const pA = A.profiles && A.profiles[a], pB = B.profiles && B.profiles[b];
    if (pA && pB) {
      const hole = pB.map((x) => (x == null ? null : -x)).reverse(); // B's outline seen from A's side
      const d = profileDist(pA, hole);
      v += OUTLINE_W * (Math.min(0.2, Number.isFinite(d) ? d : OUTLINE_UNKNOWN) - OUTLINE_CENTER);
    }
    const lA = A.lines && A.lines[a], lB = B.lines && B.lines[b];
    if (lA && lB) {
      const s = lineScore(lA, reverseLine(lB));
      if (s != null) v -= LINE_W * s;
    }
    memo[i] = v;
    return v;
  };
}

function reverseLine(l) {
  const v = new Float32Array(NL), wt = new Float32Array(NL);
  for (let j = 0; j < NL; j++) { v[j] = l.v[NL - 1 - j]; wt[j] = l.wt[NL - 1 - j]; }
  return { v, wt };
}
