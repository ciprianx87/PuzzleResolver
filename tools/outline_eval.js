// Outline matching check on synthetic demo puzzles. Run in the browser console:
//   const o = await import('/tools/outline_eval.js'); await o.run(10)
// For every empty cell next to an assembled piece, ranks all loose pieces (at their best rotation) by how well their
// side outlines fit the hole, and reports how often the right piece comes first / in the top 3.
import { generateDemo } from '../js/demo.js';
import { segmentPieces } from '../js/segment.js';
import { cellRequirements } from '../js/match.js';
import { homography, rectCorners } from '../js/geometry.js';
import { homographyMap } from '../js/gridmap.js';
import { profileDist } from '../js/outline.js';
import { scaleCanvas } from '../js/imageutil.js';

export async function run(n = 10, seed0 = 1, scale = 1) {
  // scale < 1 shrinks the photos, to see how resolution affects the outlines
  let cells = 0, top1 = 0, top3 = 0, sides = 0, sideTrue = [], sideFalse = [];
  for (let k = 0; k < n; k++) {
    const d = generateDemo(seed0 + k);
    const pcs = scale === 1 ? d.pieces : scaleCanvas(d.pieces, Math.round(d.pieces.width * scale));
    const built = scale === 1 ? d.built : scaleCanvas(d.built, Math.round(d.built.width * scale));
    const seg = segmentPieces(pcs, 1);
    const cellOf = (p) => { let b = null, bd = 1e9; for (const t of d.truth) { const dd = Math.hypot(t.x * scale - p.cx, t.y * scale - p.cy); if (dd < bd) { bd = dd; b = t; } } return b.cell; };
    const truthOf = new Map(seg.pieces.map((p) => [p, cellOf(p)]));
    const q = d.builtQuad.map((p) => ({ x: p.x * scale, y: p.y * scale })), dd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const bs = segmentPieces(built, 1, null, (dd(q[0], q[1]) / d.cols) * (dd(q[0], q[3]) / d.rows) * 1.1);
    const mask = new Uint8Array(bs.w * bs.h);
    for (let p = 0; p < mask.length; p++) mask[p] = bs.mask[p] && !bs.looseIds.has(bs.labels[p]) ? 1 : 0;
    const filled = new Uint8Array(d.cols * d.rows); for (const i of d.filled) filled[i] = 1;
    const empty = []; for (let i = 0; i < d.cols * d.rows; i++) if (!filled[i]) empty.push(i);
    const needs = cellRequirements(empty, d.cols, d.rows, filled, filled, { mask, w: bs.w, h: bs.h }, homographyMap(homography(rectCorners(d.cols, d.rows), q)));
    for (const cell of empty) {
      const need = needs.get(cell);
      if (!need.prof.some(Boolean)) continue;
      const scores = seg.pieces.map((p) => {
        let best = Infinity;
        for (let r = 0; r < 4; r++) {
          let s = 0, m = 0;
          for (let t = 0; t < 4; t++) {
            if (!need.prof[t]) continue;
            const v = profileDist(p.profiles[(t + r) % 4], need.prof[t]);
            s += Number.isFinite(v) ? v : 0.07; m++;
          }
          best = Math.min(best, s / m);
        }
        return { p, s: best };
      }).sort((a, b) => a.s - b.s);
      const rank = scores.findIndex((x) => truthOf.get(x.p) === cell);
      cells++; if (rank === 0) top1++; if (rank >= 0 && rank < 3) top3++;
      if (rank >= 0) { sideTrue.push(scores[rank].s); sideFalse.push(scores[(rank + 1) % scores.length].s); }
      sides += need.prof.filter(Boolean).length;
    }
    await Promise.resolve(); // (no timer: background tabs throttle them)
  }
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  return { cells, top1: (top1 / cells).toFixed(2), top3: (top3 / cells).toFixed(2), sidesPerCell: (sides / cells).toFixed(2),
    medianTrueDist: med(sideTrue)?.toFixed(3), medianOtherDist: med(sideFalse)?.toFixed(3), piecesPerPuzzle: 'see demo' };
}
