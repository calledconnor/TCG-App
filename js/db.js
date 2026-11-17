// Minimaler IndexedDB-Wrapper. Stores: inventory (Bestand), cache (API-Antworten), kv (Einstellungen).
const DB_NAME = 'kartenwert';
const DB_VERSION = 1;
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('inventory')) db.createObjectStore('inventory', { keyPath: 'uid' });
      if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'url' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, val) => tx(store, 'readwrite', (s) => s.put(val)),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
};

export async function kvGet(k, fallback) {
  try {
    const r = await db.get('kv', k);
    return r ? r.v : fallback;
  } catch {
    return fallback;
  }
}
export const kvSet = (k, v) => db.put('kv', { k, v });
