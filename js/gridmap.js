// Where each grid cell sits in the built photo.
//
// The four corners give a homography, but a real puzzle lying on a cloth is never perfectly straight: its border
// bows, and corners dragged on a phone are a little off. Once a border side is assembled, its outer edge is a
// reliable straight-in-reality line, so it is traced in the photo and the grid is stretched between the four traced
// edges (a Coons patch). Cells then follow the bowed frame instead of the 4-corner approximation.
import { applyH } from './geometry.js';

/** Grid mapping from a homography: (gx, gy) in cells -> [x, y] photo pixels. */
export function homographyMap(H) {
  return (gx, gy) => { const p = applyH(H, gx, gy); return [p.x, p.y]; };
}

/** Least-squares polynomial fit y = sum c_k x^k (degree deg). Returns coefficients or null. */
function polyfit(xs, ys, deg) {
  const n = deg + 1, A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let i = 0; i < xs.length; i++) {
    const pw = [1];
    for (let k = 1; k <= 2 * deg; k++) pw.push(pw[k - 1] * xs[i]);
    for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += pw[r + c]; A[r][n] += ys[i] * pw[r]; }
  }
  for (let c = 0; c < n; c++) { // Gaussian elimination with partial pivoting
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}
const polyval = (c, x) => c.reduceRight((acc, v) => acc * x + v, 0);

/**
 * Robust smooth curve through edge samples: cubic fit, dropping outliers (a loose piece lying against the frame, a
 * piece the mask lost) and refitting. xs normalised to 0..1. Returns a function, or null if the samples disagree.
 */
function robustCurve(xs, ys) {
  let keep = xs.map((_, i) => i);
  let c = null;
  for (let it = 0; it < 4; it++) {
    if (keep.length < 8) return null;
    c = polyfit(keep.map((i) => xs[i]), keep.map((i) => ys[i]), 3);
    if (!c) return null;
    const res = keep.map((i) => Math.abs(ys[i] - polyval(c, xs[i])));
    const mad = res.slice().sort((a, b) => a - b)[res.length >> 1];
    const lim = Math.max(0.08, mad * 3);
    const next = keep.filter((_, j) => res[j] <= lim);
    if (next.length === keep.length) break;
    keep = next;
  }
  if (keep.length < xs.length * 0.5) return null;
  return (x) => polyval(c, x);
}

/**
 * Trace the outer edge of one assembled border side in the built photo's foreground mask. Works in the grid
 * coordinates of the 4-corner homography H: returns a function giving, along the side (0..1), the edge's offset
 * across it (in cells, e.g. gy for the top side; 0 = where the corners put it), or null.
 * side: 0 top, 1 right, 2 bottom, 3 left.
 */
function traceEdge(fg, H, cols, rows, side) {
  const { mask, w, h } = fg;
  const isFg = (gx, gy) => {
    const p = applyH(H, gx, gy), x = Math.round(p.x), y = Math.round(p.y);
    return x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  };
  const horizontal = side === 0 || side === 2, len = horizontal ? cols : rows;
  const edge = side === 0 ? 0 : side === 1 ? cols : side === 2 ? rows : 0;
  const out = side === 1 || side === 2 ? 1 : -1; // outward direction of the across coordinate
  const at = (a, b) => (horizontal ? isFg(a, b) : isFg(b, a)); // a along, b across
  const xs = [], ys = [];
  const STEP = 0.02, GAP = 0.25, MINRUN = 0.35;
  for (let a = 0.25; a < len - 0.2; a += 0.25) {
    // walk outwards from well inside; the edge is the end of the first long foreground run followed by cloth
    let run = 0, gap = 0, end = null;
    for (let d = -1.6; d <= 1.5; d += STEP) {
      const b = edge + out * d;
      if (at(a, b)) {
        if (gap > 0 && gap < GAP) run += gap; // a seam or dark speck inside the frame
        else if (gap >= GAP) run = 0;
        gap = 0; run += STEP;
      } else {
        if (run >= MINRUN && gap === 0) end = d;
        gap += STEP;
        if (end !== null && gap >= GAP) break;
        if (gap >= GAP) { run = 0; end = null; }
      }
    }
    if (end !== null && gap >= GAP) { xs.push(a / len); ys.push(end); }
  }
  const f = robustCurve(xs, ys);
  return f && ((s) => edge + out * f(s));
}

/**
 * Grid mapping that follows the traced outer edges of the complete border sides (sides: [top, right, bottom, left]
 * booleans); sides that aren't complete keep the 4-corner line. Returns { map, traced } where map(gx, gy) ->
 * [x, y] photo pixels and traced counts the sides that were followed.
 */
export function frameMap(fg, H, cols, rows, sides) {
  const tr = [0, 1, 2, 3].map((s) => (sides[s] ? traceEdge(fg, H, cols, rows, s) : null));
  const traced = tr.filter(Boolean).length;
  if (!traced) return { map: homographyMap(H), traced };
  const eT = tr[0] || (() => 0), eR = tr[1] || (() => cols), eB = tr[2] || (() => rows), eL = tr[3] || (() => 0);
  // corners where the traced edges meet (in homography grid coordinates)
  const P00 = [eL(0), eT(0)], P10 = [eR(0), eT(1)], P01 = [eL(1), eB(0)], P11 = [eR(1), eB(1)];
  const lerp = (p, q, t) => p + (q - p) * t;
  const map = (gx, gy) => {
    const s = gx / cols, t = gy / rows;
    const T = [lerp(P00[0], P10[0], s), eT(s)], B = [lerp(P01[0], P11[0], s), eB(s)];
    const L = [eL(t), lerp(P00[1], P01[1], t)], R = [eR(t), lerp(P10[1], P11[1], t)];
    const u = (1 - t) * T[0] + t * B[0] + (1 - s) * L[0] + s * R[0]
      - ((1 - s) * (1 - t) * P00[0] + s * (1 - t) * P10[0] + (1 - s) * t * P01[0] + s * t * P11[0]);
    const v = (1 - t) * T[1] + t * B[1] + (1 - s) * L[1] + s * R[1]
      - ((1 - s) * (1 - t) * P00[1] + s * (1 - t) * P10[1] + (1 - s) * t * P01[1] + s * t * P11[1]);
    const p = applyH(H, u, v);
    return [p.x, p.y];
  };
  return { map, traced };
}

/** Warp the built photo into a cols x rows grid image of size w x h, following a grid mapping (bilinear). */
export function warpGrid(srcCanvas, map, cols, rows, w, h) {
  const src = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = src.width, sh = src.height, sd = src.data;
  const out = new ImageData(w, h), od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [sx, sy] = map(((x + 0.5) / w) * cols, ((y + 0.5) / h) * rows);
      sx -= 0.5; sy -= 0.5;
      sx = Math.max(0, Math.min(sw - 1, sx)); sy = Math.max(0, Math.min(sh - 1, sy));
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0, o = (y * w + x) * 4;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        od[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      }
      od[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}
