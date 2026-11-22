import { loadImage, toLab, getImageData, tick, scaleCanvas } from './imageutil.js';
import { warpQuad, quadAspect, rectifiedSize, rectCorners } from './geometry.js';
import { QuadEditor } from './quadeditor.js';
import { autoQuad, segmentPieces } from './segment.js';
import { gridDescriptors, detectFilled, DETECT_INNER, describePieces, scoreAll, solveLine, solveAll } from './match.js';
import { renderSolution, renderFilled, renderPieces, matchCard, renderPreview, isLow } from './render.js';
import * as store from './store.js';
import { generateDemo } from './demo.js';

const $ = (s) => document.querySelector(s);
const MAXDIM = { box: 1600, built: 1600, pieces: 1800 };

// What is persisted is only what the USER provided: the original photos (full resolution, untouched),
// corner positions (normalised 0..1, independent of processing resolution), grid size, manual cell corrections
// and the positions of pieces they placed. Everything the algorithm computes (filled detection, piece
// segmentation, matches) is recomputed on load, so an improved algorithm applies to photos already taken.
const STATE_VERSION = 2;
const KEYS = ['box', 'built', 'pieces'];

const state = {
  img: { box: null, built: null, pieces: null }, // processing canvases (downscaled from the originals)
  quad: { box: null, built: null },              // pixel coords in state.img[key]
  cols: 25, rows: 20, count: 500,
  filled: null,       // derived: automatic detection + overrides
  overrides: {},      // cell index -> 0/1, set by the user (taps, "I placed these")
  placedPts: [],      // [{u, v, cell, angle}] normalised centres of loose pieces the user placed, and where
  sens: 1,
  mode: 'row', line: -1,
};
let cache = {};

// ---------------------------------------------------------------- UI helpers
const busyEl = $('#busy'), busyText = $('#busy-text');
async function busy(text, fn) {
  busyText.textContent = text; busyEl.hidden = false;
  await tick(); await new Promise(requestAnimationFrame);
  try { return await fn(); }
  catch (e) { console.error(e); toast('Error: ' + e.message); }
  finally { busyEl.hidden = true; }
}
let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- persistence
const normQuad = (q, c) => (q && c ? q.map((p) => ({ u: p.x / c.width, v: p.y / c.height })) : null);
const denormQuad = (q, c) => (q && c ? q.map((p) => ({ x: p.u * c.width, y: p.v * c.height })) : null);

function saveState() {
  const { cols, rows, count, sens, overrides, placedPts, mode, line } = state;
  store.put('state', {
    version: STATE_VERSION, cols, rows, count, sens, overrides, placedPts, mode, line,
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
  for (const k of KEYS) {
    const b = (await store.get('orig-' + k)) || (await store.get('img-' + k));
    if (b) state.img[k] = await loadImage(b, MAXDIM[k]);
  }
  if (!s) return false;
  Object.assign(state, {
    cols: s.cols ?? state.cols, rows: s.rows ?? state.rows, count: s.count ?? state.count, sens: s.sens ?? 1,
    mode: s.mode || 'row', line: s.line ?? -1,
  });
  if ((s.version || 1) >= 2) {
    state.quad = { box: denormQuad(s.quad.box, state.img.box), built: denormQuad(s.quad.built, state.img.built) };
    state.overrides = s.overrides || {};
    state.placedPts = s.placedPts || [];
  } else if (s.quad) {
    // v1 stored pixel corners of the downscaled image, which is what we just loaded
    state.quad = { box: s.quad.box, built: s.quad.built };
  }
  if (KEYS.some((k) => state.img[k])) requestPersistence();
  return true;
}

// ---------------------------------------------------------------- invalidation
function invalidate(what) {
  const order = ['ref', 'builtRect', 'filled', 'seg', 'scored'];
  const deps = {
    box: ['ref', 'builtRect', 'filled', 'scored'],
    grid: ['ref', 'builtRect', 'filled', 'scored'],
    built: ['builtRect', 'filled', 'scored'],
    pieces: ['seg', 'scored'],
    filled: ['scored'],
  }[what] || order;
  for (const d of deps) {
    if (d === 'filled') { state.filled = null; delete cache.filledAuto; state.line = -1; }
    else delete cache[d];
  }
  refreshStepBadges();
}

/** A new photo / grid makes the user's earlier corrections meaningless. */
function forgetUserInput(what) {
  if (what === 'built' || what === 'grid') state.overrides = {};
  if (what === 'pieces') state.placedPts = [];
}

// ---------------------------------------------------------------- pipeline
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
  cache.builtRect = { canvas, centre: gridDescriptors(lab, ref.w, ref.h, state.cols, state.rows, DETECT_INNER) };
  return cache.builtRect;
}

function ensureFilled() {
  if (!cache.filledAuto || cache.filledAuto.length !== state.cols * state.rows) {
    const ref = ensureRef(), b = ensureBuiltRect();
    cache.filledAuto = detectFilled(b.centre, ref.centre).filled;
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

function ensureSeg() {
  if (cache.seg) return cache.seg;
  if (!state.img.pieces) throw new Error('Take the photo of the loose pieces first');
  const seg = segmentPieces(state.img.pieces, state.sens);
  describePieces(seg);
  cache.seg = seg;
  return seg;
}

/** Detected pieces the user has already placed (matched by position, not by detection order). */
function placedPieces() {
  const seg = cache.seg, img = state.img.pieces;
  const out = [];
  if (!seg || !img) return out;
  for (const pt of state.placedPts) {
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

function ensureScored() {
  if (cache.scored) return cache.scored;
  const seg = ensureSeg(), ref = ensureRef();
  const empty = emptyCells();
  cache.scored = scoreAll(seg.pieces, ref.descs, empty);
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
  box: new QuadEditor($('#box-editor'), { onChange: (q) => { state.quad.box = q; invalidate('box'); updateGridFromCount(false); saveState(); } }),
  built: new QuadEditor($('#built-editor'), { onChange: (q) => { state.quad.built = q; invalidate('built'); saveState(); showFilled(); } }),
};

function defaultQuad(c, inset = 0.06) {
  const w = c.width, h = c.height;
  return [{ x: w * inset, y: h * inset }, { x: w * (1 - inset), y: h * inset }, { x: w * (1 - inset), y: h * (1 - inset) }, { x: w * inset, y: h * (1 - inset) }];
}

function showEditor(key) {
  const c = state.img[key];
  const wrap = $(`#${key}-editor-wrap`);
  if (!c) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (!state.quad[key]) state.quad[key] = autoQuad(c) || defaultQuad(c);
  editors[key].setImage(c, state.quad[key]);
  editors[key].setGrid(state.cols, state.rows);
}

// ---------------------------------------------------------------- grid settings
const elCount = $('#piece-count'), elCols = $('#grid-cols'), elRows = $('#grid-rows');
function syncGridInputs() { elCount.value = state.count; elCols.value = state.cols; elRows.value = state.rows; }
function updateGridFromCount(fromUser = true) {
  if (!fromUser && state.cols * state.rows === state.count && state.cols) { /* keep explicit grid */ }
  const aspect = state.quad.box ? quadAspect(state.quad.box) : 4 / 3;
  if (fromUser) {
    const n = Math.max(4, +elCount.value || 4);
    const cols = Math.max(2, Math.round(Math.sqrt(n * aspect)));
    const rows = Math.max(2, Math.round(n / cols));
    setGrid(cols, rows, n);
  }
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
elCount.addEventListener('change', () => updateGridFromCount(true));
elCols.addEventListener('change', () => setGrid(Math.max(2, +elCols.value || 2), state.rows));
elRows.addEventListener('change', () => setGrid(state.cols, Math.max(2, +elRows.value || 2)));

// ---------------------------------------------------------------- capture
document.querySelectorAll('input[type=file]').forEach((inp) => {
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    inp.value = '';
    if (!file) return;
    const key = inp.dataset.target;
    await busy('Loading photo…', async () => {
      await booted;
      state.img[key] = await loadImage(file, MAXDIM[key]);
      if (key !== 'pieces') state.quad[key] = null;
      invalidate(key);
      forgetUserInput(key);
      await saveOriginal(key, file);
      saveState();
      renderStep(currentStep);
    });
  });
});

document.querySelectorAll('[data-autocorners]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.autocorners;
  const q = autoQuad(state.img[key]);
  if (!q) { toast('Could not find the edges automatically — drag the corners'); return; }
  state.quad[key] = q; editors[key].setQuad(q); invalidate(key); saveState();
  if (key === 'built') showFilled();
}));
document.querySelectorAll('[data-fullcorners]').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.fullcorners;
  const c = state.img[key];
  const q = rectCorners(c.width, c.height);
  state.quad[key] = q; editors[key].setQuad(q); invalidate(key); saveState();
  if (key === 'built') showFilled();
}));

// ---------------------------------------------------------------- step 2: filled cells
const filledCanvas = $('#filled-canvas');
async function showFilled() {
  if (!state.img.built || !state.img.box) return;
  await busy('Comparing with the box picture…', async () => {
    const b = ensureBuiltRect();
    const f = ensureFilled();
    renderFilled(filledCanvas, b.canvas, state.cols, state.rows, f);
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

// ---------------------------------------------------------------- step 3: pieces
const sensEl = $('#seg-sens');
sensEl.addEventListener('change', () => { state.sens = +sensEl.value; invalidate('pieces'); saveState(); showPieces(); });
async function showPieces() {
  const wrap = $('#pieces-wrap');
  if (!state.img.pieces) { wrap.hidden = true; return; }
  wrap.hidden = false;
  sensEl.value = state.sens;
  await busy('Finding pieces…', async () => {
    const seg = ensureSeg();
    renderPieces($('#pieces-canvas'), state.img.pieces, seg);
    const clusters = seg.pieces.filter((p) => p.cluster).length;
    $('#seg-info').textContent = `${seg.pieces.length} pieces found` +
      (clusters ? ` · ${clusters} look like touching pieces (red), so spread them apart` : '') +
      '. If the outlines are wrong, adjust the sensitivity.';
  });
}

// ---------------------------------------------------------------- step 4: solve
let lastMatches = [];
async function showSolve() {
  await busy('Matching pieces…', async () => {
    ensureFilled();
    const seg = ensureSeg();
    if (!seg.pieces.length) throw new Error('No pieces detected');
    ensureScored();
    if (state.line < 0 || state.line >= lineCount()) state.line = firstOpenLine();
    drawSolve();
  });
}

function drawSolve() {
  const seg = cache.seg, scored = cache.scored, ref = cache.ref;
  const cells = lineCells(state.mode, state.line);
  const name = state.mode === 'row' ? 'Row' : 'Column';
  $('#line-label').textContent = `${name} ${state.line + 1}`;
  $('#mode-row').classList.toggle('active', state.mode === 'row');
  $('#mode-col').classList.toggle('active', state.mode === 'col');
  const placed = placedPieceIdx();
  const matches = cells.length ? solveLine(scored, seg.pieces, cells, placed) : [];
  lastMatches = matches;
  renderSolution($('#solve-canvas'), {
    built: state.img.built, builtQuad: state.quad.built, cols: state.cols, rows: state.rows,
    piecesImg: state.img.pieces, seg, matches, lineCells: cells,
  });
  const avail = seg.pieces.length - placed.size;
  const allDone = state.filled.every((v) => v);
  $('#solve-info').textContent = allDone ? 'Every cell is filled. The puzzle is complete! 🎉'
    : avail <= 0 ? 'All loose pieces in the photo are placed. Take a new photo of the remaining pieces (step 3).'
    : !cells.length ? `${name} ${state.line + 1} is complete. Use ▶ to go to the next line.`
    : `${cells.length} empty cell(s) in this ${name.toLowerCase()}, ${avail} loose piece(s). ` +
      `The arrow on each piece points to its top edge. Dashed arrows are uncertain guesses.`;
  const list = $('#match-list');
  list.innerHTML = '';
  matches.forEach((m, i) => list.append(matchCard(m, i, state.img.pieces, ref.canvas, state.cols, state.rows)));
  saveState();
}

$('#mode-row').addEventListener('click', () => { state.mode = 'row'; state.line = firstOpenLine(); if (cache.scored) drawSolve(); });
$('#mode-col').addEventListener('click', () => { state.mode = 'col'; state.line = firstOpenLine(); if (cache.scored) drawSolve(); });
$('#line-prev').addEventListener('click', () => { state.line = (state.line - 1 + lineCount()) % lineCount(); if (cache.scored) drawSolve(); });
$('#line-next').addEventListener('click', () => { state.line = (state.line + 1) % lineCount(); if (cache.scored) drawSolve(); });
$('#btn-placed').addEventListener('click', async () => {
  if (!lastMatches.length) return;
  const img = state.img.pieces;
  for (const m of lastMatches) {
    setCell(m.cell, 1);
    state.placedPts.push({ u: m.piece.cx / img.width, v: m.piece.cy / img.height, cell: m.cell, angle: m.angle });
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
  const missing = KEYS.filter((k) => !state.img[k]);
  if (missing.length) { toast('Missing photo: ' + missing.join(', ')); return; }
  await busy('Placing all pieces…', async () => {
    ensureFilled();
    const seg = ensureSeg();
    if (!seg.pieces.length) throw new Error('No pieces detected');
    const scored = ensureScored();
    const placed = placedPieces();
    const all = solveAll(scored, seg.pieces, new Set(placed.map((x) => x.piece.idx)));
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
      (gaps > 0 ? `${gaps} cell(s) have no piece in the photo yet. ` : 'Every gap is covered. ') +
      `The puzzle would be ${Math.round(((filledNow + all.length) / total) * 100)}% complete.`;
    drawPreview();
    previewEl.hidden = false;
    document.body.style.overflow = 'hidden';
  });
}
function drawPreview() {
  if (!lastPreview) return;
  renderPreview($('#preview-canvas'), {
    builtRect: cache.builtRect.canvas, refRect: cache.ref.canvas, piecesImg: state.img.pieces, seg: cache.seg,
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
  const done = { box: !!state.img.box, built: !!state.img.built, pieces: !!state.img.pieces, solve: false };
  document.querySelectorAll('#steps button').forEach((b) => b.classList.toggle('done', done[b.dataset.step] && b.dataset.step !== currentStep));
}
function renderStep(step) {
  if (step === 'box') showEditor('box');
  if (step === 'built') { showEditor('built'); if (state.img.built) showFilled(); }
  if (step === 'pieces') showPieces();
  if (step === 'solve') {
    const missing = ['box', 'built', 'pieces'].filter((k) => !state.img[k]);
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
  const d = generateDemo(Math.floor(Math.random() * 1e6));
  state.img = { box: d.box, built: d.built, pieces: d.pieces };
  state.quad = { box: d.boxQuad, built: d.builtQuad };
  state.cols = d.cols; state.rows = d.rows; state.count = d.count;
  state.filled = null; state.overrides = {}; state.placedPts = []; state.line = -1; state.mode = 'row'; state.sens = 1;
  cache = {};
  syncGridInputs();
  for (const k of KEYS) await saveOriginal(k, await store.canvasToBlob(state.img[k], 'image/png'));
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
