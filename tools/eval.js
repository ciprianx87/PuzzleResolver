// Accuracy check on synthetic demo puzzles. Run in the browser console:
//   const e = await import('/tools/eval.js'); await e.run(20)
import { generateDemo } from '../js/demo.js';
import { toLab, getImageData } from '../js/imageutil.js';
import { warpQuad, quadAspect, rectifiedSize } from '../js/geometry.js';
import { segmentPieces } from '../js/segment.js';
import { gridDescriptors, detectFilled, DETECT_INNER, describePieces, scoreAll, solveLine, cellRequirements } from '../js/match.js';
import { homography, rectCorners } from '../js/geometry.js';
import { segmentPieces as seg2 } from '../js/segment.js';

export async function run(n = 10, seed0 = 1, useShape = true, noColor = false) {
  // noColor: make every piece and cell look the same, to measure what the shape cues alone achieve
  const tot = { filledErr: 0, cells: 0, segFound: 0, segTrue: 0, assigned: 0, correct: 0, rotOk: 0, confCorrect: 0, conf: 0 };
  for (let k = 0; k < n; k++) {
    const d = generateDemo(seed0 + k);
    const { w, h } = rectifiedSize(d.cols, d.rows, quadAspect(d.boxQuad));
    const ref = warpQuad(d.box, d.boxQuad, w, h), refLab = toLab(getImageData(ref));
    const built = warpQuad(d.built, d.builtQuad, w, h), bLab = toLab(getImageData(built));
    const refD = gridDescriptors(refLab, w, h, d.cols, d.rows);
    const { filled } = detectFilled(gridDescriptors(bLab, w, h, d.cols, d.rows, DETECT_INNER), gridDescriptors(refLab, w, h, d.cols, d.rows, DETECT_INNER));
    for (let i = 0; i < filled.length; i++) if (!!filled[i] !== d.filled.has(i)) tot.filledErr++;
    tot.cells += filled.length;
    // use ground-truth filled for matching so the stages are measured independently
    const seg = segmentPieces(d.pieces, 1);
    describePieces(seg);
    tot.segFound += seg.pieces.length; tot.segTrue += d.truth.length;
    const cellOf = (p) => { let b = null, bd = 1e9; for (const t of d.truth) { const dd = Math.hypot(t.x - p.cx, t.y - p.cy); if (dd < bd) { bd = dd; b = t; } } return b; };
    const empty = []; for (let i = 0; i < d.cols * d.rows; i++) if (!d.filled.has(i)) empty.push(i);
    let needs = null;
    if (useShape) {
      // assembled mask of the built photo (everything that isn't cloth or a loose piece)
      const q = d.builtQuad, dd = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
      const cw = dd(q[0], q[1]) / d.cols, ch = dd(q[0], q[3]) / d.rows;
      const bs = seg2(d.built, 1, null, cw * ch * 1.1);
      const mask = new Uint8Array(bs.w * bs.h);
      for (let p = 0; p < mask.length; p++) mask[p] = bs.mask[p] && !bs.looseIds.has(bs.labels[p]) ? 1 : 0;
      const filledArr = new Uint8Array(d.cols * d.rows); for (const i of d.filled) filledArr[i] = 1;
      needs = cellRequirements(empty, d.cols, d.rows, filledArr, filledArr, { mask, w: bs.w, h: bs.h }, homography(rectCorners(d.cols, d.rows), d.builtQuad));
    }
    if (noColor) {
      const flat = new Float32Array(refD[0].length).fill(50);
      for (let i = 0; i < refD.length; i++) refD[i] = flat;
      for (const p of seg.pieces) p.descs = p.descs.map((x) => ({ d: flat, wt: x.wt }));
    }
    const scored = scoreAll(seg.pieces, refD, empty, needs);
    for (let line = 0; line < d.rows; line++) {
      const cells = empty.filter((c) => ((c / d.cols) | 0) === line);
      if (!cells.length) continue;
      for (const m of solveLine(scored, seg.pieces, cells)) {
        const t = cellOf(m.piece);
        tot.assigned++;
        const ok = t.cell === m.cell;
        if (ok) {
          tot.correct++;
          const deg = ((m.angle * 180 / Math.PI) % 360 + 360) % 360;
          const diff = Math.abs(((deg - t.rot) % 360 + 540) % 360 - 180);
          if (diff < 25) tot.rotOk++;
        }
        if (m.confidence >= 0.25) { tot.conf++; if (ok) tot.confCorrect++; }
      }
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return {
    filledAccuracy: (1 - tot.filledErr / tot.cells).toFixed(3),
    piecesFound: `${tot.segFound}/${tot.segTrue}`,
    matchAccuracy: (tot.correct / tot.assigned).toFixed(3),
    rotationAccuracyWhenCorrect: (tot.rotOk / Math.max(1, tot.correct)).toFixed(3),
    confidentPrecision: `${tot.confCorrect}/${tot.conf}`,
  };
}
