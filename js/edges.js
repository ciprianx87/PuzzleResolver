// Colour continuity with the neighbouring pieces.
//
// The box picture tells what a cell should look like, but a printed box, its gloss and the room light make that
// comparison rough. The pieces already assembled around a hole are photographed on the same table: the colours
// just inside their edges continue straight into the missing piece. So each side of a loose piece is compared with
// the strip just across the edge, inside the assembled neighbour, in the built photo.
import { sample3 } from './imageutil.js';

/** Segments along a side; each holds the mean Lab colour of a short stretch of the strip along the edge. */
export const EK = 6;
const T0 = -0.42, T1 = 0.42;            // stretch of the side used (corners skipped)
const DEPTHS = [0.05, 0.1, 0.16];       // how far inside the edge the strip is sampled, in side lengths
const SIDES = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // top, right, bottom, left (outward normals)
const WL = 0.45;                        // lightness weight, as for the descriptors

/**
 * Mean colours along the strip just inside each of a piece's 4 sides (in its own frame at piece.angle, clockwise).
 * Returns [{ c: Float32Array(EK*3), wt: Float32Array(EK) }] x 4; wt is the fraction of samples on the piece.
 */
export function pieceEdges(lab, labels, w, h, piece) {
  const s = piece.side, cos = Math.cos(piece.angle), sin = Math.sin(piece.angle), px = [0, 0, 0];
  return SIDES.map(([nu, nv]) => strip((t, d) => {
    const U = (nu * (0.5 - d) + -nv * t) * s, V = (nv * (0.5 - d) + nu * t) * s;
    const x = piece.cx + U * cos - V * sin, y = piece.cy + U * sin + V * cos;
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h || labels[yi * w + xi] !== piece.id) return null;
    return sample3(lab, w, h, x, y, px) ? px : null;
  }));
}

/**
 * Mean colours along the strip just across side t of empty cell (c, r), inside the assembled neighbour, in the built
 * photo. lab: the built photo in Lab; mask: assembled puzzle mask; toPx maps grid coordinates to photo pixels.
 * Ordered clockwise around the empty cell, like a piece's own sides once turned into the cell.
 */
export function neighbourEdge(lab, mask, w, h, toPx, c, r, t) {
  const [nu, nv] = SIDES[t], px = [0, 0, 0];
  return strip((tt, d) => {
    const [x, y] = toPx(c + 0.5 + nu * (0.5 + d) - nv * tt, r + 0.5 + nv * (0.5 + d) + nu * tt);
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h || mask[yi * w + xi] !== 1) return null;
    return sample3(lab, w, h, x, y, px) ? px : null;
  });
}

/** Average sampler(t, d) -> Lab|null over EK segments along a side. */
function strip(sampler) {
  const c = new Float32Array(EK * 3), wt = new Float32Array(EK);
  const SUB = 3;
  for (let j = 0; j < EK; j++) {
    let s0 = 0, s1 = 0, s2 = 0, n = 0;
    for (let a = 0; a < SUB; a++) {
      const t = T0 + ((T1 - T0) * (j + (a + 0.5) / SUB)) / EK;
      for (const d of DEPTHS) {
        const v = sampler(t, d);
        if (!v) continue;
        s0 += v[0]; s1 += v[1]; s2 += v[2]; n++;
      }
    }
    wt[j] = n / (SUB * DEPTHS.length);
    if (n) { c[j * 3] = s0 / n; c[j * 3 + 1] = s1 / n; c[j * 3 + 2] = s2 / n; }
  }
  return { c, wt };
}

/** Colour difference between two edge strips (mean over the segments both cover), or Infinity. */
export function edgeDist(a, b) {
  let s = 0, n = 0;
  for (let j = 0; j < EK; j++) {
    if (a.wt[j] < 0.4 || b.wt[j] < 0.4) continue;
    const i = j * 3, dL = a.c[i] - b.c[i], da = a.c[i + 1] - b.c[i + 1], db = a.c[i + 2] - b.c[i + 2];
    s += Math.sqrt(WL * dL * dL + da * da + db * db); n++;
  }
  return n >= EK / 2 ? s / n : Infinity;
}

/** Mean / spread per Lab channel of a set of edge strips (segments with enough coverage). */
export function edgeStats(strips) {
  const s = [0, 0, 0], s2 = [0, 0, 0];
  let n = 0;
  for (const e of strips) for (let j = 0; j < EK; j++) {
    if (e.wt[j] < 0.4) continue;
    for (let ch = 0; ch < 3; ch++) { const v = e.c[j * 3 + ch]; s[ch] += v; s2[ch] += v * v; }
    n++;
  }
  if (n < 10) return null;
  return s.map((v, ch) => { const m = v / n; return { m, sd: Math.sqrt(Math.max(1e-3, s2[ch] / n - m * m)) }; });
}

/** Apply a per-channel gain/offset calibration (see makeCalib in match.js) to an edge strip. */
export function calibEdge(e, cal) {
  if (!cal) return e;
  const c = new Float32Array(e.c.length);
  for (let i = 0; i < c.length; i += 3) for (let ch = 0; ch < 3; ch++) c[i + ch] = e.c[i + ch] * cal[ch].gain + cal[ch].off;
  return { c, wt: e.wt };
}
