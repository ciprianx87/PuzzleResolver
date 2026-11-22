import { loadImage, toLab, getImageData, tick } from './imageutil.js';
import { warpQuad, quadAspect, rectifiedSize, rectCorners, homography } from './geometry.js';
import { QuadEditor } from './quadeditor.js';
import { autoQuad, segmentPieces, dominantColor } from './segment.js';
import {
  gridDescriptors, shiftedGridDescriptors, detectFilled, filledFromCoverage, cellRequirements, DETECT_INNER,
  describePieces, scoreAll, solveLine, solveAll,
} from './match.js';
import { renderSolution, renderFilled, renderPieces, matchCard, renderPreview, isLow } from './render.js';
import * as store from './store.js';
import { generateDemo } from './demo.js';

const $ = (s) => document.querySelector(s);
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
  mode: 'row', line: -1,
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
  const { cols, rows, count, sens, overrides, placedPts, mode, line, boxOriented, curShot } = state;
  store.put('state', {
    version: STATE_VERSION, cols, rows, count, sens, overrides, placedPts, mode, line, boxOriented, curShot,
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
    mode: s.mode || 'row', line: s.line ?? -1, boxOriented: !!s.boxOriented,
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
    box: ['ref', 'builtRect', 'filled', 'scored'],
    grid: ['ref', 'builtRect', 'filled', 'scored'],
    built: ['builtRect', 'filled', 'scored'],
    pieces: ['segs', 'pieces', 'scored'],   // all pieces photos (e.g. sensitivity changed)
    shots: ['pieces', 'scored'],            // a photo was added/removed: keep the others' results
    filled: ['scored'],
  }[what] || ['ref', 'builtRect', 'filled', 'segs', 'pieces', 'scored'];
  for (const d of deps) {
    if (d === 'filled') { state.filled = null; delete cache.filledAuto; state.line = -1; }
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
  const ref = ensureRef();
  const canvas = warpQuad(state.img.built, state.quad.built, ref.w, ref.h);
  const lab = toLab(getImageData(canvas));
  cache.builtRect = { canvas, centre: shiftedGridDescriptors(lab, ref.w, ref.h, state.cols, state.rows, DETECT_INNER) };
  // structural detection: what is assembled puzzle (not cloth, not loose pieces) in the built photo?
  const surf = surfaceColor(state.img.built, state.quad.built);
  if (surf) {
    const q = state.quad.built, d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const cellW = (d(q[0], q[1]) + d(q[3], q[2])) / 2 / state.cols, cellH = (d(q[0], q[3]) + d(q[1], q[2])) / 2 / state.rows;
    const seg = segmentPieces(state.img.built, 1, surf, cellW * cellH * 1.1);
    const asm = new Uint8Array(seg.w * seg.h);
    for (let p = 0; p < asm.length; p++) asm[p] = seg.mask[p] && !seg.looseIds.has(seg.labels[p]) ? 1 : 0;
    cache.builtRect.assembled = { mask: asm, w: seg.w, h: seg.h };
  }
  return cache.builtRect;
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
      const H = homography(rectCorners(state.cols, state.rows), state.quad.built);
      cache.filledAuto = filledFromCoverage(b.assembled.mask, b.assembled.w, b.assembled.h, H, state.cols, state.rows).filled;
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
  const empty = emptyCells();
  await progress(`Comparing ${pieces.length} pieces with ${empty.length} empty cells…`);
  const b = cache.builtRect;
  const H = homography(rectCorners(state.cols, state.rows), state.quad.built);
  const needs = cellRequirements(empty, state.cols, state.rows, state.filled, cache.filledAuto, b && b.assembled, H);
  cache.scored = scoreAll(pieces, ref.descs, empty, needs);
  return cache.scored;
}

function lineCells(mode, line) {
  const { cols, rows } = state;
  const f = state.filled;
  const out = [];
  if (mode === 'row') for (let c = 0; c < cols; c++) { const i = line * cols + c; if (!f[i]) out.push(i); }
  else for (let r = 0; r < rows; r++) { const i = r * cols + line; if (!f[i]) out.push(i); }
  return out;
}
const lineCount = () => (state.mode === 'row' ? state.rows : state.cols);

function firstOpenLine() {
  for (let l = 0; l < lineCount(); l++) if (lineCells(state.mode, l).length) return l;
  return 0;
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
function syncGridInputs() { elCount.value = state.count; elCols.value = state.cols; elRows.value = state.rows; }
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
let lastMatches = [];
async function showSolve() {
  await busy('Matching pieces…', async () => {
    ensureFilled();
    const pieces = await ensurePieces();
    if (!pieces.length) throw new Error('No pieces detected');
    await ensureScored();
    if (state.line < 0 || state.line >= lineCount()) state.line = firstOpenLine();
    drawSolve();
  });
}

function drawSolve() {
  const pieces = cache.pieces, scored = cache.scored, ref = cache.ref;
  const cells = lineCells(state.mode, state.line);
  const name = state.mode === 'row' ? 'Row' : 'Column';
  $('#line-label').textContent = `${name} ${state.line + 1}`;
  $('#mode-row').classList.toggle('active', state.mode === 'row');
  $('#mode-col').classList.toggle('active', state.mode === 'col');
  const placed = placedPieceIdx();
  const matches = cells.length ? solveLine(scored, pieces, cells, placed) : [];
  lastMatches = matches;
  const shots = shotsMap();
  renderSolution($('#solve-canvas'), {
    built: state.img.built, builtQuad: state.quad.built, cols: state.cols, rows: state.rows,
    shots, matches, lineCells: cells,
  });
  const avail = pieces.length - placed.size;
  const allDone = state.filled.every((v) => v);
  $('#solve-info').textContent = allDone ? 'Every cell is filled. The puzzle is complete! 🎉'
    : avail <= 0 ? 'All loose pieces in the photos are placed. Add a photo of the remaining pieces (step 3).'
    : !cells.length ? `${name} ${state.line + 1} is complete. Use ▶ to go to the next line.`
    : `${cells.length} empty cell(s) in this ${name.toLowerCase()}, ${avail} loose piece(s). ` +
      `The arrow on each piece points to its top edge. Dashed arrows are uncertain guesses.`;
  const list = $('#match-list');
  list.innerHTML = '';
  matches.forEach((m, i) => list.append(matchCard(m, i, shots, ref.canvas, state.cols, state.rows)));
  saveState();
}

$('#mode-row').addEventListener('click', () => { state.mode = 'row'; state.line = firstOpenLine(); if (cache.scored) drawSolve(); });
$('#mode-col').addEventListener('click', () => { state.mode = 'col'; state.line = firstOpenLine(); if (cache.scored) drawSolve(); });
$('#line-prev').addEventListener('click', () => { state.line = (state.line - 1 + lineCount()) % lineCount(); if (cache.scored) drawSolve(); });
$('#line-next').addEventListener('click', () => { state.line = (state.line + 1) % lineCount(); if (cache.scored) drawSolve(); });
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
  if (!lineCells(state.mode, state.line).length) state.line = firstOpenLine();
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
    const all = solveAll(scored, pieces, new Set(placed.map((x) => x.piece.idx)));
    // pieces already put down via "I placed these" are drawn in their cells too (the built photo predates them)
    const done = placed.filter((x) => x.pt.cell != null && x.pt.cell < state.cols * state.rows)
      .map((x) => ({ cell: x.pt.cell, piece: x.piece, angle: x.pt.angle ?? x.piece.angle, confidence: 1, placed: true }));
    lastPreview = [...done, ...all];
    const empty = scored.cells.length;
    const sure = all.filter((m) => !isLow(m)).length;
    const total = state.cols * state.rows;
    const filledNow = state.filled.reduce((a, b) => a + b, 0);
    const gaps = empty - all.length;
    $('#preview-info').textContent =
      `${all.length} of ${empty} empty cells get a piece (${sure} confident, ${all.length - sure} guesses). ` +
      (gaps > 0 ? `${gaps} cell(s) have no piece in the photos yet. ` : 'Every gap is covered. ') +
      `The puzzle would be ${Math.round(((filledNow + all.length) / total) * 100)}% complete.`;
    drawPreview();
    previewEl.hidden = false;
    document.body.style.overflow = 'hidden';
  });
}
function drawPreview() {
  if (!lastPreview) return;
  renderPreview($('#preview-canvas'), {
    builtRect: cache.builtRect.canvas, refRect: cache.ref.canvas, shots: shotsMap(),
    cols: state.cols, rows: state.rows, filled: state.filled, placements: lastPreview,
    markUncertain: $('#preview-mark').checked,
  });
}
function closePreview() { previewEl.hidden = true; document.body.style.overflow = ''; }
document.querySelectorAll('.btn-preview').forEach((b) => b.addEventListener('click', showPreview));
$('#preview-close').addEventListener('click', closePreview);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !previewEl.hidden) closePreview(); });
$('#preview-mark').addEventListener('change', drawPreview);
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
  renderStep(step);
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
  state.filled = null; state.overrides = {}; state.placedPts = []; state.line = -1; state.mode = 'row'; state.sens = 1;
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
const booted = (async () => {
  try { await restore(); } catch (e) { console.warn('restore failed', e); }
  syncGridInputs();
  goto('box');
})();

// expose for debugging
window.__pr = { state, cache: () => cache };
