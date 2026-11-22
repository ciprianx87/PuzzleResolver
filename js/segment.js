// Foreground/background segmentation and piece extraction.
import { toLab, getImageData, otsu, median, scaleCanvas } from './imageutil.js';

const WL = 0.5; // weight of lightness differences (shadows / uneven light)

function labDist(lab, i, L, a, b) {
  const dL = lab[i] - L, da = lab[i + 1] - a, db = lab[i + 2] - b;
  return Math.sqrt(WL * dL * dL + da * da + db * db);
}

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

/** Median Lab of the pixels in a border band of the image. */
function borderColor(lab, w, h) {
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const Ls = [], As = [], Bs = [];
  const step = Math.max(1, Math.round(Math.min(w, h) / 300));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const i = (y * w + x) * 3;
      Ls.push(lab[i]); As.push(lab[i + 1]); Bs.push(lab[i + 2]);
    }
  }
  return [median(Ls), median(As), median(Bs)];
}

/**
 * Per-pixel distance from a locally-estimated background colour.
 * The background is modelled on a coarse block grid so gentle lighting gradients are tolerated.
 */
function backgroundDistance(lab, w, h) {
  const [L0, a0, b0] = borderColor(lab, w, h);
  const n = w * h;
  const d0 = new Float32Array(n);
  for (let p = 0; p < n; p++) d0[p] = labDist(lab, p * 3, L0, a0, b0);

  // first guess of what is background
  const sub = [];
  for (let p = 0; p < n; p += 7) sub.push(d0[p]);
  const t0 = Math.max(6, otsu(sub));

  // block model
  const B = Math.max(16, Math.round(Math.max(w, h) / 40));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const acc = new Float64Array(bw * bh * 3), cnt = new Float64Array(bw * bh);
  for (let y = 0; y < h; y++) {
    const by = (y / B) | 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (d0[p] >= t0 * 0.6) continue;
      const bi = by * bw + ((x / B) | 0);
      acc[bi * 3] += lab[p * 3]; acc[bi * 3 + 1] += lab[p * 3 + 1]; acc[bi * 3 + 2] += lab[p * 3 + 2];
      cnt[bi]++;
    }
  }
  const model = new Float32Array(bw * bh * 3);
  const known = new Uint8Array(bw * bh);
  const minCnt = B * B * 0.15;
  for (let i = 0; i < bw * bh; i++) {
    if (cnt[i] >= minCnt) {
      known[i] = 1;
      model[i * 3] = acc[i * 3] / cnt[i]; model[i * 3 + 1] = acc[i * 3 + 1] / cnt[i]; model[i * 3 + 2] = acc[i * 3 + 2] / cnt[i];
    }
  }
  // fill unknown blocks from neighbours (repeated dilation); fall back to global colour
  let changed = true, guard = 0;
  while (changed && guard++ < Math.max(bw, bh)) {
    changed = false;
    const nk = known.slice();
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const i = by * bw + bx;
      if (known[i]) continue;
      let s0 = 0, s1 = 0, s2 = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
        const j = y * bw + x;
        if (!known[j]) continue;
        s0 += model[j * 3]; s1 += model[j * 3 + 1]; s2 += model[j * 3 + 2]; c++;
      }
      if (c) {
        model[i * 3] = s0 / c; model[i * 3 + 1] = s1 / c; model[i * 3 + 2] = s2 / c;
        nk[i] = 1; changed = true;
      }
    }
    known.set(nk);
  }
  for (let i = 0; i < bw * bh; i++) if (!known[i]) { model[i * 3] = L0; model[i * 3 + 1] = a0; model[i * 3 + 2] = b0; }

  // bilinear interpolation of the block model
  const dist = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / B - 0.5; if (fy < 0) fy = 0; if (fy > bh - 1) fy = bh - 1;
    const y0 = fy | 0, y1 = Math.min(y0 + 1, bh - 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) / B - 0.5; if (fx < 0) fx = 0; if (fx > bw - 1) fx = bw - 1;
      const x0 = fx | 0, x1 = Math.min(x0 + 1, bw - 1), tx = fx - x0;
      const i00 = (y0 * bw + x0) * 3, i10 = (y0 * bw + x1) * 3, i01 = (y1 * bw + x0) * 3, i11 = (y1 * bw + x1) * 3;
      const m = (c) => (model[i00 + c] * (1 - tx) + model[i10 + c] * tx) * (1 - ty) + (model[i01 + c] * (1 - tx) + model[i11 + c] * tx) * ty;
      const p = y * w + x;
      dist[p] = labDist(lab, p * 3, m(0), m(1), m(2));
    }
  }
  return dist;
}

// --- binary morphology (square structuring element, separable box sums) ---
function boxPass(src, w, h, r, horizontal, test) {
  const out = new Uint8Array(w * h);
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const pre = new Int32Array(len + 1);
  for (let l = 0; l < lines; l++) {
    for (let k = 0; k < len; k++) {
      const p = horizontal ? l * w + k : k * w + l;
      pre[k + 1] = pre[k] + src[p];
    }
    for (let k = 0; k < len; k++) {
      const a = Math.max(0, k - r), b = Math.min(len - 1, k + r);
      const s = pre[b + 1] - pre[a];
      const p = horizontal ? l * w + k : k * w + l;
      out[p] = test(s, b - a + 1) ? 1 : 0;
    }
  }
  return out;
}
const dilate = (m, w, h, r) => boxPass(boxPass(m, w, h, r, true, (s) => s > 0), w, h, r, false, (s) => s > 0);
const erode = (m, w, h, r) => boxPass(boxPass(m, w, h, r, true, (s, n) => s === n), w, h, r, false, (s, n) => s === n);

function fillHoles(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p) => { if (!mask[p] && !seen[p]) { seen[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  for (let p = 0; p < w * h; p++) if (!mask[p] && !seen[p]) mask[p] = 1;
  return mask;
}

/** Connected components (4-connectivity). Returns {labels, comps}. */
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || labels[s]) continue;
    const id = ++next;
    let sp = 0, area = 0, sx = 0, sy = 0, minX = w, minY = h, maxX = 0, maxY = 0, border = false;
    labels[s] = id; stack[sp++] = s;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !labels[p - w]) { labels[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !labels[p + w]) { labels[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ id, area, cx: sx / area, cy: sy / area, minX, minY, maxX, maxY, border });
  }
  return { labels, comps };
}

/** Binary foreground mask of an image against its (roughly uniform) background. */
export function foregroundMask(canvas, sens = 1) {
  const w = canvas.width, h = canvas.height;
  const lab = toLab(getImageData(canvas));
  const dist = backgroundDistance(lab, w, h);
  const sub = [];
  for (let p = 0; p < w * h; p += 5) sub.push(dist[p]);
  // noise floor from the image border
  const bsub = [];
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (x < band || y < band || x >= w - band || y >= h - band) bsub.push(dist[y * w + x]);
  }
  const noise = bsub.length ? percentile(bsub, 0.9) : 4;
  const thr = Math.max(otsu(sub) * 0.85, noise * 2.2, 5) / sens;
  let mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) mask[p] = dist[p] > thr ? 1 : 0;
  const r = Math.max(1, Math.round(Math.min(w, h) / 500));
  mask = dilate(erode(mask, w, h, r), w, h, r); // open: remove speckle
  mask = erode(dilate(mask, w, h, r + 1), w, h, r + 1); // close: fill cracks
  fillHoles(mask, w, h);
  return { mask, lab, w, h, thr };
}

/**
 * Find the puzzle (or box picture) region as the largest foreground blob and return its 4 corners.
 * Returns null if nothing convincing is found.
 */
export function autoQuad(canvas) {
  const small = scaleCanvas(canvas, 420);
  const s = canvas.width / small.width;
  const { mask, w, h } = foregroundMask(small, 1);
  const { comps, labels } = components(mask, w, h);
  if (!comps.length) return null;
  comps.sort((a, b) => b.area - a.area);
  const big = comps[0];
  if (big.area < w * h * 0.08 || big.area > w * h * 0.97) return null;
  let tl = null, tr = null, br = null, bl = null;
  let vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = Infinity;
  for (let y = big.minY; y <= big.maxY; y++) for (let x = big.minX; x <= big.maxX; x++) {
    if (labels[y * w + x] !== big.id) continue;
    if (x + y < vtl) { vtl = x + y; tl = { x, y }; }
    if (x - y > vtr) { vtr = x - y; tr = { x, y }; }
    if (x + y > vbr) { vbr = x + y; br = { x, y }; }
    if (x - y < vbl) { vbl = x - y; bl = { x, y }; }
  }
  return [tl, tr, br, bl].map((p) => ({ x: (p.x + 0.5) * s, y: (p.y + 0.5) * s }));
}

/**
 * Segment loose pieces. Returns { pieces, lab, mask, labels, w, h, info }.
 * Each piece: { id, area, cx, cy (core centre), side (core size), angle (core orientation, radians), bbox, cluster }
 */
export function segmentPieces(canvas, sens = 1) {
  const { mask, lab, w, h, thr } = foregroundMask(canvas, sens);
  const { labels, comps } = components(mask, w, h);
  const minArea = w * h * 0.0004;
  let cand = comps.filter((c) => c.area >= minArea && !c.border);
  if (!cand.length) return { pieces: [], lab, mask, labels, w, h, info: { thr, medArea: 0, rejected: comps.length } };
  // pieces are all about the same size: use the median area as reference
  const medArea = median(cand.map((c) => c.area));
  cand = cand.filter((c) => c.area > medArea * 0.3 && c.area < medArea * 4.5);

  const pieces = cand.map((c, k) => {
    const piece = {
      id: c.id, idx: k, area: c.area, cx: c.cx, cy: c.cy,
      side: Math.sqrt(medArea) * 0.9, angle: 0, bbox: { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY },
      cluster: c.area > medArea * 1.8,
    };
    refinePose(piece, labels, w, h);
    return piece;
  });
  // all pieces of a puzzle have (nearly) the same core size: blend each estimate with the median
  const medSide = median(pieces.map((p) => p.ownSide));
  for (const p of pieces) p.side = 0.5 * medSide + 0.5 * Math.min(Math.max(p.ownSide, medSide * 0.8), medSide * 1.2);
  return { pieces, lab, mask, labels, w, h, info: { thr, medArea, rejected: comps.length - pieces.length } };
}

/**
 * Estimate the pose of a piece's square core.
 *  - orientation (mod 90 deg): histogram of outline normal directions in 4*theta space; the straight core edges
 *    dominate while the round tabs spread out evenly.
 *  - centre / size: width profiles of the mask along both piece axes; the core is where the profile is wide,
 *    tabs are narrow necks and fall below the threshold.
 */
function refinePose(piece, labels, w, h) {
  const { id, bbox } = piece;
  const xs = [], ys = [], bx = [], by = [];
  for (let y = bbox.y0; y <= bbox.y1; y++) for (let x = bbox.x0; x <= bbox.x1; x++) {
    const p = y * w + x;
    if (labels[p] !== id) continue;
    xs.push(x); ys.push(y);
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
      labels[p - 1] !== id || labels[p + 1] !== id || labels[p - w] !== id || labels[p + w] !== id) { bx.push(x); by.push(y); }
  }
  // outline normals: direction from the boundary pixel to the centroid of nearby inside pixels
  const BINS = 90, hist = new Float64Array(BINS), R = 3;
  for (let k = 0; k < bx.length; k++) {
    let sx = 0, sy = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = bx[k] + dx, y = by[k] + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || labels[y * w + x] !== id) continue;
      sx += dx; sy += dy;
    }
    if (Math.hypot(sx, sy) < 1) continue;
    let t = (Math.atan2(sy, sx) * 4) % (2 * Math.PI);
    if (t < 0) t += 2 * Math.PI;
    hist[Math.floor((t / (2 * Math.PI)) * BINS) % BINS] += 1;
  }
  const sm = new Float64Array(BINS);
  const kern = [1, 3, 5, 3, 1];
  for (let i = 0; i < BINS; i++) for (let j = -2; j <= 2; j++) sm[i] += hist[(i + j + BINS) % BINS] * kern[j + 2];
  let pk = 0;
  for (let i = 1; i < BINS; i++) if (sm[i] > sm[pk]) pk = i;
  const l = sm[(pk - 1 + BINS) % BINS], c = sm[pk], r = sm[(pk + 1) % BINS];
  const den = l - 2 * c + r;
  const off = den !== 0 ? (0.5 * (l - r)) / den : 0;
  let ang = (((pk + 0.5 + off) / BINS) * 2 * Math.PI) / 4; // in [0, pi/2)

  // width profiles along the two piece axes
  const cx0 = piece.cx, cy0 = piece.cy;
  const span = Math.ceil(Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0)) + 4;
  const pu = new Float32Array(2 * span + 1), pv = new Float32Array(2 * span + 1);
  const profiles = (a) => {
    pu.fill(0); pv.fill(0);
    const cos = Math.cos(a), sin = Math.sin(a);
    for (let k = 0; k < xs.length; k++) {
      const dx = xs[k] - cx0, dy = ys[k] - cy0;
      pu[Math.round(dx * cos + dy * sin) + span]++;
      pv[Math.round(-dx * sin + dy * cos) + span]++;
    }
  };
  // refine: straight core edges aligned with the axes give the sharpest steps in the profiles
  const sharp = (a) => {
    profiles(a);
    let e = 0;
    for (let i = 1; i < pu.length; i++) { const du = pu[i] - pu[i - 1], dv = pv[i] - pv[i - 1]; e += du * du + dv * dv; }
    return e;
  };
  const D = Math.PI / 180;
  for (const [range, step] of [[12, 1], [1, 0.2]]) {
    let best = ang, bestE = -1;
    for (let d = -range; d <= range + 1e-9; d += step) {
      const e = sharp(ang + d * D);
      if (e > bestE) { bestE = e; best = ang + d * D; }
    }
    ang = best;
  }
  ang = ((ang % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
  profiles(ang);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const range = (prof) => {
    const nz = Array.from(prof).filter((v) => v > 0).sort((a, b) => a - b);
    const thr = 0.55 * (nz[nz.length >> 1] || 0);
    let a = -1, b = -1;
    for (let i = 0; i < prof.length; i++) if (prof[i] >= thr) { if (a < 0) a = i; b = i; }
    return a < 0 ? [0, 0] : [a - span - 0.5, b - span + 0.5];
  };
  const [u0, u1] = range(pu), [v0, v1] = range(pv);
  const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
  piece.cx = cx0 + uc * cos - vc * sin;
  piece.cy = cy0 + uc * sin + vc * cos;
  piece.angle = ang;
  piece.ownSide = (u1 - u0 + (v1 - v0)) / 2;
}
