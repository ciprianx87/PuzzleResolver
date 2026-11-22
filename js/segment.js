// Foreground/background segmentation and piece extraction.
import { toLab, getImageData, otsu, median, scaleCanvas } from './imageutil.js';
import { pieceProfiles, straighten, classify } from './outline.js';

const WL = 0.5; // weight of lightness differences (shadows / uneven light)
export const SHAPE = { rMin: 0.6, rMax: 1.6, fitDrop: 0.18, fitMin: 0.45 }; // piece plausibility limits

function labDist(lab, i, L, a, b) {
  const dL = lab[i] - L, da = lab[i + 1] - a, db = lab[i + 2] - b;
  return Math.sqrt(WL * dL * dL + da * da + db * db);
}

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

/**
 * The most common colour of the image: the cloth/table the pieces lie on. Unlike the border colour this still
 * works when the photo also shows the floor, a chair or the puzzle box around the cloth.
 * Returns { color: [L, a, b], spread } where spread is a robust size of the colour cluster.
 */
export function dominantColor(lab, w, h, skip = null) {
  const LB = 12, AB = 24; // bins: L 0..100 in 12, a/b -96..96 in 24 (8 units each)
  const hist = new Float32Array(LB * AB * AB);
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 120000)));
  // skip (optional Uint8Array): pixels to ignore, e.g. the puzzle itself when looking for the surface around it
  const use = (x, y) => !skip || !skip[y * w + x];
  const bin = (i) => {
    const l = Math.min(LB - 1, Math.max(0, Math.floor(lab[i] / (100 / LB))));
    const a = Math.min(AB - 1, Math.max(0, Math.floor((lab[i + 1] + 96) / 8)));
    const b = Math.min(AB - 1, Math.max(0, Math.floor((lab[i + 2] + 96) / 8)));
    return (l * AB + a) * AB + b;
  };
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (use(x, y)) hist[bin((y * w + x) * 3)]++;
  // peak of the 3x3x3-smoothed histogram
  let best = 0, bi = 0;
  for (let l = 0; l < LB; l++) for (let a = 0; a < AB; a++) for (let b = 0; b < AB; b++) {
    let s = 0;
    for (let dl = -1; dl <= 1; dl++) for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) {
      const L = l + dl, A = a + da, B = b + db;
      if (L < 0 || A < 0 || B < 0 || L >= LB || A >= AB || B >= AB) continue;
      s += hist[(L * AB + A) * AB + B];
    }
    if (s > best) { best = s; bi = (l * AB + a) * AB + b; }
  }
  const pl = Math.floor(bi / (AB * AB)), pa = Math.floor(bi / AB) % AB, pb = bi % AB;
  // refine: mean of pixels in the peak neighbourhood, then robust spread around it
  let sL = 0, sA = 0, sB = 0, n = 0;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (!use(x, y)) continue;
    const i = (y * w + x) * 3, k = bin(i);
    const l = Math.floor(k / (AB * AB)), a = Math.floor(k / AB) % AB, b = k % AB;
    if (Math.abs(l - pl) <= 1 && Math.abs(a - pa) <= 1 && Math.abs(b - pb) <= 1) { sL += lab[i]; sA += lab[i + 1]; sB += lab[i + 2]; n++; }
  }
  if (!n) return { color: [50, 0, 0], spread: 6 };
  const color = [sL / n, sA / n, sB / n];
  const near = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    if (!use(x, y)) continue;
    const d = labDist(lab, (y * w + x) * 3, color[0], color[1], color[2]);
    if (d < 30) near.push(d);
  }
  return { color, spread: near.length ? percentile(near, 0.8) : 6 };
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
function backgroundDistance(lab, w, h, seed, seedThr) {
  const [L0, a0, b0] = seed;
  const n = w * h;
  const d0 = new Float32Array(n);
  for (let p = 0; p < n; p++) d0[p] = labDist(lab, p * 3, L0, a0, b0);

  // first guess of what is background
  let t0 = seedThr;
  if (!t0) {
    const sub = [];
    for (let p = 0; p < n; p += 7) sub.push(d0[p]);
    t0 = Math.max(6, otsu(sub));
  }

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

/**
 * Binary foreground mask.
 *  mode 'border':   background = colour along the image border (a box lid lying on a table).
 *  mode 'dominant': background = the most common colour of the image (the cloth the pieces lie on). Works when the
 *                   photo also shows floor, chairs, the box... around the cloth.
 */
export function foregroundMask(canvas, sens = 1, mode = 'border', surface = null) {
  const w = canvas.width, h = canvas.height;
  const lab = toLab(getImageData(canvas));
  let dist, thr;
  if (mode === 'dominant') {
    // surface: optional known cloth colour ({color, spread}), e.g. learned from around the built puzzle
    const dom = surface || dominantColor(lab, w, h);
    const t0 = Math.min(35, Math.max(8, dom.spread * 2.5));
    dist = backgroundDistance(lab, w, h, dom.color, t0);
    // typical cloth deviation: the median of the near-cloth pixels. (A high percentile would be inflated by
    // other surfaces of similar colour, like a dark table or chair at the edge of the photo.)
    const near = [];
    for (let p = 0; p < w * h; p += 5) if (dist[p] < t0) near.push(dist[p]);
    const typical = near.length ? percentile(near, 0.5) : 4;
    thr = Math.max(typical * 6, 10) / sens;
  } else {
    dist = backgroundDistance(lab, w, h, borderColor(lab, w, h));
    const sub = [];
    for (let p = 0; p < w * h; p += 5) sub.push(dist[p]);
    const bsub = [];
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      if (x < band || y < band || x >= w - band || y >= h - band) bsub.push(dist[y * w + x]);
    }
    const noise = bsub.length ? percentile(bsub, 0.9) : 4;
    // a busy border (box print, text) inflates the noise estimate: never let it override the Otsu split
    const o = otsu(sub);
    thr = Math.max(Math.min(noise * 2.2, o * 0.85), o * 0.5, 5) / sens;
  }
  let mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) mask[p] = dist[p] > thr ? 1 : 0;
  const r = Math.max(1, Math.round(Math.min(w, h) / 600));
  mask = dilate(erode(mask, w, h, r), w, h, r); // open: remove lint / speckle
  // close (fill cracks) only for box/built photos: on a cloth full of pieces it would glue neighbours together
  if (mode === 'border') mask = erode(dilate(mask, w, h, r), w, h, r);
  if (mode === 'border') fillHoles(mask, w, h);
  return { mask, lab, w, h, thr };
}

/**
 * Find the puzzle (or box picture) region as the largest foreground blob and return its 4 corners.
 * Returns null if nothing convincing is found.
 */
export function autoQuad(canvas, mode = 'border') {
  const small = scaleCanvas(canvas, 420);
  const s = canvas.width / small.width;
  let { mask, w, h } = foregroundMask(small, 1, mode);
  if (mode === 'dominant') {
    // the assembled border encloses the cloth inside it: fill that, then strip off loose pieces lying around
    // (anything thinner than a few pieces) so only the solid puzzle area is left
    fillHoles(mask, w, h);
    const r = Math.max(3, Math.round(Math.min(w, h) * 0.035));
    mask = dilate(erode(mask, w, h, r), w, h, r);
  }
  const { comps, labels } = components(mask, w, h);
  if (!comps.length) return null;
  // prefer a big blob that doesn't touch the photo edge; else the biggest one (the picture may fill the photo)
  comps.sort((a, b) => b.area - a.area);
  const big = comps.find((c) => !c.border && c.area >= w * h * 0.08) || comps[0];
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

/** Typical piece area: median, re-estimated a few times while ignoring specks and big blobs. */
function typicalArea(areas) {
  if (!areas.length) return 0;
  let m = median(areas);
  for (let it = 0; it < 4; it++) {
    const keep = areas.filter((a) => a > m * 0.3 && a < m * 5);
    if (!keep.length) break;
    m = median(keep);
  }
  return m;
}

/** Fill background regions enclosed by foreground that are smaller than maxArea (dark print inside a piece). */
function fillSmallHoles(mask, w, h, maxArea) {
  const inv = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
  const { labels, comps } = components(inv, w, h);
  const fill = new Uint8Array(comps.length + 1);
  for (const c of comps) if (!c.border && c.area < maxArea) fill[c.id] = 1;
  for (let p = 0; p < w * h; p++) if (fill[labels[p]]) mask[p] = 1;
}

/** Chamfer distance transform of a binary mask (distance to the nearest 0 pixel or image edge), in pixels. */
function distanceTransform(m, w, h) {
  const d = new Float32Array(w * h);
  const INF = 1e9;
  for (let p = 0; p < w * h; p++) d[p] = m[p] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (!d[p]) continue;
    let v = d[p];
    v = Math.min(v, x > 0 ? d[p - 1] + 3 : 3, y > 0 ? d[p - w] + 3 : 3);
    if (y > 0) { if (x > 0) v = Math.min(v, d[p - w - 1] + 4); if (x < w - 1) v = Math.min(v, d[p - w + 1] + 4); }
    d[p] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x;
    if (!d[p]) continue;
    let v = d[p];
    v = Math.min(v, x < w - 1 ? d[p + 1] + 3 : 3, y < h - 1 ? d[p + w] + 3 : 3);
    if (y < h - 1) { if (x < w - 1) v = Math.min(v, d[p + w + 1] + 4); if (x > 0) v = Math.min(v, d[p + w - 1] + 4); }
    d[p] = v;
  }
  for (let p = 0; p < w * h; p++) d[p] /= 3;
  return d;
}

/**
 * Split a blob of touching pieces at its narrow necks: the thick cores of the pieces become seeds and every pixel
 * goes to the nearest seed (geodesic). Returns new components (labels updated in place) or null if not split.
 */
function splitCluster(c, labels, w, h, side, nextId) {
  const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
  const m = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) m[y * bw + x] = labels[(y + c.minY) * w + x + c.minX] === c.id ? 1 : 0;
  const dt = distanceTransform(m, bw, bh);
  // try several core thicknesses and keep the level that yields the most seeds (cores vary: blanks thin them)
  let seeds = null, good = [];
  const seedMask = new Uint8Array(bw * bh);
  for (const k of [0.2, 0.26, 0.32, 0.38, 0.44, 0.5]) {
    const T = side * k;
    for (let p = 0; p < bw * bh; p++) seedMask[p] = dt[p] >= T ? 1 : 0;
    const sc = components(seedMask, bw, bh);
    const g = sc.comps.filter((q) => q.area >= side * side * 0.015);
    if (g.length > good.length) { seeds = sc; good = g; }
  }
  if (good.length < 2) return null;
  // multi-source BFS from the seeds through the blob
  const owner = new Int32Array(bw * bh).fill(-1);
  const queue = new Int32Array(bw * bh);
  let qh = 0, qt = 0;
  const seedIdx = new Map(good.map((s, i) => [s.id, i]));
  for (let p = 0; p < bw * bh; p++) {
    const k = seedIdx.get(seeds.labels[p]);
    if (k !== undefined) { owner[p] = k; queue[qt++] = p; }
  }
  while (qh < qt) {
    const p = queue[qh++], x = p % bw, y = (p / bw) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1];
    for (const q of nb) if (q >= 0 && m[q] && owner[q] < 0) { owner[q] = owner[p]; queue[qt++] = q; }
  }
  const out = good.map((_, i) => ({ id: nextId + i, area: 0, sx: 0, sy: 0, minX: w, minY: h, maxX: 0, maxY: 0, border: false }));
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const p = y * bw + x;
    if (!m[p] || owner[p] < 0) continue;
    const o = out[owner[p]], gx = x + c.minX, gy = y + c.minY;
    labels[gy * w + gx] = o.id;
    o.area++; o.sx += gx; o.sy += gy;
    if (gx < o.minX) o.minX = gx; if (gx > o.maxX) o.maxX = gx; if (gy < o.minY) o.minY = gy; if (gy > o.maxY) o.maxY = gy;
  }
  return out.filter((o) => o.area).map((o) => ({ ...o, cx: o.sx / o.area, cy: o.sy / o.area }));
}

/**
 * Segment loose pieces lying on a cloth. Returns { pieces, clusters, labels, lab, w, h, info }.
 * Each piece: { id, area, cx, cy (core centre), side (core size), angle (core orientation, radians), bbox }.
 * clusters are blobs of touching pieces that could not be separated (shown to the user, not matched).
 */
export function segmentPieces(canvas, sens = 1, surface = null, pieceArea = 0) {
  // pieceArea (optional): known area of one piece in pixels (e.g. from the grid in the built photo). Without it
  // the typical blob size is used, which fails when the photo holds few loose pieces.
  const { mask, lab, w, h, thr } = foregroundMask(canvas, sens, 'dominant', surface);
  const minArea = w * h * 0.00006;
  let { labels, comps } = components(mask, w, h);
  let med = pieceArea || typicalArea(comps.filter((c) => !c.border && c.area >= minArea).map((c) => c.area));
  const empty = { pieces: [], clusters: [], labels, mask, lab, w, h, looseIds: new Set(), info: { thr, medArea: med, rejected: comps.length } };
  if (!med) return empty;

  // dark print inside a piece can look like the cloth: fill such small holes, then label again
  fillSmallHoles(mask, w, h, med * 0.25);
  ({ labels, comps } = components(mask, w, h));
  if (!pieceArea) med = typicalArea(comps.filter((c) => !c.border && c.area >= minArea).map((c) => c.area));
  const side = Math.sqrt(med) * 0.9;

  // things that are not pieces: touching the photo edge (floor, chair, box) or huge (assembled parts)
  const bad = new Uint8Array(comps.length + 1);
  for (const c of comps) if (c.border || c.area > med * 10) bad[c.id] = 1;

  // a loose piece must be (mostly) surrounded by cloth, not by the floor or the assembled puzzle
  const gap = Math.max(2, Math.round(side * 0.06));
  const enclosed = (c) => {
    let felt = 0, badN = 0, tot = 0;
    for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * w + x] !== c.id) continue;
      for (const [dx, dy] of [[gap, 0], [-gap, 0], [0, gap], [0, -gap]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) { badN++; tot++; continue; }
        const l = labels[Y * w + X];
        if (l === c.id) continue;
        tot++;
        if (!l) felt++; else if (bad[l]) badN++;
      }
    }
    return tot && badN / tot < 0.15 && felt / tot > 0.4;
  };

  let nextId = comps.length + 1;
  const pieceComps = [], clusters = [];
  let rejected = 0;
  const why = { bad: 0, small: 0, enclosure: 0 };
  for (const c of comps) {
    if (bad[c.id]) { rejected++; why.bad++; continue; }
    if (c.area < Math.max(minArea, med * 0.35)) { rejected++; why.small++; continue; }
    // groups of touching pieces are mostly surrounded by other pieces of the group: only check single pieces
    if (c.area <= med * 1.7 && !enclosed(c)) { rejected++; why.enclosure++; continue; }
    if (c.area <= med * 1.7) { pieceComps.push(c); continue; }
    // split; parts that are still too big get another try (their own best seed level may differ)
    let todo = [c];
    for (let round = 0; round < 3; round++) {
      const next = [];
      for (const q of todo) {
        const parts = splitCluster(q, labels, w, h, side, nextId);
        if (!parts) { next.push(q); continue; }
        nextId += parts.length;
        for (const part of parts) {
          if (part.area < med * 0.35) continue;
          if (part.area <= med * 1.7) pieceComps.push(part); else next.push(part);
        }
      }
      todo = next;
      if (!todo.length) break;
    }
    clusters.push(...todo);
  }

  const pieces = pieceComps.map((c, k) => {
    const piece = {
      id: c.id, idx: k, area: c.area, cx: c.cx, cy: c.cy,
      side, angle: 0, bbox: { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY },
    };
    refinePose(piece, labels, w, h);
    return piece;
  });
  // all pieces of a puzzle have (nearly) the same core size: blend each estimate with the median
  let kept = pieces;
  const looseIds = new Set();
  if (pieces.length) {
    const medSide = median(pieces.map((p) => p.ownSide));
    for (const p of pieces) p.side = 0.5 * medSide + 0.5 * Math.min(Math.max(p.ownSide, medSide * 0.8), medSide * 1.2);
    // shape check: a jigsaw piece has a square core of the typical size that its outline mostly fills
    // (relative to this photo's typical fit: small pieces in a far-away photo fit less crisply)
    for (const p of pieces) p.fit = squareCoverage(labels, w, h, p.id, p.cx, p.cy, p.side * 0.85, p.angle);
    const fitLimit = Math.max(SHAPE.fitMin, median(pieces.map((p) => p.fit)) - SHAPE.fitDrop);
    kept = pieces.filter((p) => {
      const r = p.ownSide / medSide;
      const ok = r > SHAPE.rMin && r < SHAPE.rMax && p.fit > fitLimit;
      if (!ok) why.shape = (why.shape || 0) + 1;
      return ok;
    });
    const assembled = assembledPieces(kept, medSide);
    why.assembled = assembled.size;
    kept = kept.filter((p) => !assembled.has(p));
    kept.forEach((p, k) => (p.idx = k));
    for (const p of kept) Object.assign(p, sideShapes(p, labels, w, h));
    // everything loose (kept pieces, odd-shaped blobs, unsplit groups), as opposed to assembled sections
    for (const p of pieces) if (!assembled.has(p)) looseIds.add(p.id);
  }
  for (const c of clusters) looseIds.add(c.id);
  return {
    pieces: kept, labels, mask, lab, w, h, looseIds,
    clusters: clusters.map((c) => ({ id: c.id, bbox: { x0: c.minX, y0: c.minY, x1: c.maxX, y1: c.maxY } })),
    info: { thr, medArea: med, rejected, why },
  };
}

// side order in a piece's own frame: top, right, bottom, left (as unit vectors in (u, v) = (right, down))
/**
 * Outline of each side of a piece (in its own frame, at piece.angle): straightened profiles (see outline.js) and
 * the side types derived from them: 'T' tab, 'B' blank, 'F' flat (border piece) or null when unclear.
 */
export function sideShapes(piece, labels, w, h) {
  const profiles = pieceProfiles(piece, labels, w, h).map(straighten);
  return { profiles, sides: profiles.map(classify) };
}

/** Fraction of a rotated square (side s, centre cx,cy, angle a) covered by the component `id`. */
function squareCoverage(labels, w, h, id, cx, cy, s, a) {
  const N = 12, cos = Math.cos(a), sin = Math.sin(a);
  let hit = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const u = ((i + 0.5) / N - 0.5) * s, v = ((j + 0.5) / N - 0.5) * s;
    const x = Math.round(cx + u * cos - v * sin), y = Math.round(cy + u * sin + v * cos);
    if (x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id) hit++;
  }
  return hit / (N * N);
}

/**
 * Pieces that are part of an assembled section (e.g. the border lying in the photo): they sit edge to edge on a
 * grid with the same orientation as their neighbours. Loose pieces lie at random positions and angles.
 * A piece aligned with 2+ neighbours is assembled; that status then spreads to aligned neighbours (row ends).
 */
function assembledPieces(pieces, side) {
  const angDiff = (a, b) => {
    const d = (((a - b) * 180) / Math.PI) % 90;
    return Math.abs(((d + 135) % 90) - 45);
  };
  const aligned = pieces.map(() => []);
  // spatial hash for neighbour lookup
  const cell = side * 1.3, grid = new Map();
  const key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  pieces.forEach((p, i) => { const k = key(p.cx, p.cy); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  pieces.forEach((p, i) => {
    const gx = Math.floor(p.cx / cell), gy = Math.floor(p.cy / cell);
    const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) {
        if (j === i) continue;
        const q = pieces[j];
        if (angDiff(p.angle, q.angle) > 7) continue;
        const ox = q.cx - p.cx, oy = q.cy - p.cy;
        const u = Math.abs(ox * cos + oy * sin), v = Math.abs(-ox * sin + oy * cos);
        const along = Math.max(u, v), across = Math.min(u, v);
        if (along > side * 0.8 && along < side * 1.25 && across < side * 0.2) aligned[i].push(j);
      }
    }
  });
  const out = new Set();
  pieces.forEach((p, i) => { if (aligned[i].length >= 2) out.add(p); });
  let grew = true;
  while (grew) {
    grew = false;
    pieces.forEach((p, i) => {
      if (!out.has(p) && aligned[i].some((j) => out.has(pieces[j]))) { out.add(p); grew = true; }
    });
  }
  return out;
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
