'use strict';

// Extension-origin IndexedDB is not exposed to the site's content script.
const PM_DB = (() => {
  let opening;
  function open() {
    if (!opening) opening = new Promise((resolve, reject) => {
      const req = indexedDB.open('position-matcher-social', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('state');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error('Не удалось открыть хранилище Social Check'));
    });
    return opening;
  }
  async function run(mode, key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', mode), store = tx.objectStore('state');
      const req = mode === 'readonly' ? store.get(key) : value === undefined ? store.delete(key) : store.put(value, key);
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new Error('Ошибка сохранения Social Check'));
    });
  }
  return { get: key => run('readonly', key), set: (key, value) => run('readwrite', key, value), delete: key => run('readwrite', key) };
})();
