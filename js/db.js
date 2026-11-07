// IndexedDB の薄いラッパー
const DB_NAME = 'ipad-note';
const VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('notebooks', { keyPath: 'id' });
        const pages = db.createObjectStore('pages', { keyPath: 'id' });
        pages.createIndex('notebookId', 'notebookId');
        db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const r = fn(t);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export const db = {
  getAll: (store) => run(store, 'readonly', (t) => t.objectStore(store).getAll()),
  get: (store, key) => run(store, 'readonly', (t) => t.objectStore(store).get(key)),
  put: (store, value) => run(store, 'readwrite', (t) => t.objectStore(store).put(value)),
  del: (store, key) => run(store, 'readwrite', (t) => t.objectStore(store).delete(key)),
  pagesOf: (notebookId) =>
    run('pages', 'readonly', (t) => t.objectStore('pages').index('notebookId').getAll(notebookId)),

  deleteNotebook: (nb) =>
    run(['notebooks', 'pages'], 'readwrite', (t) => {
      t.objectStore('notebooks').delete(nb.id);
      const ps = t.objectStore('pages');
      ps.index('notebookId').getAllKeys(nb.id).onsuccess = (e) => {
        for (const key of e.target.result) ps.delete(key);
      };
    }),

  importAll: (data) =>
    run(['notebooks', 'pages'], 'readwrite', (t) => {
      const ns = t.objectStore('notebooks');
      const ps = t.objectStore('pages');
      for (const nb of data.notebooks) ns.put(nb);
      for (const p of data.pages) ps.put(p);
    }),
};
