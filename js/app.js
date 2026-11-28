import { loadImage, toLab, getImageData, tick } from './imageutil.js';
import { warpQuad, quadAspect, rectifiedSize, rectCorners, homography, invertH, applyH } from './geometry.js';
import { homographyMap, frameMap, warpGrid } from './gridmap.js';
import { QuadEditor } from './quadeditor.js';
import { autoQuad, segmentPieces, dominantColor } from './segment.js';
import {
  gridDescriptors, shiftedGridDescriptors, detectFilled, filledFromCoverage, cellRequirements, photoCalibration, completeBorderSides, borderCells, DETECT_INNER,
  describePieces, scoreAll, solveAll,
} from './match.js';
import { renderSolution, renderFilled, renderPieces, matchCard, renderPreview, isLow } from './render.js';
import * as store from './store.js';
import { generateDemo } from './demo.js';
import { boxModel, templateScores, clothColour } from './template.js';
import { growSolve } from './grow.js';

const $ = (s) => document.querySelector(s);

// Resolves once the saved photos are restored. Created first, so event handlers registered below can always wait
// on it (the restore itself runs at the very end, once every handler is in place).
let markBooted;
const booted = new Promise((resolve) => { markBooted = resolve; });
// processing resolution (originals are stored untouched); pieces of a 1000-piece puzzle need the extra pixels
const MAXDIM = { box: 1600, built: 2000, pieces: 2400 };

// What is persisted is only what the USER provided: the original photos (full resolution, untouched),
// corner positions (normalised 0..1, independent of processing resolution), grid size, manual cell corrections
// and the positions of pieces they placed. Everything the algorithm computes (filled detection, piece
// segmentation, matches) is recomputed on load, so an improved algorithm applies to photos already taken.
const STATE_VERSION = 3;

const state = {
  img: { box: null, built: null },  // processing canvases (downscaled from the originals)
  shots: [],                        // loose-pieces photos: [{ id, img }]
  curShot: null,                    // id of the pieces photo shown in step 3
  quad: { box: null, built: null }, // pixel coords in state.img[key]
  boxOriented: false,               // has the box picture's rotation been matched to the built puzzle?
  cols: 25, rows: 20, count: 500,
  filled: null,       // derived: automatic detection + overrides
  overrides: {},      // cell index -> 0/1, set by the user (taps, "I placed these")
  placedPts: [],      // [{shot, u, v, cell, angle}] normalised centres of loose pieces the user placed, and where
  sens: 1,
  gray: false,                      // grey-scale matching: shapes and lines continuing from nearby pieces
  grow: false,                      // grow outwards from the assembled pieces, piece by piece (with backtracking)
};
let cache = {};
const newId = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- UI helpers
const busyEl = $('#busy'), busyText = $('#busy-text');
let busyDepth = 0; // nested busy() calls keep the overlay up until the outermost one ends
async function busy(text, fn) {
  busyText.textContent = text; busyEl.hidden = false; busyDepth++;
  await tick(); await new Promise(requestAnimationFrame);
  try { return await fn(); }
  catch (e) { console.error(e); toast('Error: ' + e.message); }
  finally { if (--busyDepth === 0) busyEl.hidden = true; }
}
async function progress(text) { busyText.textContent = text; await tick(); await new Promise(requestAnimationFrame); }
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- persistence
const normQuad = (q, c) => (q && c ? q.map((p) => ({ u: p.x / c.width, v: p.y / c.height })) : null);
const denormQuad = (q, c) => (q && c ? q.map((p) => ({ x: p.u * c.width, y: p.v * c.height })) : null);

function saveState() {
  const { cols, rows, count, sens, overrides, placedPts, boxOriented, curShot, gray, grow } = state;
  store.put('state', {
    version: STATE_VERSION, cols, rows, count, sens, overrides, placedPts, boxOriented, curShot, gray, grow,
    shotIds: state.shots.map((s) => s.id),
    quad: { box: normQuad(state.quad.box, state.img.box), built: normQuad(state.quad.built, state.img.built) },
  });
}

/** Keep the original photo exactly as the user provided it. */
async function saveOriginal(key, blob) {
  await store.put('orig-' + key, blob);
  await store.del('img-' + key); // legacy downscaled copy
  requestPersistence();
}

let persistAsked = false;
function requestPersistence() {
  // ask the browser not to evict our storage under pressure (granted silently on most mobile browsers)
  if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
  persistAsked = true;
  navigator.storage.persisted().then((p) => p || navigator.storage.persist()).catch(() => {});
}

async function restore() {
  const s = await store.get('state');
  for (const k of ['box', 'built']) {
    const b = (await store.get('orig-' + k)) || (await store.get('img-' + k));
    if (b) state.img[k] = await loadImage(b, MAXDIM[k]);
  }
  // pieces photos (versions < 3 had a single one stored as "pieces")
  let shotIds = s && s.shotIds;
  if (!shotIds) {
    const legacy = (await store.get('orig-pieces')) || (await store.get('img-pieces'));
    shotIds = [];
    if (legacy) {
      await store.put('orig-shot-s1', legacy);
      await store.del('orig-pieces'); await store.del('img-pieces');
      shotIds = ['s1'];
    }
  }
  for (const id of shotIds) {
    const b = await store.get('orig-shot-' + id);
    if (b) state.shots.push({ id, img: await loadImage(b, MAXDIM.pieces) });
  }
  if (!s) return false;
  Object.assign(state, {
    cols: s.cols ?? state.cols, rows: s.rows ?? state.rows, count: s.count ?? state.count, sens: s.sens ?? 1,
    boxOriented: !!s.boxOriented, gray: !!s.gray, grow: !!s.grow,
  });
  state.curShot = state.shots.some((x) => x.id === s.curShot) ? s.curShot : state.shots[0]?.id ?? null;
  if ((s.version || 1) >= 2) {
    state.quad = { box: denormQuad(s.quad.box, state.img.box), built: denormQuad(s.quad.built, state.img.built) };
    state.overrides = s.overrides || {};
    state.placedPts = (s.placedPts || []).map((p) => ({ shot: shotIds[0], ...p }));
  } else if (s.quad) {
    // v1 stored pixel corners of the downscaled image, which is what we just loaded
    state.quad = { box: s.quad.box, built: s.quad.built };
  }
  if (state.img.box || state.img.built || state.shots.length) requestPersistence();
  return true;
}

// ---------------------------------------------------------------- invalidation
function invalidate(what) {
  const deps = {
    box: ['ref', 'builtRect', 'filled', 'boxModel', 'scored'],
    grid: ['ref', 'builtRect', 'filled', 'boxModel', 'scored'],
    built: ['builtRect', 'filled', 'boxModel', 'scored'],
    pieces: ['segs', 'pieces', 'scored'],   // all pieces photos (e.g. sensitivity changed)
    shots: ['pieces', 'scored'],            // a photo was added/removed: keep the others' results
    filled: ['scored'],
  }[what] || ['ref', 'builtRect', 'filled', 'boxModel', 'segs', 'pieces', 'scored'];
  for (const d of deps) {
    if (d === 'filled') { state.filled = null; delete cache.filledAuto; }
    else delete cache[d];
  }
  refreshStepBadges();
}

/** A new photo / grid makes the user's earlier corrections meaningless. */
function forgetUserInput(what) {
  if (what === 'built' || what === 'grid') state.overrides = {};
  if (what === 'box' || what === 'built') state.boxOriented = false;
}

// ---------------------------------------------------------------- pipeline
const rotateQuad = (q, k) => q.map((_, i) => ({ ...q[(i + k) % 4] }));

function ensureRef() {
  if (cache.ref) return cache.ref;
  if (!state.img.box || !state.quad.box) throw new Error('Take the box photo first');
  const aspect = quadAspect(state.quad.box);
  const { w, h } = rectifiedSize(state.cols, state.rows, aspect);
  const canvas = warpQuad(state.img.box, state.quad.box, w, h);
  const lab = toLab(getImageData(canvas));
  cache.ref = { canvas, w, h, descs: gridDescriptors(lab, w, h, state.cols, state.rows),
    centre: gridDescriptors(lab, w, h, state.cols, state.rows, DETECT_INNER) };
  return cache.ref;
}

function ensureBuiltRect() {
  if (cache.builtRect) return cache.builtRect;
  if (!state.img.built || !state.quad.built) throw new Error('Take the photo of the built puzzle first');
  const ref = ensureRef(), { cols, rows } = state;
  const H = homography(rectCorners(cols, rows), state.quad.built);
  const b = { map: homographyMap(H), sides: null, traced: 0 };
  // structural detection: what is assembled puzzle (not cloth, not loose pieces) in the built photo?
  const surf = surfaceColor(state.img.built, state.quad.built);
  if (surf) {
    const q = state.quad.built, d = (a, c) => Math.hypot(a.x - c.x, a.y - c.y);
    const cellW = (d(q[0], q[1]) + d(q[3], q[2])) / 2 / cols, cellH = (d(q[0], q[3]) + d(q[1], q[2])) / 2 / rows;
    const seg = segmentPieces(state.img.built, 1, surf, cellW * cellH * 1.1);
    b.assembled = { mask: assembledMask(seg, H, Math.sqrt(cellW * cellH)), w: seg.w, h: seg.h };
    b.seg = { labels: seg.labels, mask: seg.mask, looseIds: seg.looseIds, w: seg.w, h: seg.h };
    b.lab = seg.lab; // the built photo in Lab: colours of the assembled neighbours (see edges.js)
    b.foreground = { mask: seg.mask, w: seg.w, h: seg.h };
    // a border side assembled from corner to corner is complete (judged on everything that isn't cloth: loose
    // pieces piled against the frame can make parts of it look loose); its traced outer edge then shapes the grid
    b.sides = completeBorderSides(b.foreground, H, cols, rows);
    const fm = frameMap(b.foreground, H, cols, rows, b.sides);
    b.map = fm.map; b.traced = fm.traced;
  }
  b.canvas = b.traced ? warpGrid(state.img.built, b.map, cols, rows, ref.w, ref.h) : warpQuad(state.img.built, state.quad.built, ref.w, ref.h);
  const lab = toLab(getImageData(b.canvas));
  b.centre = shiftedGridDescriptors(lab, ref.w, ref.h, cols, rows, DETECT_INNER);
  b.descs = gridDescriptors(lab, ref.w, ref.h, cols, rows);
  cache.builtRect = b;
  return b;
}

/**
 * Mask of the assembled puzzle in the built photo: everything that isn't cloth, minus the loose pieces. In a far
 * away photo the seams between assembled pieces look like cloth, so parts of the assembled border come apart into
 * piece-sized blobs that look loose. Those are taken back: a piece lined up with the grid (within a few degrees)
 * that touches the assembled part is assembled too. Loose pieces lie at random angles.
 */
function assembledMask(seg, H, cellPx) {
  const { w, h, labels, mask, looseIds } = seg;
  const asm = new Uint8Array(w * h);
  for (let p = 0; p < asm.length; p++) asm[p] = mask[p] && !looseIds.has(labels[p]) ? 1 : 0;
  const Hi = invertH(H);
  const gridAngle = (x, y) => {
    const g = applyH(Hi, x, y), a = applyH(H, g.x, g.y), b = applyH(H, g.x + 1, g.y);
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  const angDiff = (a, b) => { const d = (((a - b) * 180) / Math.PI) % 90; return Math.abs(((d + 135) % 90) - 45); };
  let cand = seg.pieces.filter((p) => angDiff(p.angle, gridAngle(p.cx, p.cy)) < 6);
  const gap = Math.max(2, Math.round(cellPx * 0.08));
  const touches = (p) => {
    const { x0, y0, x1, y1 } = p.bbox;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (labels[y * w + x] !== p.id) continue;
      for (let dy = -gap; dy <= gap; dy += gap) for (let dx = -gap; dx <= gap; dx += gap) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h && asm[Y * w + X]) return true;
      }
    }
    return false;
  };
  for (let grew = true; grew && cand.length;) {
    grew = false;
    const rest = [];
    for (const p of cand) {
      if (!touches(p)) { rest.push(p); continue; }
      const { x0, y0, x1, y1 } = p.bbox;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === p.id) asm[y * w + x] = 1;
      grew = true;
    }
    cand = rest;
  }
  return asm;
}

/**
 * Mask of the assembled puzzle for measuring the holes' outlines: the assembled mask plus any "loose" blob whose
 * centre lies in a filled cell (a chunk of the frame that came apart in the mask). Blobs lying in empty cells stay
 * out: those really are loose pieces resting where the hole is.
 */
function holeMask(b, filled) {
  const { labels, mask, looseIds, w, h } = b.seg, { cols, rows } = state;
  const sx = new Map(), sy = new Map(), n = new Map();
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || !looseIds.has(labels[p])) continue;
    const id = labels[p];
    sx.set(id, (sx.get(id) || 0) + (p % w)); sy.set(id, (sy.get(id) || 0) + ((p / w) | 0)); n.set(id, (n.get(id) || 0) + 1);
  }
  const centres = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) centres.push(b.map(c + 0.5, r + 0.5));
  const keep = new Set();
  for (const [id, k] of n) {
    const x = sx.get(id) / k, y = sy.get(id) / k;
    let best = -1, bd = Infinity;
    centres.forEach(([cx, cy], i) => { const d = (cx - x) ** 2 + (cy - y) ** 2; if (d < bd) { bd = d; best = i; } });
    if (best >= 0 && filled[best]) keep.add(id);
  }
  const out = b.assembled.mask.slice();
  for (let p = 0; p < w * h; p++) if (mask[p] && keep.has(labels[p])) out[p] = 1;
  return { mask: out, w, h };
}

/** Colour of the surface the puzzle lies on: the most common colour outside the puzzle's corners. */
function surfaceColor(img, quad) {
  const w = img.width, h = img.height;
  const lab = toLab(getImageData(img));
  const skip = new Uint8Array(w * h);
  // inside test for the (convex) quad
  const edges = quad.map((p, i) => [p, quad[(i + 1) % 4]]);
  const sign = Math.sign((quad[1].x - quad[0].x) * (quad[2].y - quad[0].y) - (quad[1].y - quad[0].y) * (quad[2].x - quad[0].x));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let inside = true;
    for (const [a, b] of edges) {
      if (Math.sign((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) === -sign) { inside = false; break; }
    }
    if (inside) skip[y * w + x] = 1;
  }
  let outside = 0;
  for (let p = 0; p < w * h; p++) if (!skip[p]) outside++;
  return outside > w * h * 0.03 ? dominantColor(lab, w, h, skip) : null;
}

/**
 * The box is often photographed sideways or upside down. Try the box picture in each orientation that fits the
 * built puzzle's shape and keep the one whose picture agrees best with the cells that are already assembled.
 */
function autoOrientBox() {
  if (state.boxOriented || !state.img.box || !state.img.built || !state.quad.box || !state.quad.built) return;
  const builtAspect = quadAspect(state.quad.built);
  const bw = 700;
  let best = null;
  for (let k = 0; k < 4; k++) {
    const q = rotateQuad(state.quad.box, k);
    const a = quadAspect(q);
    if (Math.abs(Math.log(builtAspect)) > 0.12 && (a > 1) !== (builtAspect > 1)) continue;
    let cols = state.cols, rows = state.rows;
    if (cols !== rows && (a > 1) !== (cols > rows)) [cols, rows] = [rows, cols];
    const { w, h } = rectifiedSize(cols, rows, builtAspect, bw);
    const refLab = toLab(getImageData(warpQuad(state.img.box, q, w, h)));
    const bLab = toLab(getImageData(warpQuad(state.img.built, state.quad.built, w, h)));
    const { dists } = detectFilled(shiftedGridDescriptors(bLab, w, h, cols, rows, DETECT_INNER),
      gridDescriptors(refLab, w, h, cols, rows, DETECT_INNER));
    const sorted = Array.from(dists).filter(Number.isFinite).sort((x, y) => x - y);
    const top = sorted.slice(0, Math.max(3, Math.floor(sorted.length * 0.25)));
    const score = top.reduce((s, v) => s + v, 0) / top.length;
    if (!best || score < best.score) best = { k, q, cols, rows, score };
  }
  state.boxOriented = true;
  if (!best || best.k === 0) return;
  state.quad.box = best.q;
  editors.box.setQuad(best.q);
  if (best.cols !== state.cols) setGrid(best.cols, best.rows, state.count);
  invalidate('box');
  saveState();
  toast('The box photo was turned to match your puzzle. Use ↻ in step 1 if that is wrong.');
}

function ensureFilled() {
  autoOrientBox();
  if (!cache.filledAuto || cache.filledAuto.length !== state.cols * state.rows) {
    const ref = ensureRef(), b = ensureBuiltRect();
    if (b.assembled) {
      cache.filledAuto = filledFromCoverage(b.assembled.mask, b.assembled.w, b.assembled.h, b.map, state.cols, state.rows).filled;
      // complete border sides are filled, even where the mask lost a piece that looks like the cloth
      for (const i of borderCells(b.sides, state.cols, state.rows)) cache.filledAuto[i] = 1;
      b.holeMask = holeMask(b, cache.filledAuto);
    } else {
      cache.filledAuto = detectFilled(b.centre, ref.centre).filled;
    }
    state.filled = null;
  }
  if (!state.filled) {
    state.filled = cache.filledAuto.slice();
    for (const [i, v] of Object.entries(state.overrides)) if (+i < state.filled.length) state.filled[+i] = v ? 1 : 0;
  }
  return state.filled;
}

function setCell(i, v) {
  state.filled[i] = v;
  if (cache.filledAuto && cache.filledAuto[i] === v) delete state.overrides[i];
  else state.overrides[i] = v;
}

/** Segment every pieces photo (cached per photo) and pool their pieces. */
async function ensurePieces() {
  if (cache.pieces) return cache.pieces;
  if (!state.shots.length) throw new Error('Take a photo of the loose pieces first');
  if (!cache.segs) cache.segs = new Map();
  for (const id of [...cache.segs.keys()]) if (!state.shots.some((s) => s.id === id)) cache.segs.delete(id);
  for (let i = 0; i < state.shots.length; i++) {
    const shot = state.shots[i];
    if (cache.segs.has(shot.id)) continue;
    await progress(`Finding pieces in photo ${i + 1} of ${state.shots.length}…`);
    const seg = segmentPieces(shot.img, state.sens);
    for (const p of seg.pieces) p.shot = shot.id;
    describePieces(seg);
    cache.segs.set(shot.id, seg);
  }
  if (state.shots.some((s) => !cache.segs.has(s.id))) return ensurePieces(); // photos changed meanwhile
  const pieces = state.shots.flatMap((s) => cache.segs.get(s.id).pieces);
  pieces.forEach((p, i) => (p.idx = i));
  cache.pieces = pieces;
  return pieces;
}

function shotsMap() {
  const m = new Map();
  state.shots.forEach((s, i) => m.set(s.id, { img: s.img, seg: cache.segs && cache.segs.get(s.id), label: `photo ${i + 1}` }));
  return m;
}
const shotImg = (id) => state.shots.find((s) => s.id === id)?.img;

/** Detected pieces the user has already placed (matched by position in their photo, not by detection order). */
function placedPieces() {
  const out = [];
  if (!cache.segs) return out;
  for (const pt of state.placedPts) {
    const seg = cache.segs.get(pt.shot), img = shotImg(pt.shot);
    if (!seg || !img) continue;
    const x = pt.u * img.width, y = pt.v * img.height;
    let best = null, bd = Infinity;
    for (const p of seg.pieces) { const d = Math.hypot(p.cx - x, p.cy - y); if (d < bd) { bd = d; best = p; } }
    if (best && bd < best.side * 0.6) out.push({ piece: best, pt });
  }
  return out;
}
const placedPieceIdx = () => new Set(placedPieces().map((x) => x.piece.idx));

function emptyCells() {
  const f = ensureFilled();
  const out = [];
  for (let i = 0; i < f.length; i++) if (!f[i]) out.push(i);
  return out;
}

async function ensureScored() {
  if (cache.scored) return cache.scored;
  const pieces = await ensurePieces();
  const ref = ensureRef();
  let empty = emptyCells();
  await progress(`Comparing ${pieces.length} pieces with ${empty.length} empty cells…`);
  const b = ensureBuiltRect();
  const hm = b.holeMask || b.assembled;
  const needs = cellRequirements(empty, state.cols, state.rows, state.filled, cache.filledAuto, hm && { ...hm, lab: b.lab }, b.map);
  // compare pieces with the box picture as it looks photographed on the table (learned from the assembled cells)
  const assembledCells = [];
  for (let i = 0; i < cache.filledAuto.length; i++) if (cache.filledAuto[i]) assembledCells.push(i);
  // grey-scale mode works from the assembled puzzle outwards: only the gaps next to assembled pieces, where the
  // shape of the hole and the lines of the neighbours tell where a piece goes
  if (state.gray && !state.grow && needs) { // (growing reaches further gaps itself)
    const front = empty.filter((c) => { const n = needs.get(c); return n && n.line && n.line.some(Boolean); });
    if (front.length >= Math.min(pieces.length, 10)) empty = front;
  }
  const cal = photoCalibration(ref.descs, b.descs, assembledCells);
  // the picture term: each piece's template slid over the box picture, bent onto the puzzle (see template.js)
  if (!cache.boxModel) {
    await progress('Lining up the box picture with your puzzle…');
    cache.boxModel = boxModel(ref.canvas, b.canvas, assembledCells, state.cols, state.rows);
  }
  const refCloth = b.lab && b.seg ? clothColour(b.lab, b.seg.labels, b.seg.w, b.seg.h) : null;
  const appear = await templateScores(pieces, cache.boxModel, empty, refCloth,
    (i, n) => progress(`Comparing pieces with the box picture: ${i} of ${n}…`), state.gray);
  cache.scored = scoreAll(pieces, cal ? ref.descs.map(cal) : ref.descs, empty, needs, undefined, undefined, appear);
  return cache.scored;
}

// ---------------------------------------------------------------- editors
const editors = {
  box: new QuadEditor($('#box-editor'), { onChange: (q) => { state.quad.box = q; invalidate('box'); saveState(); } }),
  built: new QuadEditor($('#built-editor'), { onChange: (q) => { state.quad.built = q; invalidate('built'); saveState(); showFilled(); } }),
};

function defaultQuad(c, inset = 0.06) {
  const w = c.width, h = c.height;
  return [{ x: w * inset, y: h * inset }, { x: w * (1 - inset), y: h * inset }, { x: w * (1 - inset), y: h * (1 - inset) }, { x: w * inset, y: h * (1 - inset) }];
}
const AUTO_MODE = { box: 'border', built: 'dominant' };

function showEditor(key) {
  const c = state.img[key];
  const wrap = $(`#${key}-editor-wrap`);
  if (!c) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (!state.quad[key]) state.quad[key] = autoQuad(c, AUTO_MODE[key]) || defaultQuad(c);
  editors[key].setImage(c, state.quad[key]);
  editors[key].setGrid(state.cols, state.rows);
}

// ---------------------------------------------------------------- grid settings
const elCount = $('#piece-count'), elCols = $('#grid-cols'), elRows = $('#grid-rows');
function syncGridInputs() { elCount.value = state.count; elCols.value = state.cols; elRows.value = state.rows; $('#solve-gray').checked = !!state.gray; $('#solve-grow').checked = !!state.grow; }
function gridFromCount() {
  const q = state.quad.built || state.quad.box;
  const aspect = q ? quadAspect(q) : 4 / 3;
  const n = Math.max(4, +elCount.value || 4);
  const cols = Math.max(2, Math.round(Math.sqrt(n * aspect)));
  const rows = Math.max(2, Math.round(n / cols));
  setGrid(cols, rows, n);
}
function setGrid(cols, rows, count = cols * rows) {
  if (cols === state.cols && rows === state.rows) { state.count = count; syncGridInputs(); saveState(); return; }
  state.cols = cols; state.rows = rows; state.count = count;
  syncGridInputs();
  invalidate('grid');
  forgetUserInput('grid');
  editors.box.setGrid(cols, rows); editors.built.setGrid(cols, rows);
  saveState();
}
elCount.addEventListener('change', gridFromCount);
elCols.addEventListener('change', () => setGrid(Math.max(2, +elCols.value || 2), state.rows));
elRows.addEventListener('change', () => setGrid(state.cols, Math.max(2, +elRows.value || 2)));

// ---------------------------------------------------------------- capture
document.querySelectorAll('input[type=file]').forEach((inp) => {
  inp.addEventListener('change', async () => {
    const files = [...(inp.files || [])];
    inp.value = '';
    if (!files.length) return;
    const key = inp.dataset.target;
    await busy('Loading photo…', async () => {
      await booted;
      if (key === 'pieces') {
        for (let i = 0; i < files.length; i++) {
          if (files.length > 1) await progress(`Loading photo ${i + 1} of ${files.length}…`);
          const id = newId();
          state.shots.push({ id, img: await loadImage(files[i], MAXDIM.pieces) });
          await saveOriginal('shot-' + id, files[i]);
          state.curShot = id;
        }
        invalidate('shots');
      } else {
        state.img[key] = await loadImage(files[0], MAXDIM[key]);
        state.quad[key] = null;
        invalidate(key);
        forgetUserInput(key);
        await saveOriginal(key, files[0]);
      }
      saveState();
      renderStep(currentStep);
    });
  });
});

document.querySelectorAll('[data-autocorners]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.autocorners;
  const q = autoQuad(state.img[key], AUTO_MODE[key]);
  if (!q) { toast('Could not find the edges automatically. Drag the corners instead.'); return; }
  state.quad[key] = q; editors[key].setQuad(q); invalidate(key); forgetUserInput(key === 'box' ? 'box' : 'built'); saveState();
  if (key === 'built') showFilled();
}));
document.querySelectorAll('[data-fullcorners]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.fullcorners;
  const c = state.img[key];
  const q = rectCorners(c.width, c.height);
  state.quad[key] = q; editors[key].setQuad(q); invalidate(key); saveState();
  if (key === 'built') showFilled();
}));
$('#btn-rotate-box').addEventListener('click', () => {
  if (!state.quad.box) return;
  // the box picture is turned 90°: relabel its corners and swap the grid's rows and columns
  state.quad.box = rotateQuad(state.quad.box, 1);
  state.boxOriented = true;
  editors.box.setQuad(state.quad.box);
  invalidate('box');
  if (state.cols !== state.rows) setGrid(state.rows, state.cols, state.count);
  saveState();
});

// ---------------------------------------------------------------- step 2: filled cells
const filledCanvas = $('#filled-canvas');
async function showFilled() {
  if (!state.img.built || !state.img.box) return;
  await busy('Comparing with the box picture…', async () => {
    ensureFilled();
    renderFilled(filledCanvas, ensureBuiltRect().canvas, state.cols, state.rows, state.filled);
  });
}
filledCanvas.addEventListener('click', (e) => {
  if (!state.filled || !cache.builtRect) return;
  const r = filledCanvas.getBoundingClientRect();
  const c = Math.floor(((e.clientX - r.left) / r.width) * state.cols);
  const row = Math.floor(((e.clientY - r.top) / r.height) * state.rows);
  if (c < 0 || row < 0 || c >= state.cols || row >= state.rows) return;
  const i = row * state.cols + c;
  setCell(i, state.filled[i] ? 0 : 1);
  delete cache.scored;
  renderFilled(filledCanvas, cache.builtRect.canvas, state.cols, state.rows, state.filled);
  saveState();
});
$('#btn-detect').addEventListener('click', () => {
  state.overrides = {}; state.filled = null; delete cache.filledAuto; delete cache.scored; saveState(); showFilled();
});

// ---------------------------------------------------------------- step 3: pieces photos
const sensEl = $('#seg-sens');
sensEl.addEventListener('change', () => { state.sens = +sensEl.value; invalidate('pieces'); saveState(); showPieces(); });

function renderShotList() {
  const list = $('#shot-list');
  list.innerHTML = '';
  state.shots.forEach((s, i) => {
    const seg = cache.segs && cache.segs.get(s.id);
    const item = document.createElement('div');
    item.className = 'shot' + (s.id === state.curShot ? ' active' : '');
    const thumb = document.createElement('canvas');
    const k = 96 / Math.max(s.img.width, s.img.height);
    thumb.width = Math.round(s.img.width * k); thumb.height = Math.round(s.img.height * k);
    thumb.getContext('2d').drawImage(s.img, 0, 0, thumb.width, thumb.height);
    const sel = document.createElement('button');
    sel.className = 'shot-select';
    sel.setAttribute('aria-label', `Show photo ${i + 1}`);
    const cap = document.createElement('span');
    cap.textContent = `Photo ${i + 1}` + (seg ? ` · ${seg.pieces.length}` : '');
    sel.append(thumb, cap);
    sel.addEventListener('click', () => { state.curShot = s.id; saveState(); showPieces(); });
    const del = document.createElement('button');
    del.className = 'shot-del';
    del.textContent = '✕';
    del.setAttribute('aria-label', `Remove photo ${i + 1}`);
    del.addEventListener('click', () => removeShot(s.id));
    item.append(sel, del);
    list.append(item);
  });
}

async function removeShot(id) {
  if (!confirm('Remove this photo of loose pieces?')) return;
  state.shots = state.shots.filter((s) => s.id !== id);
  state.placedPts = state.placedPts.filter((p) => p.shot !== id);
  if (state.curShot === id) state.curShot = state.shots[0]?.id ?? null;
  await store.del('orig-shot-' + id);
  invalidate('shots');
  saveState();
  showPieces();
}

let piecesSeq = 0;
async function showPieces() {
  const seq = ++piecesSeq; // a newer call supersedes this one (e.g. a photo removed while one is processing)
  const wrap = $('#pieces-wrap');
  renderShotList();
  if (!state.shots.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  sensEl.value = state.sens;
  await busy('Finding pieces…', async () => {
    const pieces = await ensurePieces();
    if (seq !== piecesSeq) return;
    renderShotList();
    const shot = state.shots.find((s) => s.id === state.curShot) || state.shots[0];
    const seg = cache.segs.get(shot.id);
    renderPieces($('#pieces-canvas'), shot.img, seg);
    const n = state.shots.length;
    $('#seg-info').textContent = `${seg.pieces.length} pieces found in this photo` +
      (n > 1 ? `, ${pieces.length} in all ${n} photos` : '') +
      (seg.clusters.length ? `. ${seg.clusters.length} groups of touching pieces (red) are skipped, so spread them apart` : '') +
      '. If the outlines are wrong, adjust the sensitivity.';
  });
}

// ---------------------------------------------------------------- step 4: solve
// Piece by piece: every loose piece in the photos is matched to its best empty cell at once (globally, so no two
// pieces claim the same cell). Only the pieces the app is confident about are shown unless "Show guesses too" is
// ticked, most confident first, a few at a time so the arrows stay readable.
const PAGE = 10;
let lastMatches = [], solvePage = 0;
async function showSolve() {
  await busy('Matching pieces…', async () => {
    ensureFilled();
    const pieces = await ensurePieces();
    if (!pieces.length) throw new Error('No pieces detected');
    await ensureScored();
    drawSolve();
  });
}

/** Best spot for every loose piece not marked as placed yet, most confident first. */
function pieceSpots() {
  if (!cache.spots || cache.spotsFor !== cache.scored || cache.spotsGrow !== state.grow) {
    // growing: in the order the pieces were proposed (each may lean on the ones before it)
    cache.spots = state.grow
      ? growSolve(cache.scored, cache.pieces, state.cols, state.rows, state.filled, placedPieceIdx())
      : solveAll(cache.scored, cache.pieces, placedPieceIdx()).sort((a, b) => b.confidence - a.confidence);
    cache.spotsFor = cache.scored; cache.spotsGrow = state.grow;
  }
  return cache.spots;
}

function drawSolve() {
  const pieces = cache.pieces, ref = cache.ref;
  const guesses = $('#solve-guesses').checked;
  const spots = pieceSpots();
  const sure = spots.filter((m) => !isLow(m));
  const list = guesses ? spots : sure;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  solvePage = Math.min(Math.max(0, solvePage), pages - 1);
  const matches = list.slice(solvePage * PAGE, (solvePage + 1) * PAGE);
  lastMatches = matches;
  $('#page-label').textContent = list.length
    ? `Pieces ${solvePage * PAGE + 1}–${solvePage * PAGE + matches.length} of ${list.length}` : 'No pieces';
  $('#page-prev').disabled = solvePage === 0;
  $('#page-next').disabled = solvePage >= pages - 1;
  $('#btn-placed').disabled = !matches.length;
  const shots = shotsMap();
  renderSolution($('#solve-canvas'), {
    built: state.img.built, builtQuad: state.quad.built, gridToPx: ensureBuiltRect().map, cols: state.cols, rows: state.rows,
    shots, matches, lineCells: matches.map((m) => m.cell),
  });
  const avail = pieces.length - placedPieceIdx().size;
  const allDone = state.filled.every((v) => v);
  $('#solve-info').textContent = allDone ? 'Every cell is filled. The puzzle is complete! 🎉'
    : avail <= 0 ? 'All loose pieces in the photos are placed. Add a photo of more pieces (step 3).'
    : `The app is confident about ${sure.length} of your ${avail} loose piece(s)` +
      (guesses ? `; the other ${spots.length - sure.length} are guesses (dashed arrows).`
        : sure.length ? '. The others are left out; tick "Show guesses too" to see them.'
        : '. Tick "Show guesses too" to see its best guesses, or add a closer photo of the pieces.') +
      (matches.length ? ' The arrow on each piece points to its top edge.' : '');
  const el = $('#match-list');
  el.innerHTML = '';
  matches.forEach((m, i) => el.append(matchCard(m, solvePage * PAGE + i, shots, ref.canvas, state.cols, state.rows)));
}

$('#solve-guesses').addEventListener('change', () => { solvePage = 0; if (cache.scored) drawSolve(); });
$('#solve-grow').addEventListener('change', async (e) => {
  state.grow = e.target.checked;
  saveState();
  solvePage = 0;
  if (state.gray) delete cache.scored; // grey mode scores a different set of gaps when growing
  await showSolve();
});
$('#solve-gray').addEventListener('change', async (e) => {
  state.gray = e.target.checked;
  saveState();
  solvePage = 0;
  delete cache.scored;
  await showSolve();
});
$('#page-prev').addEventListener('click', () => { solvePage--; if (cache.scored) drawSolve(); });
$('#page-next').addEventListener('click', () => { solvePage++; if (cache.scored) drawSolve(); });
$('#btn-placed').addEventListener('click', async () => {
  if (!lastMatches.length) return;
  for (const m of lastMatches) {
    const img = shotImg(m.piece.shot);
    setCell(m.cell, 1);
    state.placedPts.push({ shot: m.piece.shot, u: m.piece.cx / img.width, v: m.piece.cy / img.height, cell: m.cell, angle: m.angle });
  }
  saveState();
  toast(`Marked ${lastMatches.length} piece(s) as placed`);
  delete cache.scored;
  await showSolve();
});

// ---------------------------------------------------------------- preview of the completed puzzle
const previewEl = $('#preview');
let lastPreview = null;
async function showPreview() {
  if (!state.img.box || !state.img.built || !state.shots.length) { toast('Take all three kinds of photos first'); return; }
  await busy('Placing all pieces…', async () => {
    ensureFilled();
    const pieces = await ensurePieces();
    if (!pieces.length) throw new Error('No pieces detected');
    const scored = await ensureScored();
    await progress('Placing all pieces…');
    const placed = placedPieces();
    const all = pieceSpots(); // the same spots the Solve step shows
    // pieces already put down via "I placed these" are drawn in their cells too (the built photo predates them)
    const done = placed.filter((x) => x.pt.cell != null && x.pt.cell < state.cols * state.rows)
      .map((x) => ({ cell: x.pt.cell, piece: x.piece, angle: x.pt.angle ?? x.piece.angle, confidence: 1, placed: true }));
    lastPreview = [...done, ...all];
    const empty = scored.cells.length;
    const sure = all.filter((m) => !isLow(m)).length;
    const total = state.cols * state.rows;
    const filledNow = state.filled.reduce((a, b) => a + b, 0);
    const gaps = empty - all.length;
    previewCounts = { all: all.length, sure, empty, gaps, filledNow, total };
    updatePreviewInfo();
    drawPreview();
    previewEl.hidden = false;
    document.body.style.overflow = 'hidden';
  });
}
let previewCounts = null;
/** Only confident placements are drawn unless "Show guesses too" is ticked; then guesses get an orange outline. */
function updatePreviewInfo() {
  const { all, sure, empty, gaps, filledNow, total } = previewCounts;
  const guesses = $('#preview-mark').checked;
  const shown = guesses ? all : sure;
  $('#preview-info').textContent =
    `${sure} of ${empty} empty cells have a piece the app is confident about` +
    (all > sure ? `, ${all - sure} more ${guesses ? 'are guesses (orange)' : 'only have a guess (hidden)'}. ` : '. ') +
    (gaps > 0 ? `${gaps} cell(s) have no piece in the photos yet. ` : '') +
    `Shown: ${Math.round(((filledNow + shown) / total) * 100)}% complete.`;
}
function drawPreview() {
  if (!lastPreview) return;
  const guesses = $('#preview-mark').checked;
  renderPreview($('#preview-canvas'), {
    builtRect: cache.builtRect.canvas, refRect: cache.ref.canvas, shots: shotsMap(),
    cols: state.cols, rows: state.rows, filled: state.filled,
    placements: guesses ? lastPreview : lastPreview.filter((m) => m.placed || !isLow(m)),
    markUncertain: guesses,
  });
}
function closePreview() { previewEl.hidden = true; document.body.style.overflow = ''; }
document.querySelectorAll('.btn-preview').forEach((b) => b.addEventListener('click', showPreview));
$('#preview-close').addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !previewEl.hidden) closePreview(); });
$('#preview-mark').addEventListener('change', () => { updatePreviewInfo(); drawPreview(); });
$('#preview-save').addEventListener('click', () => $('#preview-canvas').toBlob((b) => window.open(URL.createObjectURL(b), '_blank')));

$('#btn-zoom-toggle').addEventListener('click', () => {
  const c = $('#solve-canvas');
  c.toBlob((b) => window.open(URL.createObjectURL(b), '_blank'));
});

// ---------------------------------------------------------------- navigation
let currentStep = 'box';
const STEPS = ['box', 'built', 'pieces', 'solve'];
function refreshStepBadges() {
  const done = { box: !!state.img.box, built: !!state.img.built, pieces: state.shots.length > 0, solve: false };
  document.querySelectorAll('#steps button').forEach((b) => b.classList.toggle('done', done[b.dataset.step] && b.dataset.step !== currentStep));
}
function renderStep(step) {
  if (step === 'box') showEditor('box');
  if (step === 'built') { showEditor('built'); if (state.img.built) showFilled(); }
  if (step === 'pieces') showPieces();
  if (step === 'solve') {
    const missing = [];
    if (!state.img.box) missing.push('box');
    if (!state.img.built) missing.push('built');
    if (!state.shots.length) missing.push('pieces');
    if (missing.length) { toast('Missing photo: ' + missing.join(', ')); return goto(missing[0]); }
    showSolve();
  }
}
function goto(step) {
  currentStep = step;
  STEPS.forEach((s) => ($(`#step-${s}`).hidden = s !== step));
  document.querySelectorAll('#steps button').forEach((b) => b.classList.toggle('active', b.dataset.step === step));
  refreshStepBadges();
  window.scrollTo({ top: 0 });
  // wait until the saved photos are restored (a tap during startup would otherwise see half the state)
  booted.then(() => { if (currentStep === step) renderStep(step); });
}
document.querySelectorAll('#steps button').forEach((b) => b.addEventListener('click', () => goto(b.dataset.step)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goto(b.dataset.goto)));

// ---------------------------------------------------------------- demo / reset
$('#btn-demo').addEventListener('click', () => busy('Generating demo puzzle…', async () => {
  await booted; // don't let a slow restore overwrite the demo
  for (const s of state.shots) await store.del('orig-shot-' + s.id);
  const d = generateDemo(Math.floor(Math.random() * 1e6));
  state.img = { box: d.box, built: d.built };
  state.shots = [{ id: 'demo', img: d.pieces }];
  state.curShot = 'demo';
  state.quad = { box: d.boxQuad, built: d.builtQuad };
  state.boxOriented = true;
  state.cols = d.cols; state.rows = d.rows; state.count = d.count;
  state.filled = null; state.overrides = {}; state.placedPts = []; state.sens = 1;
  cache = {};
  syncGridInputs();
  for (const k of ['box', 'built']) await saveOriginal(k, await store.canvasToBlob(state.img[k], 'image/png'));
  await saveOriginal('shot-demo', await store.canvasToBlob(d.pieces, 'image/png'));
  saveState();
  toast('Demo loaded: a 48-piece puzzle with the border and top rows done');
  goto('box');
}));
$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Clear all photos and settings?')) return;
  await store.clear();
  location.reload();
});

// ---------------------------------------------------------------- boot
(async () => {
  try { await restore(); } catch (e) { console.warn('restore failed', e); }
  syncGridInputs();
  markBooted();
  goto('box');
})();
window.__appStarted = true; // every handler is in place (index.html shows startup errors until then)

// expose for debugging
window.__pr = { state, cache: () => cache };
