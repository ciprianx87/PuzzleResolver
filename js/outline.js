// Side outlines ("profiles") of jigsaw pieces, used to tell apart pieces that look alike (sky, water).
//
// A profile describes one side of a square cell or piece core. At points spread along the side (clockwise around
// the cell), it looks at the strip across the edge (from 0.25 to 0.8 side lengths out from the centre) and records
// how much of it the piece covers, as an equivalent edge position in side units: about 0.5 on a straight stretch,
// more where a tab sticks out, less where a blank cuts in. Measuring the area rather than just the outline also
// captures the width of a tab's head, not only its neck. A loose piece fits a hole left by its assembled
// neighbours when it covers exactly the strip that the neighbours leave free, so both are measured the same way.

/** Positions along a side, from -0.5 (start, clockwise) to 0.5 (end); the corners themselves are skipped. */
export const PROFILE_T = Array.from({ length: 29 }, (_, i) => -0.42 + i * 0.03);
const NT = PROFILE_T.length;
const FLANK = [0, 1, 2, NT - 3, NT - 2, NT - 1]; // straight stretches near the corners
const D0 = 0.25, D1 = 0.8, ND = 23; // the strip across the edge, and samples across it
/** Distances across the edge strip at which coverage is sampled. */
export const PROFILE_D = Array.from({ length: ND }, (_, i) => D0 + ((D1 - D0) * (i + 0.5)) / ND);
/** Edge position equivalent to covering `n` of the ND samples of the strip. */
export const coverToEdge = (n) => D0 + ((D1 - D0) * n) / ND;
const MID = PROFILE_T.map((t, i) => (Math.abs(t) <= 0.3 ? i : -1)).filter((i) => i >= 0);

/**
 * Straighten a raw profile: subtract the line through the two straight stretches near the corners, so the result no
 * longer depends on exactly where the side's baseline was assumed to be (grid offsets, a slightly tilted edge).
 * raw: distances (null where unknown). Returns deviations, or null if the corners are not measurable.
 */
export function straighten(raw) {
  const half = FLANK.length / 2;
  const l = FLANK.slice(0, half).map((i) => raw[i]).filter((v) => v != null);
  const r = FLANK.slice(half).map((i) => raw[i]).filter((v) => v != null);
  if (!l.length || !r.length) return null;
  const lv = l.reduce((a, b) => a + b, 0) / l.length, rv = r.reduce((a, b) => a + b, 0) / r.length;
  const tl = FLANK.slice(0, half).reduce((a, i) => a + PROFILE_T[i], 0) / half;
  const tr = FLANK.slice(half).reduce((a, i) => a + PROFILE_T[i], 0) / half;
  let missing = 0;
  const out = raw.map((v, i) => {
    if (v == null) { missing++; return null; }
    return v - (lv + ((rv - lv) * (PROFILE_T[i] - tl)) / (tr - tl));
  });
  return missing > 6 ? null : out;
}

/** Side type from a straightened profile: 'T' tab, 'B' blank, 'F' flat (border) or null when unclear. */
export function classify(dev) {
  if (!dev) return null;
  let max = -Infinity, min = Infinity;
  for (const i of MID) if (dev[i] != null) { max = Math.max(max, dev[i]); min = Math.min(min, dev[i]); }
  if (!Number.isFinite(max)) return null;
  if (max > 0.12 && max >= -min) return 'T';
  if (min < -0.12) return 'B';
  if (max < 0.05 && min > -0.05) return 'F';
  return null;
}

/**
 * How badly two straightened profiles disagree: mean absolute difference (side units), allowing a small shift
 * along the side (the grid and the piece centre are never exact). Infinity when they can't be compared.
 */
export function profileDist(a, b, maxShift = 2) { // maxShift in samples (0.03 each)
  if (!a || !b) return Infinity;
  let best = Infinity;
  for (let sh = -maxShift; sh <= maxShift; sh++) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + sh;
      if (j < 0 || j >= b.length || a[i] == null || b[j] == null) continue;
      s += Math.abs(a[i] - b[j]); n++;
    }
    if (n >= a.length - 8) best = Math.min(best, s / n + Math.abs(sh) * 0.003);
  }
  return best;
}

/**
 * Raw profiles of the 4 sides of a piece (top, right, bottom, left in its own frame at piece.angle), from its
 * label image.
 */
export function pieceProfiles(piece, labels, w, h) {
  const s = piece.side, cos = Math.cos(piece.angle), sin = Math.sin(piece.angle);
  const inside = (U, V) => {
    const x = Math.round(piece.cx + U * cos - V * sin), y = Math.round(piece.cy + U * sin + V * cos);
    return x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === piece.id;
  };
  return [[0, -1], [1, 0], [0, 1], [-1, 0]].map(([nu, nv]) => {
    const tu = -nv, tv = nu; // tangent, clockwise around the piece
    return PROFILE_T.map((t) => {
      let n = 0;
      for (const d of PROFILE_D) if (inside((nu * d + tu * t) * s, (nv * d + tv * t) * s)) n++;
      return coverToEdge(n);
    });
  });
}
