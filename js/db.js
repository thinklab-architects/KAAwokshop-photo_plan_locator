/* ══════════════════════════════════════════════════════════
   IndexedDB — 影像以 Blob 保存，專案結構以 JSON 保存
   關掉分頁不會不見；照片完全不離開這台電腦

   若瀏覽器不給用 IndexedDB（例如某些瀏覽器在 file:// 下會擋、
   或使用者開了無痕/封鎖網站資料），自動退回純記憶體模式：
   功能全部照常，只是關掉分頁就會消失，改由「匯出專案」保存。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';

  const DB_NAME = 'sitelog';
  const DB_VER  = 1;
  const S_KV    = 'kv';
  const S_BLOB  = 'blobs';

  let _db = null;
  let _mem = null;                 // { kv:Map, blobs:Map } — 退回模式時使用

  function goMemory(why) {
    if (_mem) return;
    _mem = { kv: new Map(), blobs: new Map() };
    console.warn('[sitelog] 無法使用 IndexedDB，改用記憶體模式：', why);
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    if (_mem) return Promise.resolve(null);
    return new Promise(res => {
      let req;
      try {
        if (!window.indexedDB) throw new Error('indexedDB 不存在');
        req = indexedDB.open(DB_NAME, DB_VER);
      } catch (e) { goMemory(e); res(null); return; }

      // 部分瀏覽器在被封鎖時既不觸發 success 也不觸發 error
      const bail = setTimeout(() => { goMemory('開啟逾時'); res(null); }, 3000);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(S_KV))   db.createObjectStore(S_KV);
        if (!db.objectStoreNames.contains(S_BLOB)) db.createObjectStore(S_BLOB);
      };
      req.onsuccess = () => { clearTimeout(bail); _db = req.result; res(_db); };
      req.onerror   = () => { clearTimeout(bail); goMemory(req.error); res(null); };
      req.onblocked = () => { clearTimeout(bail); goMemory('被其他分頁鎖住'); res(null); };
    });
  }

  function tx(store, mode, fn) {
    return open().then(db => {
      if (!db) return null;                       // 記憶體模式由呼叫端處理
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out;
        try { out = fn(s); } catch (e) { rej(e); return; }
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror    = () => rej(t.error);
        t.onabort    = () => rej(t.error);
      });
    });
  }

  const memStore = name => _mem[name === S_KV ? 'kv' : 'blobs'];

  async function get(store, key) {
    const r = await tx(store, 'readonly', s => s.get(key));
    return _mem ? memStore(store).get(key) : r;
  }
  async function put(store, key, val) {
    await tx(store, 'readwrite', s => s.put(val, key));
    if (_mem) memStore(store).set(key, val);
  }
  async function del(store, key) {
    await tx(store, 'readwrite', s => s.delete(key));
    if (_mem) memStore(store).delete(key);
  }

  const kvGet = k      => get(S_KV, k);
  const kvSet = (k, v) => put(S_KV, k, v);
  const kvDel = k      => del(S_KV, k);

  const blobGet = id      => get(S_BLOB, id);
  const blobPut = (id, b) => put(S_BLOB, id, b);
  const blobDel = id      => del(S_BLOB, id);

  /** 取出所有 key 以 prefix 開頭的 kv 記錄（多專案清單用） */
  async function kvGetAll(prefix) {
    const db = await open();
    if (!db) {
      const out = [];
      _mem.kv.forEach((v, k) => { if (k.indexOf(prefix) === 0) out.push({ key: k, val: v }); });
      return out;
    }
    return new Promise((res, rej) => {
      const t = db.transaction(S_KV, 'readonly');
      const out = [];
      const req = t.objectStore(S_KV).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if (String(c.key).indexOf(prefix) === 0) out.push({ key: c.key, val: c.value });
        c.continue();
      };
      t.oncomplete = () => res(out);
      t.onerror    = () => rej(t.error);
    });
  }

  async function blobGetMany(ids) {
    const db = await open();
    if (!db) {
      const out = {};
      ids.forEach(id => { out[id] = _mem.blobs.get(id); });
      return out;
    }
    return new Promise((res, rej) => {
      const t = db.transaction(S_BLOB, 'readonly');
      const s = t.objectStore(S_BLOB);
      const out = {};
      ids.forEach(id => { const r = s.get(id); r.onsuccess = () => { out[id] = r.result; }; });
      t.oncomplete = () => res(out);
      t.onerror    = () => rej(t.error);
    });
  }

  async function clearAll() {
    const db = await open();
    if (!db) { _mem.kv.clear(); _mem.blobs.clear(); return; }
    return new Promise((res, rej) => {
      const t = db.transaction([S_KV, S_BLOB], 'readwrite');
      t.objectStore(S_KV).clear();
      t.objectStore(S_BLOB).clear();
      t.oncomplete = () => res();
      t.onerror    = () => rej(t.error);
    });
  }

  SR.db = {
    open, kvGet, kvSet, kvDel, kvGetAll,
    blobGet, blobPut, blobDel, blobGetMany, clearAll,
    isMemoryMode: () => !!_mem
  };
})(window.SR);
