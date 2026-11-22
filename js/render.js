// Drawing of the solution overlay, match cards and filled-cell grid.
import { homography, applyH, rectCorners } from './geometry.js';

export const COLORS = ['#ff3b30', '#007aff', '#34c759', '#ff9500', '#af52de', '#00c7be', '#ff2d55', '#5856d6',
  '#ffcc00', '#30b0c7', '#a2845e', '#64d2ff'];

const LOW_CONF = 0.25;
export const isLow = (m) => m.confidence < LOW_CONF;

/** Pixel bounding box of a set of points, with margin, clamped to image. */
function bboxOf(points, w, h, marginFrac) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const m = Math.max(x1 - x0, y1 - y0) * marginFrac;
  x0 = Math.max(0, Math.floor(x0 - m)); y0 = Math.max(0, Math.floor(y0 - m));
  x1 = Math.min(w, Math.ceil(x1 + m)); y1 = Math.min(h, Math.ceil(y1 + m));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

function badge(ctx, x, y, r, color, text) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.lineWidth = r * 0.22; ctx.strokeStyle = '#fff'; ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${r * 1.15}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + r * 0.05);
}

function arrowHead(ctx, tip, from, size) {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(a - 0.45), tip.y - size * Math.sin(a - 0.45));
  ctx.lineTo(tip.x - size * Math.cos(a + 0.45), tip.y - size * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
}

/**
 * Composite: built puzzle photo on top, pieces photo below, arrows from pieces to target cells.
 */
export function renderSolution(canvas, opt) {
  const { built, builtQuad, cols, rows, piecesImg, seg, matches, lineCells } = opt;
  const W = 1200, GAP = 28;
  const Hg = homography(rectCorners(cols, rows), builtQuad); // grid coords -> built image

  const topBox = bboxOf(builtQuad, built.width, built.height, 0.05);
  const sT = W / topBox.w;
  const topH = Math.round(topBox.h * sT);

  const pts = seg.pieces.length
    ? seg.pieces.flatMap((p) => [{ x: p.bbox.x0, y: p.bbox.y0 }, { x: p.bbox.x1, y: p.bbox.y1 }])
    : [{ x: 0, y: 0 }, { x: piecesImg.width, y: piecesImg.height }];
  const botBox = bboxOf(pts, piecesImg.width, piecesImg.height, 0.04);
  const sB = W / botBox.w;
  const botH = Math.round(botBox.h * sB);
  const botY = topH + GAP;

  canvas.width = W; canvas.height = botY + botH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#1d2733';
  ctx.fillRect(0, 0, W, canvas.height);
  ctx.drawImage(built, topBox.x, topBox.y, topBox.w, topBox.h, 0, 0, W, topH);

  // tinted overlay for matched pieces
  const tint = document.createElement('canvas');
  tint.width = piecesImg.width; tint.height = piecesImg.height;
  const tctx = tint.getContext('2d');
  const tdata = tctx.createImageData(tint.width, tint.height);
  matches.forEach((m, i) => {
    const col = hexToRgb(COLORS[i % COLORS.length]);
    const { bbox, id } = m.piece;
    for (let y = bbox.y0; y <= bbox.y1; y++) for (let x = bbox.x0; x <= bbox.x1; x++) {
      const p = y * seg.w + x;
      if (seg.labels[p] !== id) continue;
      tdata.data[p * 4] = col[0]; tdata.data[p * 4 + 1] = col[1]; tdata.data[p * 4 + 2] = col[2];
      tdata.data[p * 4 + 3] = isLow(m) ? 70 : 115;
    }
  });
  tctx.putImageData(tdata, 0, 0);
  ctx.drawImage(piecesImg, botBox.x, botBox.y, botBox.w, botBox.h, 0, botY, W, botH);
  ctx.drawImage(tint, botBox.x, botBox.y, botBox.w, botBox.h, 0, botY, W, botH);

  // separator label
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText('▲ puzzle            ▼ loose pieces', 12, topH + GAP / 2);

  const toTop = (gx, gy) => { const p = applyH(Hg, gx, gy); return { x: (p.x - topBox.x) * sT, y: (p.y - topBox.y) * sT }; };
  const toBot = (x, y) => ({ x: (x - botBox.x) * sB, y: botY + (y - botBox.y) * sB });
  const cellPoly = (cell) => {
    const c = cell % cols, r = (cell / cols) | 0;
    return [toTop(c, r), toTop(c + 1, r), toTop(c + 1, r + 1), toTop(c, r + 1)];
  };
  const cellSizePx = Math.hypot(cellPoly(lineCells[0] ?? 0)[1].x - cellPoly(lineCells[0] ?? 0)[0].x,
    cellPoly(lineCells[0] ?? 0)[1].y - cellPoly(lineCells[0] ?? 0)[0].y);
  const br = Math.max(9, Math.min(18, cellSizePx * 0.32));

  // all target cells of the line: dashed outline
  const matchedCells = new Map(matches.map((m, i) => [m.cell, i]));
  for (const cell of lineCells) {
    const poly = cellPoly(cell);
    ctx.beginPath();
    poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    const mi = matchedCells.get(cell);
    if (mi === undefined) {
      ctx.setLineDash([6, 5]); ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(); ctx.setLineDash([]);
    } else {
      const col = COLORS[mi % COLORS.length];
      ctx.fillStyle = col + '55'; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = col; if (isLow(matches[mi])) ctx.setLineDash([7, 5]); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // arrows
  matches.forEach((m, i) => {
    const col = COLORS[i % COLORS.length];
    const poly = cellPoly(m.cell);
    const Q = { x: poly.reduce((s, p) => s + p.x, 0) / 4, y: poly.reduce((s, p) => s + p.y, 0) / 4 };
    const P = toBot(m.piece.cx, m.piece.cy);
    const dy = P.y - Q.y;
    const c1 = { x: P.x, y: P.y - dy * 0.35 }, c2 = { x: Q.x, y: Q.y + dy * 0.35 };
    // end the curve just outside the badge
    const end = { x: Q.x, y: Q.y + br * 1.15 };
    for (const [lw, st] of [[7, 'rgba(255,255,255,0.9)'], [3.5, col]]) {
      ctx.beginPath();
      ctx.moveTo(P.x, P.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y + br, end.x, end.y);
      ctx.lineWidth = lw; ctx.strokeStyle = st;
      ctx.setLineDash(isLow(m) && lw < 5 ? [10, 7] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff'; arrowHead(ctx, end, { x: c2.x, y: c2.y + br }, 20);
    ctx.fillStyle = col; arrowHead(ctx, { x: end.x, y: end.y - 1.5 }, { x: c2.x, y: c2.y + br }, 15);
  });

  // piece "top" markers and badges (drawn last so they sit above arrows)
  matches.forEach((m, i) => {
    const col = COLORS[i % COLORS.length];
    const P = toBot(m.piece.cx, m.piece.cy);
    const len = m.piece.side * sB * 0.62;
    const dir = { x: Math.sin(m.angle), y: -Math.cos(m.angle) };
    const T = { x: P.x + dir.x * len, y: P.y + dir.y * len };
    ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(T.x, T.y);
    ctx.lineWidth = 6; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.lineWidth = 3; ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = '#fff'; arrowHead(ctx, { x: T.x + dir.x * 4, y: T.y + dir.y * 4 }, P, 15);
    ctx.fillStyle = col; arrowHead(ctx, T, P, 11);
    badge(ctx, P.x, P.y, br * 1.05, col, String(i + 1));
    const poly = cellPoly(m.cell);
    const Q = { x: poly.reduce((s, p) => s + p.x, 0) / 4, y: poly.reduce((s, p) => s + p.y, 0) / 4 };
    badge(ctx, Q.x, Q.y, br, col, String(i + 1));
  });
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Human-readable rotation instruction for a piece whose "up" currently points at `angle` (clockwise, radians). */
export function rotationText(angle) {
  let deg = Math.round(((angle * 180) / Math.PI) % 360);
  if (deg < 0) deg += 360;
  const snapped = Math.round(deg / 90) * 90 % 360;
  if (snapped === 0) return 'already upright';
  if (snapped === 180) return 'turn 180°';
  return snapped === 90 ? 'turn 90° ↺' : 'turn 90° ↻';
}

/** Upright thumbnail of a piece and the matching area of the box picture. */
export function matchCard(m, i, piecesImg, refRect, cols, rows) {
  const card = document.createElement('div');
  card.className = 'match-card' + (isLow(m) ? ' low' : '');
  const col = COLORS[i % COLORS.length];
  const c = m.cell % cols, r = (m.cell / cols) | 0;
  const title = document.createElement('div');
  title.className = 'title';
  title.innerHTML = `<span class="dot" style="background:${col}"></span>#${i + 1} → row ${r + 1}, col ${c + 1}`;
  const pair = document.createElement('div');
  pair.className = 'pair';
  const S = 120;
  const pc = document.createElement('canvas'); pc.width = pc.height = S;
  const pctx = pc.getContext('2d');
  const k = S / (m.piece.side * 1.55);
  pctx.translate(S / 2, S / 2); pctx.rotate(-m.angle); pctx.scale(k, k); pctx.translate(-m.piece.cx, -m.piece.cy);
  pctx.drawImage(piecesImg, 0, 0);
  const rc = document.createElement('canvas'); rc.width = rc.height = S;
  const rctx = rc.getContext('2d');
  const cw = refRect.width / cols, ch = refRect.height / rows;
  rctx.drawImage(refRect, (c - 0.275) * cw, (r - 0.275) * ch, cw * 1.55, ch * 1.55, 0, 0, S, S);
  rctx.strokeStyle = 'rgba(255,255,255,0.8)'; rctx.setLineDash([4, 3]); rctx.lineWidth = 1.5;
  const m0 = S * 0.275 / 1.55;
  rctx.strokeRect(m0, m0, S - 2 * m0, S - 2 * m0);
  const arrow = document.createElement('span'); arrow.textContent = '→';
  pair.append(pc, arrow, rc);
  const info = document.createElement('div');
  info.className = 'conf';
  info.textContent = `${rotationText(m.angle)} · ${Math.round(m.confidence * 100)}% sure`;
  card.append(title, pair, info);
  return card;
}

/** Draw the rectified built image with the filled-cell overlay. */
export function renderFilled(canvas, builtRect, cols, rows, filled) {
  canvas.width = builtRect.width; canvas.height = builtRect.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(builtRect, 0, 0);
  const cw = canvas.width / cols, ch = canvas.height / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const f = filled[r * cols + c];
    ctx.fillStyle = f ? 'rgba(52,199,89,0.38)' : 'rgba(0,0,0,0.25)';
    ctx.fillRect(c * cw, r * ch, cw, ch);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < cols; c++) { ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, canvas.height); }
  for (let r = 1; r < rows; r++) { ctx.moveTo(0, r * ch); ctx.lineTo(canvas.width, r * ch); }
  ctx.stroke();
}

/** Outline detected pieces on the pieces photo. */
export function renderPieces(canvas, piecesImg, seg) {
  canvas.width = piecesImg.width; canvas.height = piecesImg.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(piecesImg, 0, 0);
  const tint = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = tint.data, L = seg.labels, w = seg.w, h = seg.h;
  const clusterIds = new Set(seg.pieces.filter((p) => p.cluster).map((p) => p.id));
  const ids = new Set(seg.pieces.map((p) => p.id));
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = y * w + x, id = L[p];
    if (!id || !ids.has(id)) continue;
    if (L[p - 1] !== id || L[p + 1] !== id || L[p - w] !== id || L[p + w] !== id) {
      const o = p * 4;
      if (clusterIds.has(id)) { d[o] = 255; d[o + 1] = 59; d[o + 2] = 48; } else { d[o] = 255; d[o + 1] = 220; d[o + 2] = 0; }
    }
  }
  ctx.putImageData(tint, 0, 0);
  const s = Math.max(1, canvas.width / 700);
  for (const p of seg.pieces) {
    ctx.save();
    ctx.translate(p.cx, p.cy); ctx.rotate(p.angle);
    ctx.strokeStyle = 'rgba(0,200,255,0.8)'; ctx.lineWidth = 1.5 * s;
    ctx.strokeRect(-p.side / 2, -p.side / 2, p.side, p.side);
    ctx.restore();
  }
}

/** Cut-out of a single piece from the pieces photo: its bounding box, transparent outside its outline. */
function cutOut(piecesImg, seg, piece) {
  const { x0, y0, x1, y1 } = piece.bbox;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(piecesImg, x0, y0, w, h, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h), d = id.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seg.labels[(y + y0) * seg.w + x + x0] !== piece.id) d[(y * w + x) * 4 + 3] = 0;
  }
  ctx.putImageData(id, 0, 0);
  return { img: c, x0, y0 };
}

/** Draw a whole loose piece (tabs included), turned upright, with its core on a grid cell. */
function drawPieceInCell(ctx, cut, piece, angle, x, y, cw, ch) {
  ctx.save();
  ctx.translate(x + cw / 2, y + ch / 2);
  ctx.scale(cw / piece.side, ch / piece.side);
  ctx.rotate(-angle);
  ctx.translate(-piece.cx, -piece.cy);
  ctx.drawImage(cut.img, cut.x0, cut.y0);
  ctx.restore();
}

/**
 * Preview of the (nearly) completed puzzle.
 * placements: [{cell, piece, angle, confidence, placed?}]; cells without a placement that are still empty show the
 * box picture faded, so the gaps are easy to see.
 */
export function renderPreview(canvas, { builtRect, refRect, piecesImg, seg, cols, rows, filled, placements, markUncertain = true }) {
  const k = Math.max(1, 1000 / builtRect.width); // render big enough to see detail even for small grids
  const W = Math.round(builtRect.width * k), H = Math.round(builtRect.height * k);
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const cw = W / cols, ch = H / rows;
  const rw = refRect.width / cols, rh = refRect.height / rows;
  ctx.drawImage(builtRect, 0, 0, W, H);
  const byCell = new Map(placements.map((p) => [p.cell, p]));
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c, x = c * cw, y = r * ch;
    if (byCell.has(i)) {
      // under a piece: the box picture shows through its cut-outs (neighbours' tabs fill them in reality)
      ctx.drawImage(refRect, c * rw, r * rh, rw, rh, x, y, cw, ch);
      continue;
    }
    if (filled[i]) continue;
    // gap: faded box picture + hatching
    ctx.fillStyle = '#1d2733';
    ctx.fillRect(x, y, cw, ch);
    ctx.globalAlpha = 0.28;
    ctx.drawImage(refRect, c * rw, r * rh, rw, rh, x, y, cw, ch);
    ctx.globalAlpha = 1;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, cw, ch); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = -ch; k < cw; k += 6) { ctx.moveTo(x + k, y + ch); ctx.lineTo(x + k + ch, y); }
    ctx.stroke();
    ctx.restore();
  }
  // pieces, tabs included, so they also cover the gaps their neighbours leave
  for (const pl of placements) {
    const c = pl.cell % cols, r = (pl.cell / cols) | 0;
    drawPieceInCell(ctx, cutOut(piecesImg, seg, pl.piece), pl.piece, pl.angle, c * cw, r * ch, cw, ch);
  }
  // faint grid
  ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < cols; c++) { ctx.moveTo(c * cw, 0); ctx.lineTo(c * cw, H); }
  for (let r = 1; r < rows; r++) { ctx.moveTo(0, r * ch); ctx.lineTo(W, r * ch); }
  ctx.stroke();
  if (markUncertain) {
    ctx.lineWidth = Math.max(1.5, cw * 0.06);
    for (const pl of placements) {
      if (pl.placed || !isLow(pl)) continue;
      const c = pl.cell % cols, r = (pl.cell / cols) | 0;
      ctx.strokeStyle = '#ff9500';
      ctx.setLineDash([cw * 0.15, cw * 0.1]);
      ctx.strokeRect(c * cw + ctx.lineWidth / 2, r * ch + ctx.lineWidth / 2, cw - ctx.lineWidth, ch - ctx.lineWidth);
    }
    ctx.setLineDash([]);
  }
}
