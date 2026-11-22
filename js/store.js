// Tiny IndexedDB key/value store so photos survive the page being reloaded
// (mobile browsers often discard the tab while the camera app is open).
const DB = 'puzzle-resolver', STORE = 'kv';
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  } catch (e) {
    console.warn('storage unavailable', e);
    return undefined;
  }
}

export const put = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const get = (key) => tx('readonly', (s) => s.get(key));
export const del = (key) => tx('readwrite', (s) => s.delete(key));
export const clear =() => tx('readwrite', (s) => s.clear());

export function canvasToBlob(canvas, type = 'image/jpeg', q = 0.92) {
  return new Promise((r) => canvas.toBlob(r, type, q));
}
