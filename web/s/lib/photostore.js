// Photos waiting to upload, kept on the phone: IndexedDB, since localStorage is too small
// for images. They survive a reload or a closed app. Without IndexedDB (private mode on
// some browsers) they are kept in memory only.
// Accepted (docs/accepted-gaps.md): the connection is opened once. If iOS closes it
// or a write fails, photos silently stay in memory, and a reload loses them; those cards count as
// photographed and aren't retaken. Marks don't depend on any of this.

const DB = 'chgk-photos';
const STORE = 'photos';

/** Photos of tournament `tid` (one IndexedDB for all tournaments). */
export function photoStore(tid, indexedDB = globalThis.indexedDB) {
  if (!indexedDB) {
    return memoryStore();
  }
  const db = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'photo_id'});
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = (mode, fn) =>
    db.then(
      (d) =>
        new Promise((resolve, reject) => {
          const tx = d.transaction(STORE, mode);
          const req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('transaction aborted')); // e.g. quota, at commit
        }),
    );
  const fallback = memoryStore();
  const safe = (promise, alternative) => promise.catch(() => alternative());
  return {
    all: () =>
      safe(
        run('readonly', (s) => s.getAll()).then((recs) => recs.filter((r) => r.tid === tid)),
        fallback.all,
      ),
    put: (rec) =>
      safe(
        run('readwrite', (s) => s.put(rec)),
        () => fallback.put(rec),
      ),
    delete: (id) =>
      safe(
        run('readwrite', (s) => s.delete(id)),
        () => fallback.delete(id),
      ),
  };
}

/** The same interface, in memory (tests; phones without IndexedDB). */
export function memoryStore() {
  const recs = new Map();
  return {
    all: async () => [...recs.values()],
    put: async (rec) => {
      recs.set(rec.photo_id, rec);
    },
    delete: async (id) => {
      recs.delete(id);
    },
  };
}
