// Image loading and pixel helpers.

/** Load a File/Blob into a canvas, downscaled so the longest side <= maxDim. */
export async function loadImage(blob, maxDim = 1600) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('Could not read image'));
      im.src = url;
    });
    return imageToCanvas(img, maxDim);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageToCanvas(img, maxDim) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, maxDim / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s)), h = Math.max(1, Math.round(h0 * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

export function getImageData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

export function scaleCanvas(src, maxDim) {
  const s = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (s === 1) return src;
  return imageToCanvas(src, maxDim);
}

// --- sRGB -> CIELAB -------------------------------------------------------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** Convert RGBA ImageData to interleaved Lab Float32Array (L 0..100, a/b ~ -128..127). */
export function toLab(imgData) {
  const { data, width, height } = imgData;
  const n = width * height;
  const out = new Float32Array(n * 3);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = LIN[data[j]], g = LIN[data[j + 1]], b = LIN[data[j + 2]];
    const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
    const fx = f(x), fy = f(y), fz = f(z);
    out[i * 3] = 116 * fy - 16;
    out[i * 3 + 1] = 500 * (fx - fy);
    out[i * 3 + 2] = 200 * (fy - fz);
  }
  return out;
}

/** Bilinear sample of an interleaved 3-channel float image. Returns false if out of bounds. */
export function sample3(img, w, h, x, y, out) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0, fy = y - y0;
  const i00 = (y0 * w + x0) * 3, i10 = (y0 * w + x1) * 3, i01 = (y1 * w + x0) * 3, i11 = (y1 * w + x1) * 3;
  for (let c = 0; c < 3; c++) {
    const top = img[i00 + c] * (1 - fx) + img[i10 + c] * fx;
    const bot = img[i01 + c] * (1 - fx) + img[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return true;
}

export function median(arr) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Otsu threshold for an array of non-negative values. */
export function otsu(values, bins = 128) {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) return 0;
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.floor((v / max) * bins))]++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = i; }
  }
  return ((bestT + 1) / bins) * max;
}

/** Yield to the browser so the UI can repaint during long work. */
export const tick = () => new Promise((r) => setTimeout(r, 0));
