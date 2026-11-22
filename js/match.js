// Appearance descriptors and matching of pieces to puzzle cells.
import { sample3, otsu, median } from './imageutil.js';
import { invertH } from './geometry.js';
import { PROFILE_T, PROFILE_D, coverToEdge, straighten, classify, profileDist } from './outline.js';

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

/** Offsets (fractions of a cell) tried for each cell of the built puzzle. */
export const SHIFTS = (() => {
  const v = [-0.4, -0.2, 0, 0.2, 0.4], out = [];
  for (const dy of v) for (const dx of v) out.push([dx, dy]);
  out.sort((p, q) => Math.hypot(...p) - Math.hypot(...q)); // unshifted first
  return out;
})();

/**
 * Descriptors of every cell at several small offsets. Photos of a real puzzle are never perfectly flat (the border
 * bows, the photo has lens distortion), so a cell may sit a little away from where the 4-corner mapping puts it.
 * Returns an array (one per offset in SHIFTS) of per-cell descriptor arrays.
 */
export function shiftedGridDescriptors(lab, w, h, cols, rows, inner) {
  const cw = w / cols, ch = h / rows;
  return SHIFTS.map(([dx, dy]) => {
    const out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      out.push(cellDescriptor(lab, w, h, (c + dx) * cw, (r + dy) * ch, cw, ch, inner));
    }
    return out;
  });
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

/**
 * Fallback when the surface around the puzzle can't be seen: decide which cells are filled by comparing them with
 * the box picture. builtSets: descriptor sets of the built puzzle, one per offset (see SHIFTS); the best offset
 * per cell counts. Otsu split (in log space) of the distances; a colour calibration is estimated from the cells
 * believed filled, and iterated.
 */
export function detectFilled(builtSets, refDescs) {
  const sets = Array.isArray(builtSets[0]) ? builtSets : [builtSets];
  const n = refDescs.length;
  const best = new Array(n);
  let cal = null, filled = new Uint8Array(n), dists = new Float32Array(n);
  for (let it = 0; it < 4; it++) {
    for (let i = 0; i < n; i++) {
      let b = Infinity, bd = sets[0][i];
      for (const set of sets) {
        const v = descDist(applyCalib(set[i], cal), refDescs[i]);
        if (v < b) { b = v; bd = set[i]; }
      }
      dists[i] = b; best[i] = bd;
    }
    const finite = Array.from(dists).filter(Number.isFinite);
    const t = Math.exp(otsu(finite.map((v) => Math.log1p(v)))) - 1;
    const lo = finite.filter((v) => v <= t), hi = finite.filter((v) => v > t);
    const mLo = lo.length ? median(lo) : 0, mHi = hi.length ? median(hi) : Infinity;
    let thr;
    if (hi.length && mHi / Math.max(1, mLo) > 1.7) thr = t;
    else thr = mLo < 18 ? Infinity : 0; // no clear split: all filled or all empty
    for (let i = 0; i < n; i++) filled[i] = dists[i] <= thr ? 1 : 0;
    const fb = [], fr = [];
    for (let i = 0; i < n; i++) if (filled[i]) { fb.push(best[i]); fr.push(refDescs[i]); }
    if (fb.length < 3) break;
    cal = makeCalib(channelStats(fb), channelStats(fr), 0.8);
  }
  return { filled, dists };
}

const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // top, right, bottom, left (outward normals)

/** Map grid coordinates to photo pixels with homography H (see gridmap.js for the general mapping). */
function gridToPx(H, gx, gy) {
  const W = H[6] * gx + H[7] * gy + H[8];
  return [(H[0] * gx + H[1] * gy + H[2]) / W, (H[3] * gx + H[4] * gy + H[5]) / W];
}

/**
 * Outline of the hole an assembled neighbour leaves on side t of an empty cell: how much of the strip across that
 * edge is not assembled puzzle in the built photo (see outline.js). Straightened, or null.
 */
function holeProfile(assembled, toPx, c, r, t) {
  const [nu, nv] = SIDES[t], tu = -nv, tv = nu;
  const { mask, w, h } = assembled;
  const free = (gx, gy) => {
    const [x, y] = toPx(gx, gy), xi = Math.round(x), yi = Math.round(y);
    return !(xi >= 0 && yi >= 0 && xi < w && yi < h && mask[yi * w + xi] === 1);
  };
  const raw = PROFILE_T.map((tt) => {
    let n = 0;
    for (const d of PROFILE_D) if (free(c + 0.5 + nu * d + tu * tt, r + 0.5 + nv * d + tv * tt)) n++;
    return coverToEdge(n);
  });
  return straighten(raw);
}

/**
 * What each empty cell needs on each side, as far as the built photo tells. Returns Map cell -> [top, right,
 * bottom, left] with:
 *  - 'F' on the puzzle's edge (flat side), 'N' (not flat) for an interior side next to a cell that is still empty
 *    or was filled after the photo;
 *  - next to a piece assembled in the photo: 'B' / 'T' (blank / tab) or null if unclear, and the outline of the
 *    hole that neighbour leaves in `.prof[t]` (straightened profile, see outline.js).
 * assembled: the built photo's assembled-puzzle mask (or null); photoFilled: cells filled in the photo itself;
 * toPx(gx, gy) -> [x, y]: where grid points are in the built photo (see gridmap.js).
 */
export function cellRequirements(emptyCells, cols, rows, filled, photoFilled, assembled, toPx) {
  const out = new Map();
  for (const cell of emptyCells) {
    const c = cell % cols, r = (cell / cols) | 0;
    const nb = [r > 0 ? cell - cols : -1, c < cols - 1 ? cell + 1 : -1, r < rows - 1 ? cell + cols : -1, c > 0 ? cell - 1 : -1];
    const prof = [null, null, null, null];
    const need = nb.map((n, t) => {
      if (n < 0) return 'F';
      if (!filled[n]) return 'N';
      if (!assembled || !photoFilled || !photoFilled[n]) return 'N'; // placed later: shape unknown
      prof[t] = holeProfile(assembled, toPx, c, r, t);
      const k = classify(prof[t]);
      return k === 'F' ? 'N' : k; // a neighbour inside the puzzle never leaves a straight edge
    });
    need.prof = prof;
    out.set(cell, need);
  }
  return out;
}

/**
 * Which sides of the puzzle's border are complete in the built photo: in a band around that edge, the mask runs
 * unbroken from one corner to the other, or covers the whole length apart from short gaps (pieces whose colour is
 * close to the cloth's drop out of the mask). The band is generous (about a cell either way), so a bowed border or
 * imprecise corners don't matter. Returns [top, right, bottom, left] booleans.
 */
export function completeBorderSides(assembled, H, cols, rows) {
  const { mask, w, h } = assembled, Hi = invertH(H);
  const g = new Float32Array(w * h * 2); // grid coordinates of every pixel
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const W = Hi[6] * x + Hi[7] * y + Hi[8];
    g[(y * w + x) * 2] = (Hi[0] * x + Hi[1] * y + Hi[2]) / W;
    g[(y * w + x) * 2 + 1] = (Hi[3] * x + Hi[4] * y + Hi[5]) / W;
  }
  const M = 1.2; // band reaches this many cells outside / inside the edge
  const sides = [
    { inBand: (gx, gy) => gy > -M && gy < 1 + M && gx > -M && gx < cols + M, along: (gx) => gx, len: cols },
    { inBand: (gx, gy) => gx > cols - 1 - M && gx < cols + M && gy > -M && gy < rows + M, along: (gx, gy) => gy, len: rows },
    { inBand: (gx, gy) => gy > rows - 1 - M && gy < rows + M && gx > -M && gx < cols + M, along: (gx) => gx, len: cols },
    { inBand: (gx, gy) => gx > -M && gx < 1 + M && gy > -M && gy < rows + M, along: (gx, gy) => gy, len: rows },
  ];
  // seams between pieces can look like cloth in a far-away photo: step over gaps of a few pixels
  const [ax, ay] = gridToPx(H, cols / 2, rows / 2), [bx, by] = gridToPx(H, cols / 2 + 1, rows / 2);
  const R = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) * 0.08));
  const offs = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx || dy) offs.push([dx, dy]);
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
  const cellArea = Math.hypot(bx - ax, by - ay) ** 2;
  const covered = ({ inBand, along, len }) => {
    // coverage in half-cell steps; the longest uncovered stretch (in cells) and the uncovered fraction
    const bins = new Float32Array(len * 2);
    for (let p = 0; p < w * h; p++) {
      if (mask[p] !== 1 || !inBand(g[p * 2], g[p * 2 + 1])) continue;
      const b = Math.floor(along(g[p * 2], g[p * 2 + 1]) * 2);
      if (b >= 0 && b < bins.length) bins[b]++;
    }
    let run = 0, maxRun = 0, empty = 0;
    for (const v of bins) {
      if (v < cellArea * 0.1) { run++; empty++; maxRun = Math.max(maxRun, run); } else run = 0;
    }
    return maxRun <= 6 && empty <= bins.length * 0.15;
  };
  return sides.map((side) => {
    const { inBand, along, len } = side;
    if (covered(side)) return true;
    seen.fill(0);
    let qh = 0, qt = 0;
    const ok = (p) => mask[p] === 1 && inBand(g[p * 2], g[p * 2 + 1]);
    for (let p = 0; p < w * h; p++) {
      if (ok(p) && along(g[p * 2], g[p * 2 + 1]) < 0.6) { seen[p] = 1; queue[qt++] = p; }
    }
    while (qh < qt) {
      const p = queue[qh++];
      if (along(g[p * 2], g[p * 2 + 1]) > len - 0.6) return true;
      const x = p % w, y = (p / w) | 0;
      for (const [dx, dy] of offs) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const q = Y * w + X;
        if (!seen[q] && ok(q)) { seen[q] = 1; queue[qt++] = q; }
      }
    }
    return false;
  });
}

/** Cells along the given complete border sides ([top, right, bottom, left] booleans). */
export function borderCells(sides, cols, rows) {
  const out = [];
  for (let c = 0; c < cols; c++) { if (sides[0]) out.push(c); if (sides[2]) out.push((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { if (sides[3]) out.push(r * cols); if (sides[1]) out.push(r * cols + cols - 1); }
  return out;
}

/**
 * Structural detection: a cell is filled when the assembled puzzle (as opposed to bare cloth or loose pieces)
 * covers the middle of the cell. assembled: Uint8Array mask over the built photo; toPx(gx, gy) -> [x, y] maps grid
 * coordinates (0..cols, 0..rows) to photo pixels. Small offsets absorb a bowed border or lens distortion.
 */
export function filledFromCoverage(assembled, w, h, toPx, cols, rows, minCover = 0.55) {
  const S = 6, offs = [];
  for (const dy of [-0.2, 0, 0.2]) for (const dx of [-0.2, 0, 0.2]) offs.push([dx, dy]);
  const filled = new Uint8Array(cols * rows), cover = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    let best = 0;
    for (const [dx, dy] of offs) {
      let hit = 0;
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        const gx = c + dx + 0.15 + (0.7 * (i + 0.5)) / S, gy = r + dy + 0.15 + (0.7 * (j + 0.5)) / S;
        const [fx, fy] = toPx(gx, gy), x = Math.round(fx), y = Math.round(fy);
        if (x >= 0 && y >= 0 && x < w && y < h && assembled[y * w + x]) hit++;
      }
      best = Math.max(best, hit / (S * S));
      if (best === 1) break;
    }
    cover[r * cols + c] = best;
    filled[r * cols + c] = best >= minCover ? 1 : 0;
  }
  return { filled, cover };
}

const SAMPLE_ANGLES = [0, 1, 2, 3].map((k) => (k * Math.PI) / 2);

/** Compute descriptors of each piece at its 4 possible orientations. */
export function describePieces(seg) {
  const { lab, labels, w, h, pieces } = seg;
  for (const p of pieces) {
    p.descs = SAMPLE_ANGLES.map((a) => pieceDescriptor(lab, labels, w, h, p, p.angle + a));
  }
  seg.lab = null; // not needed any more; can be ~50 MB per photo
}

/**
 * Score every (piece, empty cell) pair.
 * Returns { score: Float32Array[pieces*cells], rot: Uint8Array, cells: [cellIdx] }.
 */
/** Score added per side whose shape contradicts what the cell needs (flat border, tab or blank). */
export const SHAPE_PENALTY = 9;
/** Score per unit of outline disagreement (mean deviation in side units) with an assembled neighbour's hole. */
export const OUTLINE_WEIGHT = 120;
const OUTLINE_UNKNOWN = 0.07; // assumed disagreement when the piece's side outline couldn't be measured
const OUTLINE_CENTER = 0.06;  // typical disagreement of a wrong piece

/**
 * Is a piece's side shape compatible with what a cell needs? need: 'F' flat (border), 'T' / 'B' (tab / blank, from
 * the neighbouring placed piece), 'N' not flat (interior side, neighbour unknown), or null (no information).
 */
function sideMismatch(have, need) {
  if (!have || !need) return 0;
  if (need === 'N') return have === 'F' ? 1 : 0;
  return have === need ? 0 : 1;
}

export function scoreAll(pieces, refDescs, emptyCells, cellNeeds = null, outlineWeight = OUTLINE_WEIGHT) {
  // cellNeeds (optional): Map cell -> [top, right, bottom, left] side requirements (see sideMismatch)
  // calibrate the pieces' colours against the region that is still empty: those are the same picture parts.
  // Done per photo, since each photo has its own lighting and white balance.
  const rStats = channelStats(emptyCells.map((c) => refDescs[c]));
  const byShot = new Map();
  for (const p of pieces) {
    const k = p.shot ?? 0;
    if (!byShot.has(k)) byShot.set(k, []);
    byShot.get(k).push(p);
  }
  const cals = new Map();
  for (const [k, list] of byShot) {
    const pStats = channelStats(list.map((p) => p.descs[0].d), list.map((p) => p.descs[0].wt));
    cals.set(k, makeCalib(pStats, rStats, list.length >= 20 ? 0.6 : 0.3));
  }
  const P = pieces.length, C = emptyCells.length;
  const score = new Float32Array(P * C), rot = new Uint8Array(P * C), score4 = new Float32Array(P * C * 4);
  pieces.forEach((p, pi) => {
    const cal = cals.get(p.shot ?? 0);
    const cd = p.descs.map((x) => applyCalib(x.d, cal));
    for (let ci = 0; ci < C; ci++) {
      const ref = refDescs[emptyCells[ci]];
      const need = cellNeeds && cellNeeds.get(emptyCells[ci]);
      let best = Infinity, bk = 0;
      for (let k = 0; k < 4; k++) {
        let v = descDist(cd[k], ref, p.descs[k].wt);
        if (need && p.sides) {
          // at rotation k the cell's side t is the piece's own side (t + k) % 4
          let m = 0;
          for (let t = 0; t < 4; t++) m += sideMismatch(p.sides[(t + k) % 4], need[t]);
          v += m * SHAPE_PENALTY;
          if (need.prof && p.profiles) {
            // (centred, so cells next to assembled pieces are not less attractive than cells without outlines)
            for (let t = 0; t < 4; t++) if (need.prof[t]) v += outlineCost(p.profiles[(t + k) % 4], need.prof[t], outlineWeight);
          }
        }
        score4[(pi * C + ci) * 4 + k] = v;
        if (v < best) { best = v; bk = k; }
      }
      score[pi * C + ci] = best; rot[pi * C + ci] = bk;
    }
  });
  return { score, score4, rot, cells: emptyCells, outlineWeight };
}

/** Outline cost of fitting a piece side (straightened profile) into a hole outline. */
function outlineCost(prof, hole, weight) {
  const d = profileDist(prof, hole);
  return weight * (Math.min(0.2, Number.isFinite(d) ? d : OUTLINE_UNKNOWN) - OUTLINE_CENTER);
}

/**
 * Assign pieces to the empty cells of one line, one cell at a time, most confident first.
 * Confidence combines how much better the cell is than other cells for that piece, and how much better the piece is
 * than other pieces for that cell (two-way softmax).
 * Outlines are chained: once a piece is proposed for a cell, the hole it leaves in the next cells of the line is
 * known (its own side outline, seen from the other side), which narrows down look-alike pieces for those cells.
 * cols: grid width, needed for the chaining (0 turns it off).
 */
export function solveLine(scored, pieces, lineCells, excludePieces = new Set(), cols = 0) {
  const { score, score4, rot, cells, outlineWeight = OUTLINE_WEIGHT } = scored;
  const C = cells.length, P = pieces.length;
  const colOf = new Map(cells.map((c, i) => [c, i]));
  const avail = pieces.map((_, i) => i).filter((i) => !excludePieces.has(pieces[i].idx));
  if (!avail.length) return [];
  // temperature: typical best score
  const bests = avail.map((pi) => { let b = Infinity; for (let ci = 0; ci < C; ci++) b = Math.min(b, score[pi * C + ci]); return b; });
  const tau = Math.max(2, median(bests.filter(Number.isFinite)) * 0.35);
  // per piece normaliser over all empty cells
  const pieceZ = new Map();
  avail.forEach((pi, a) => {
    let z = 0;
    for (let ci = 0; ci < C; ci++) z += Math.exp(-(score[pi * C + ci] - bests[a]) / tau);
    pieceZ.set(pi, { z, b: bests[a] });
  });

  const todo = new Set(lineCells.filter((c) => colOf.has(c)));
  const extra = new Map(); // cell -> Float32Array(P * 4): outline cost against pieces proposed next to it
  const anchor = new Map(); // cell -> confidence of the proposal(s) its chained outline came from
  const used = new Set(), out = [];
  while (todo.size) {
    let pick = null;
    for (const cell of todo) {
      const ci = colOf.get(cell), ex = extra.get(cell);
      const vals = [];
      let cb = Infinity;
      for (const pi of avail) {
        if (used.has(pi)) continue;
        let s = score[pi * C + ci], k = rot[pi * C + ci];
        if (ex && score4) {
          s = Infinity;
          for (let kk = 0; kk < 4; kk++) { const v = score4[(pi * C + ci) * 4 + kk] + ex[pi * 4 + kk]; if (v < s) { s = v; k = kk; } }
        }
        if (!Number.isFinite(s)) continue;
        vals.push([pi, s, k]);
        if (s < cb) cb = s;
      }
      let cz = 0;
      for (const v of vals) cz += Math.exp(-(v[1] - cb) / tau);
      for (const [pi, s, k] of vals) {
        const { z, b } = pieceZ.get(pi);
        let conf = Math.sqrt((Math.exp(-(s - b) / tau) / z) * (Math.exp(-(s - cb) / tau) / cz));
        if (ex) conf = Math.min(conf, anchor.get(cell)); // a chain is only as sure as the proposal it hangs on
        if (!pick || conf > pick.conf || (conf === pick.conf && s < pick.s)) pick = { cell, pi, s, k, conf };
      }
    }
    if (!pick) break;
    const piece = pieces[pick.pi];
    used.add(pick.pi); todo.delete(pick.cell);
    out.push({ cell: pick.cell, piece, score: pick.s, confidence: pick.conf, angle: piece.angle + SAMPLE_ANGLES[pick.k] });
    if (!cols || !piece.profiles) continue;
    // chain: the proposed piece's sides define the holes of its neighbours in the line
    for (let t = 0; t < 4; t++) {
      const n = pick.cell + [-cols, 1, cols, -1][t];
      if (!todo.has(n)) continue;
      const dev = piece.profiles[(t + pick.k) % 4];
      if (!dev) continue;
      const hole = dev.map((v) => (v == null ? null : -v)).reverse(); // seen from the neighbour, clockwise around it
      const tn = (t + 2) % 4;
      const ex = extra.get(n) || new Float32Array(P * 4);
      for (const pi of avail) {
        const pr = pieces[pi].profiles;
        if (!pr) continue;
        for (let kk = 0; kk < 4; kk++) ex[pi * 4 + kk] += outlineCost(pr[(tn + kk) % 4], hole, outlineWeight);
      }
      extra.set(n, ex);
      anchor.set(n, Math.max(anchor.get(n) || 0, pick.conf));
    }
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
