// Projective geometry: homographies and perspective warping.

/** Solve A x = b (n x n) with partial pivoting. A is array of rows. */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) throw new Error('Degenerate homography');
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const k = M[r][col] / d;
      if (!k) continue;
      for (let c = col; c <= n; c++) M[r][c] -= k * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Homography H (9 numbers, row-major) mapping src[i] -> dst[i] for 4 point pairs [{x,y}]. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return inv;
}

/** Rectangle corners [TL, TR, BR, BL] for a w x h image. */
export const rectCorners = (w, h) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

/** Average aspect ratio (width / height) of a quad [TL, TR, BR, BL]. */
export function quadAspect(q) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wTop = d(q[0], q[1]), wBot = d(q[3], q[2]);
  const hL = d(q[0], q[3]), hR = d(q[1], q[2]);
  return (wTop + wBot) / (hL + hR);
}

/**
 * Warp the quad region of srcCanvas into a new w x h canvas (perspective-correct, bilinear).
 * quad = [TL, TR, BR, BL] in source pixel coordinates.
 */
export function warpQuad(srcCanvas, quad, w, h) {
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const sw = src.width, sh = src.height, sd = src.data;
  const H = homography(rectCorners(w, h), quad); // dst -> src
  const out = new ImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      const ww = H[6] * px + H[7] * py + H[8];
      let sx = (H[0] * px + H[1] * py + H[2]) / ww - 0.5;
      let sy = (H[3] * px + H[4] * py + H[5]) / ww - 0.5;
      const o = (y * w + x) * 4;
      if (sx < 0) sx = 0; if (sy < 0) sy = 0;
      if (sx > sw - 1) sx = sw - 1; if (sy > sh - 1) sy = sh - 1;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const t = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bt = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        od[o + c] = t * (1 - fy) + bt * fy;
      }
      od[o + 3] = 255;
    }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

/** Size of the rectified puzzle image for a given grid and aspect. */
export function rectifiedSize(cols, rows, aspect, maxW = 1400) {
  // Aim for ~36 px per cell, clamped.
  let w = Math.min(maxW, Math.max(400, cols * 36));
  let h = Math.round(w / aspect);
  if (h > maxW) { h = maxW; w = Math.round(h * aspect); }
  return { w, h };
}
