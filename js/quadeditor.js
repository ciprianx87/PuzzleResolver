// Draggable 4-corner editor with grid overlay and magnifier loupe.
import { homography, applyH, rectCorners } from './geometry.js';

const LABELS = ['TL', 'TR', 'BR', 'BL'];

export class QuadEditor {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.img = null;
    this.quad = null;
    this.cols = 0; this.rows = 0;
    this.drag = -1;
    this.dragOffset = { x: 0, y: 0 };
    this.pointer = null;
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
  }

  setImage(img, quad) {
    this.img = img;
    this.canvas.width = img.width;
    this.canvas.height = img.height;
    this.quad = quad.map((p) => ({ ...p }));
    this.draw();
  }

  setGrid(cols, rows) { this.cols = cols; this.rows = rows; this.draw(); }

  setQuad(q) { this.quad = q.map((p) => ({ ...p })); this.draw(); }

  getQuad() { return this.quad.map((p) => ({ ...p })); }

  /** image pixels per CSS pixel */
  _scale() {
    const r = this.canvas.getBoundingClientRect();
    return r.width ? this.canvas.width / r.width : 1;
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.canvas.width / r.width;
    return { x: (e.clientX - r.left) * s, y: (e.clientY - r.top) * s };
  }

  _down(e) {
    if (!this.quad) return;
    const p = this._pos(e);
    const hit = 34 * this._scale();
    let best = -1, bd = Infinity;
    this.quad.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    if (bd > hit) return;
    this.drag = best;
    this.dragOffset = { x: this.quad[best].x - p.x, y: this.quad[best].y - p.y };
    this.pointer = p;
    this.canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.draw();
  }

  _move(e) {
    if (this.drag < 0) return;
    const p = this._pos(e);
    const q = this.quad[this.drag];
    q.x = Math.max(0, Math.min(this.canvas.width, p.x + this.dragOffset.x));
    q.y = Math.max(0, Math.min(this.canvas.height, p.y + this.dragOffset.y));
    this.pointer = p;
    e.preventDefault();
    this.draw();
  }

  _up() {
    if (this.drag < 0) return;
    this.drag = -1;
    this.draw();
    this.onChange && this.onChange(this.getQuad());
  }

  draw() {
    const { ctx, canvas, img, quad } = this;
    if (!img) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    if (!quad) return;
    const s = this._scale();
    const lw = Math.max(1, 2 * s);

    // dim outside quad
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.moveTo(quad[0].x, quad[0].y);
    for (let i = 3; i >= 0; i--) ctx.lineTo(quad[i].x, quad[i].y);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // grid
    if (this.cols > 1 && this.rows > 1) {
      try {
        const H = homography(rectCorners(1, 1), quad);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(0.5, s);
        ctx.beginPath();
        for (let c = 1; c < this.cols; c++) {
          const a = applyH(H, c / this.cols, 0), b = applyH(H, c / this.cols, 1);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        for (let r = 1; r < this.rows; r++) {
          const a = applyH(H, 0, r / this.rows), b = applyH(H, 1, r / this.rows);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      } catch { /* degenerate quad while dragging */ }
    }

    // outline
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath();
    quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();

    // handles
    const r = 13 * s;
    quad.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = i === this.drag ? 'rgba(224,102,47,0.6)' : 'rgba(255,179,71,0.35)';
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${11 * s}px system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LABELS[i], p.x, p.y - r - 9 * s);
    });

    if (this.drag >= 0) this._drawLoupe(s);
  }

  _drawLoupe(s) {
    const { ctx, canvas, img } = this;
    const p = this.quad[this.drag];
    const R = 70 * s, zoom = 3;
    // place loupe in the corner farthest from the finger
    const cx = p.x < canvas.width / 2 ? canvas.width - R - 10 * s : R + 10 * s;
    const cy = R + 10 * s;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    const sr = R / zoom;
    ctx.drawImage(img, p.x - sr, p.y - sr, 2 * sr, 2 * sr, cx - R, cy - R, 2 * R, 2 * R);
    ctx.strokeStyle = '#ff3b30';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3 * s;
    ctx.stroke();
  }
}
