// An IndexedDB that holds records in a Map: enough of the API for fonts.js -
// one store keyed by `key`, put / getAll / delete inside a transaction.
//
// For the tests where the user's font library has to be a place bytes can be
// read back from. Without one (plain Node has no IndexedDB) every save fails,
// and a face whose save failed is a different case with rules of its own.
// That case is `full = true` on what this returns: every write is then refused,
// as a disk with no room refuses it, while reads go on working.
export function fakeIndexedDB(rows = new Map()) {
  const later = (fn) => queueMicrotask(fn);
  const api = { rows, full: false };
  const db = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      const tx = {};
      const settle = () => later(() => tx.oncomplete?.());
      tx.objectStore = () => ({
        put(rec) {
          if (api.full) {
            tx.error = new Error('QuotaExceededError');
            later(() => tx.onerror?.());
            return;
          }
          rows.set(rec.key, rec);
          settle();
        },
        delete(key) {
          rows.delete(key);
          settle();
        },
        getAll() {
          const req = {};
          later(() => {
            req.result = [...rows.values()];
            req.onsuccess?.();
          });
          return req;
        },
      });
      return tx;
    },
  };
  api.open = () => {
    const req = { result: db };
    later(() => req.onsuccess?.());
    return req;
  };
  return api;
}
