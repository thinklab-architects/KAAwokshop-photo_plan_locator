/* ══════════════════════════════════════════════════════════
   專案狀態 — 單一資料來源，變動後自動存進 IndexedDB

   資料配置：
     kv['app']        → { lastId }
     kv['proj:<id>']  → 一份完整的圖說紀錄（不含影像位元組）
     blobs[<blobId>]  → 影像 Blob，各專案獨立不共用
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, DB = SR.db;

  /* 影像處理上限：
     PHOTO_EDGE 2000px 在 A1 上約 130mm 寬 ≈ 390dpi，遠超印刷所需，
     再大只是拖慢瀏覽器並塞爆資料庫。 */
  const PHOTO_EDGE = 2000;
  const THUMB_EDGE = 320;
  const PLAN_EDGE  = 4000;

  const PREFIX  = 'proj:';
  const APP_KEY = 'app';
  const OLD_KEY = 'project';        // 單專案版本的舊資料，開啟時自動搬遷

  const S = {
    proj: null,
    selId: null,
    _urls: new Map(),
    _listeners: {},
    _saveTimer: null,
    _saving: false
  };

  /* ─────────── 事件 ─────────── */
  function on(evt, fn) { (S._listeners[evt] = S._listeners[evt] || []).push(fn); }
  function emit(evt, payload) { (S._listeners[evt] || []).forEach(fn => fn(payload)); }

  /* ─────────── 空專案 ─────────── */
  const FRAME_KEY = 'sitelog.frameDefault';

  /** 事務所自己的圖框預設：存在 localStorage，新紀錄自動套用 */
  function loadFrameDefault() {
    try {
      const f = JSON.parse(localStorage.getItem(FRAME_KEY));
      if (f && typeof f === 'object') {
        return { office: f.office || '', logo: f.logo || null,
                 extras: Array.isArray(f.extras) ? f.extras.slice(0, 6) : [] };
      }
    } catch (_) {}
    return { office: '', logo: null, extras: [] };
  }

  function saveFrameDefault(frame) {
    try { localStorage.setItem(FRAME_KEY, JSON.stringify(frame)); return true; }
    catch (e) { console.warn(e); return false; }
  }

  function blank() {
    const now = Date.now();
    return {
      v: 2,
      id: U.uid(),
      createdAt: now,
      updatedAt: now,
      meta: { project: '', subject: '', date: U.todayISO(), author: '' },
      plans: [],                        // [{ id, blobId, w, h, name, crop, cal, srcMM }]
      activePlanId: null,
      photos: [],
      opts: {
        paper: 'A3', orient: 'landscape', perSheet: 8,
        font: 1, leaders: true, ghost: true,
        // 版面：auto 自動求解 / sides 只放兩側 / manual 完全照 slots 與 colWPct
        edges: 'auto',
        slots: { L: 4, R: 4, T: 0, B: 0 },
        colWPct: null,
        planBoxes: {},          // 自由排版時各平面圖的位置與大小（mm），鍵為 plan.id
        snap: true,
        // 圖框設定：事務所名稱、logo（dataURL，隨專案與 .sitelog 一起帶走）、額外標題欄位
        frame: loadFrameDefault()
      }
    };
  }

  function normalize(p) {
    const b = blank();
    p.v = 2;
    p.id        = p.id || U.uid();
    p.createdAt = p.createdAt || Date.now();
    p.updatedAt = p.updatedAt || p.createdAt;
    p.meta   = Object.assign({}, b.meta, p.meta || {});
    p.opts   = Object.assign({}, b.opts, p.opts || {});
    // 單平面圖時代的資料 → plans[]；照片的 pin 補上 planId
    if (!Array.isArray(p.plans)) p.plans = [];
    if (p.plan && p.plan.blobId) {
      const legacy = Object.assign({ id: U.uid(), name: '平面圖', crop: null, cal: null, srcMM: null }, p.plan);
      p.plans.push(legacy);
      delete p.plan;
      if (p.opts.planBox) { p.opts.planBoxes = { [legacy.id]: p.opts.planBox }; delete p.opts.planBox; }
      (p.photos || []).forEach(ph => { if (ph.pin && !ph.pin.planId) ph.pin.planId = legacy.id; });
    }
    p.plans.forEach(pl => {
      if (!pl.id) pl.id = U.uid();
      if (pl.crop === undefined) pl.crop = null;
      if (pl.cal === undefined) pl.cal = null;      // 比例尺 { px, mm }：影像寬 px ↔ 實際 mm
      if (pl.srcMM === undefined) pl.srcMM = null;  // 原始紙張尺寸 { w, h } mm（PDF 匯入時已知）
      if (!pl.name) pl.name = '平面圖';
    });
    if (!p.opts.planBoxes || typeof p.opts.planBoxes !== 'object') p.opts.planBoxes = {};
    if (!p.activePlanId || !p.plans.some(pl => pl.id === p.activePlanId)) {
      p.activePlanId = p.plans.length ? p.plans[0].id : null;
    }
    if (p.opts.planScale === undefined) p.opts.planScale = null; // 1:N 的 N；null = 自動大小
    p.opts.slots = Object.assign({ L: 4, R: 4, T: 0, B: 0 }, p.opts.slots || {});
    p.opts.frame = Object.assign({ office: '', logo: null, extras: [] }, p.opts.frame || {});
    if (!Array.isArray(p.opts.frame.extras)) p.opts.frame.extras = [];
    if (p.opts.edges === 'manual') p.opts.edges = 'auto';   // 「自訂格位」模式已移除
    p.photos = (p.photos || []).map(ph => Object.assign({
      caption: '', pin: null, dir: null, anno: [], crop: null,
      slot: null,             // 格位模式：{ side, i }
      box: null,              // 自由排版：{ x, y, w }（mm，高度依照片比例算出）
      sheet: null             // 自由排版：指定在第幾張圖面（跨頁搬移用），null = 依順序自動分頁
    }, ph));
    return p;
  }

  /* ─────────── 物件 URL 快取 ─────────── */
  async function url(blobId) {
    if (!blobId) return '';
    if (S._urls.has(blobId)) return S._urls.get(blobId);
    const blob = await DB.blobGet(blobId);
    if (!blob) return '';
    const u = URL.createObjectURL(blob);
    S._urls.set(blobId, u);
    return u;
  }
  function urlSync(blobId) { return S._urls.get(blobId) || ''; }
  function dropUrl(blobId) {
    if (S._urls.has(blobId)) { URL.revokeObjectURL(S._urls.get(blobId)); S._urls.delete(blobId); }
  }

  /* ─────────── 存檔 ─────────── */
  function save(immediate) {
    if (!S.proj) return Promise.resolve();
    clearTimeout(S._saveTimer);
    const run = () => {
      S.proj.updatedAt = Date.now();
      S._saving = true; emit('save', 'saving');
      return DB.kvSet(PREFIX + S.proj.id, JSON.parse(JSON.stringify(S.proj)))
        .then(() => { S._saving = false; emit('save', 'saved'); })
        .catch(e => {
          S._saving = false; emit('save', 'error');
          console.error(e);
          U.toast('自動存檔失敗：' + (e && e.name === 'QuotaExceededError' ? '瀏覽器儲存空間不足' : e.message), true);
        });
    };
    if (immediate) return run();
    S._saveTimer = setTimeout(run, 400);
    return Promise.resolve();
  }

  function touch(what) { save(); emit('change', what); }

  /* ══════════ 專案管理 ══════════ */

  /** 所有紀錄的摘要，最近編輯排前面 */
  async function listProjects() {
    const rows = await DB.kvGetAll(PREFIX);
    return rows.map(r => {
      const p = r.val || {};
      const photos = p.photos || [];
      const cover = photos.find(x => x.thumbId) || photos[0] || null;
      return {
        id: p.id, meta: p.meta || {}, opts: p.opts || {},
        createdAt: p.createdAt || 0, updatedAt: p.updatedAt || 0,
        photoCount: photos.length,
        pinnedCount: photos.filter(x => x.pin).length,
        hasPlan: !!(p.plans && p.plans.length) || !!p.plan,
        coverId: cover ? (cover.thumbId || cover.blobId)
                       : (p.plans && p.plans[0] ? p.plans[0].blobId : (p.plan ? p.plan.blobId : null))
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function loadProject(id) {
    const data = await DB.kvGet(PREFIX + id);
    if (!data) throw new Error('找不到這份紀錄');
    S.proj = normalize(data);
    S.selId = S.proj.photos.length ? S.proj.photos[0].id : null;
    await warmUrls();
    await DB.kvSet(APP_KEY, { lastId: id });
    emit('change', 'all');
    return S.proj;
  }

  async function createProject(meta) {
    const p = blank();
    if (meta) Object.assign(p.meta, meta);
    await DB.kvSet(PREFIX + p.id, p);
    return p.id;
  }

  async function deleteProject(id) {
    const data = await DB.kvGet(PREFIX + id);
    if (data) {
      const ids = [];
      (data.plans || []).forEach(pl => ids.push(pl.blobId));
      if (data.plan) ids.push(data.plan.blobId);
      (data.photos || []).forEach(p => { ids.push(p.blobId); if (p.thumbId) ids.push(p.thumbId); });
      for (const b of ids) { dropUrl(b); await DB.blobDel(b); }
    }
    await DB.kvDel(PREFIX + id);
    if (S.proj && S.proj.id === id) { S.proj = null; S.selId = null; }
  }

  /** 複製一份，影像也整份複製，兩份彼此完全獨立 */
  async function duplicateProject(id) {
    const src = await DB.kvGet(PREFIX + id);
    if (!src) throw new Error('找不到這份紀錄');
    const copy = normalize(JSON.parse(JSON.stringify(src)));
    const now = Date.now();
    copy.id = U.uid();
    copy.createdAt = now; copy.updatedAt = now;
    copy.meta.subject = (copy.meta.subject || '未命名') + '（複本）';

    const clone = async oldId => {
      if (!oldId) return oldId;
      const blob = await DB.blobGet(oldId);
      if (!blob) return oldId;
      const nid = U.uid();
      await DB.blobPut(nid, blob);
      return nid;
    };
    for (const pl of (copy.plans || [])) pl.blobId = await clone(pl.blobId);
    for (const p of copy.photos) {
      p.id = U.uid();
      p.blobId  = await clone(p.blobId);
      p.thumbId = await clone(p.thumbId);
    }
    await DB.kvSet(PREFIX + copy.id, copy);
    return copy.id;
  }

  function closeProject() {
    clearTimeout(S._saveTimer);
    const p = S.proj;
    S.proj = null; S.selId = null;
    return p ? DB.kvSet(PREFIX + p.id, JSON.parse(JSON.stringify(p))) : Promise.resolve();
  }

  /* ─────────── 啟動與搬遷 ─────────── */
  async function init() {
    // 單專案版本留下的資料 → 轉成第一筆紀錄
    try {
      const old = await DB.kvGet(OLD_KEY);
      if (old && old.photos) {
        const p = normalize(old);
        await DB.kvSet(PREFIX + p.id, p);
        await DB.kvDel(OLD_KEY);
      }
    } catch (e) { console.warn('舊資料搬遷失敗', e); }
  }

  async function warmUrls() {
    const ids = [];
    (S.proj.plans || []).forEach(pl => ids.push(pl.blobId));
    S.proj.photos.forEach(p => { ids.push(p.blobId); if (p.thumbId) ids.push(p.thumbId); });
    if (!ids.length) return;
    const blobs = await DB.blobGetMany(ids);
    // 影像遺失（例如手動清過瀏覽器資料）時，把壞掉的項目剔除，避免整個介面卡住
    const missing = ids.filter(id => !blobs[id]);
    if (missing.length) {
      const bad = new Set(missing);
      S.proj.plans = (S.proj.plans || []).filter(pl => !bad.has(pl.blobId));
      if (!S.proj.plans.some(pl => pl.id === S.proj.activePlanId)) {
        S.proj.activePlanId = S.proj.plans.length ? S.proj.plans[0].id : null;
      }
      S.proj.photos = S.proj.photos.filter(p => !bad.has(p.blobId));
      U.toast('有 ' + missing.length + ' 個影像在本機找不到，已從紀錄移除', true);
      save(true);
    }
    Object.keys(blobs).forEach(id => {
      if (blobs[id] && !S._urls.has(id)) S._urls.set(id, URL.createObjectURL(blobs[id]));
    });
  }

  /* ─────────── 平面圖（可多張） ─────────── */
  const plans      = () => S.proj ? (S.proj.plans || []) : [];
  const planById   = id => plans().find(pl => pl.id === id) || null;
  const activePlan = () => planById(S.proj && S.proj.activePlanId) || plans()[0] || null;

  function setActivePlan(id) {
    if (!S.proj || !planById(id)) return;
    S.proj.activePlanId = id;
    save();
    emit('change', 'plan');
  }

  /**
   * 新增一批平面圖。items: [{ file, meta }]，meta 可含
   *   srcMM  {w,h} 原始紙張 mm（PDF 匯入已知，供輸入式比例尺）
   * @returns 新增的 plan 陣列
   */
  async function addPlans(items) {
    const added = [];
    for (const it of items) {
      const file = it.file || it;
      const meta = it.meta || null;
      try {
        const info = await U.probeImage(file);
        let blob = file, w = info.w, h = info.h;
        if (info.bitmap && Math.max(w, h) > PLAN_EDGE) {
          const r = await U.makeRaster(info.bitmap, PLAN_EDGE, 0.94);
          blob = r.blob; w = r.w; h = r.h;
        }
        if (info.bitmap && info.bitmap.close) info.bitmap.close();

        const blobId = U.uid();
        await DB.blobPut(blobId, blob);
        const pl = {
          id: U.uid(), blobId, w, h,
          name: (file.name || '平面圖').replace(/\.(png|jpe?g|webp|gif|bmp)$/i, ''),
          crop: null,
          cal: null,
          srcMM: (meta && meta.srcMM) ? meta.srcMM : null
        };
        S.proj.plans.push(pl);
        added.push(pl);
        await url(blobId);
      } catch (e) {
        console.error(e);
        U.toast('匯入 ' + (file.name || '平面圖') + ' 失敗', true);
      }
    }
    if (added.length) {
      S.proj.activePlanId = added[0].id;
      touch('plan');
    }
    return added;
  }

  /** 移除平面圖；釘在上面的照片位置點會被清除 */
  function removePlan(id) {
    const i = plans().findIndex(pl => pl.id === id);
    if (i < 0) return 0;
    const pl = S.proj.plans[i];
    dropUrl(pl.blobId);
    DB.blobDel(pl.blobId);
    S.proj.plans.splice(i, 1);
    let unpinned = 0;
    S.proj.photos.forEach(ph => {
      if (ph.pin && ph.pin.planId === id) { ph.pin = null; ph.dir = null; unpinned++; }
    });
    if (S.proj.opts.planBoxes) delete S.proj.opts.planBoxes[id];
    if (S.proj.activePlanId === id) {
      S.proj.activePlanId = S.proj.plans.length ? S.proj.plans[Math.min(i, S.proj.plans.length - 1)].id : null;
    }
    touch('plan');
    return unpinned;
  }

  /* ─────────── 匯入照片 ─────────── */
  async function addPhotos(files) {
    const list = Array.from(files)
      .filter(f => /^image\//.test(f.type))
      .sort((a, b) => U.natCmp(a.name, b.name));
    if (!list.length) { U.toast('沒有可匯入的影像檔', true); return []; }

    const added = [];
    for (const f of list) {
      try {
        const info = await U.probeImage(f);
        if (!info.bitmap) { U.toast('略過 ' + f.name + '（瀏覽器無法解碼）', true); continue; }

        const main  = await U.makeRaster(info.bitmap, PHOTO_EDGE, 0.86);
        const thumb = await U.makeRaster(info.bitmap, THUMB_EDGE, 0.75);
        info.bitmap.close && info.bitmap.close();

        const blobId = U.uid(), thumbId = U.uid();
        await DB.blobPut(blobId, main.blob);
        await DB.blobPut(thumbId, thumb.blob);

        const ph = {
          id: U.uid(), blobId, thumbId,
          w: main.w, h: main.h,
          name: f.name || '',
          caption: '', pin: null, dir: null, anno: [], crop: null
        };
        S.proj.photos.push(ph);
        added.push(ph);
        await url(blobId); await url(thumbId);
      } catch (e) {
        console.error(e);
        U.toast('匯入 ' + f.name + ' 失敗', true);
      }
    }
    if (added.length) touch('photos');
    return added;
  }

  /* ─────────── 照片操作 ───────────
     這幾個 getter 在專案載入前就可能被介面呼叫，因此必須容忍 proj 為 null */
  const photo   = id  => (S.proj && S.proj.photos.find(p => p.id === id)) || null;
  const indexOf = id  => S.proj ? S.proj.photos.findIndex(p => p.id === id) : -1;
  const selected= ()  => photo(S.selId);

  function select(id) {
    if (S.selId === id) return;
    S.selId = id;
    emit('change', 'sel');
  }

  function removePhoto(id) {
    const i = indexOf(id);
    if (i < 0) return;
    const p = S.proj.photos[i];
    dropUrl(p.blobId); dropUrl(p.thumbId);
    DB.blobDel(p.blobId); DB.blobDel(p.thumbId);
    S.proj.photos.splice(i, 1);
    if (S.selId === id) S.selId = (S.proj.photos[i] || S.proj.photos[i - 1] || {}).id || null;
    touch('photos');
  }

  function reorder(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    const arr = S.proj.photos;
    const [it] = arr.splice(fromIdx, 1);
    arr.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, it);
    touch('photos');
  }

  function setPin(id, x, y, planId) {
    const p = photo(id); if (!p) return;
    if (x === null) p.pin = null;
    else {
      const pl = planById(planId) || activePlan();
      if (!pl) return;
      p.pin = { planId: pl.id, x: U.clamp(x, 0, 1), y: U.clamp(y, 0, 1) };
    }
    if (!p.pin) p.dir = null;
    touch('pins');
  }

  function setDir(id, deg) {
    const p = photo(id); if (!p) return;
    p.dir = (deg === null || deg === undefined || deg === '') ? null : ((deg % 360) + 360) % 360;
    touch('pins');
  }

  function setCaption(id, text) {
    const p = photo(id); if (!p) return;
    p.caption = text;
    touch('caption');
  }

  function setAnno(id, anno) {
    const p = photo(id); if (!p) return;
    p.anno = anno;
    touch('anno');
  }

  /** crop 為 {x,y,w,h}（正規化）或 null 表示全圖。裁切不動原始影像，隨時可還原。 */
  function setPhotoCrop(id, crop) {
    const p = photo(id); if (!p) return;
    p.crop = crop;
    touch('crop');
  }
  function setPlanCrop(crop, planId) {
    const pl = planById(planId) || activePlan();
    if (!pl) return;
    pl.crop = crop;
    touch('crop');
  }

  /** 比例尺：影像 px ↔ 實際 mm。null 清除。 */
  function setPlanCal(cal, planId) {
    const pl = planById(planId) || activePlan();
    if (!pl) return;
    pl.cal = (cal && cal.px > 0 && cal.mm > 0)
      ? { px: U.round(cal.px, 2), mm: U.round(cal.mm, 1) } : null;
    touch('plan');
  }

  /** 手動指定照片在報告上的格位；null 表示交還給自動分派 */
  function setSlot(id, slot) {
    const p = photo(id); if (!p) return;
    p.slot = slot;
    touch('opts');
  }

  /** 兩張照片互換格位（拖曳時用），對方沒有手動位置時就記下它目前的位置 */
  function swapSlots(idA, slotA, idB, slotB) {
    const a = photo(idA), b = photo(idB);
    if (a) a.slot = slotB ? { side: slotB.side, i: slotB.i } : null;
    if (b) b.slot = slotA ? { side: slotA.side, i: slotA.i } : null;
    touch('opts');
  }

  /** 一次寫入多張照片的格位（拖曳時要把整頁「凍結」，避免其他照片跟著跑） */
  function setSlots(entries) {
    if (!S.proj) return;
    entries.forEach(e => { const p = photo(e.id); if (p) p.slot = e.slot; });
    touch('opts');
  }

  /* ─────── 自由排版 ─────── */
  /** @param box {x,y,w} mm，null 交還給自動排版 */
  function setBox(id, box, quiet) {
    const p = photo(id); if (!p) return;
    p.box = box;
    if (!quiet) touch('opts');
  }
  function setPlanBox(planId, box, quiet) {
    if (!S.proj) return;
    if (!S.proj.opts.planBoxes) S.proj.opts.planBoxes = {};
    if (box === null) delete S.proj.opts.planBoxes[planId];
    else S.proj.opts.planBoxes[planId] = box;
    if (!quiet) touch('opts');
  }
  /** 拖曳結束才寫入資料庫，過程中只改記憶體避免每次移動都存檔 */
  function commitLayout() { save(); emit('change', 'opts'); }

  /** 一次寫入每張照片所屬的圖面；跨頁拖曳後把整份重新標一遍，索引才不會漂掉 */
  function setSheets(entries) {
    if (!S.proj) return;
    entries.forEach(e => { const p = photo(e.id); if (p) p.sheet = e.sheet; });
    touch('opts');
  }

  function clearBoxes() {
    if (!S.proj) return;
    S.proj.photos.forEach(p => { p.box = null; p.sheet = null; });
    S.proj.opts.planBoxes = {};
    touch('opts');
  }

  function clearSlots() {
    if (!S.proj) return;
    S.proj.photos.forEach(p => { p.slot = null; });
    touch('opts');
  }

  function setMeta(k, v) { S.proj.meta[k] = v; touch('meta'); }
  function setOpt(k, v)  { S.proj.opts[k] = v; touch('opts'); }

  /** 改某一筆紀錄的專案名稱（首頁整個專案重新命名用；那筆紀錄不必開啟中） */
  async function setProjectName(id, name) {
    if (S.proj && S.proj.id === id) { S.proj.meta.project = name; return save(true); }
    const data = await DB.kvGet(PREFIX + id);
    if (!data) return;
    data.meta = data.meta || {};
    data.meta.project = name;
    await DB.kvSet(PREFIX + id, data);   // 不動 updatedAt，排序不會因為改名而跳動
  }

  /* ─────────── 匯出 / 匯入專案檔 ─────────── */
  async function exportProject(id) {
    const src = (S.proj && (!id || S.proj.id === id))
      ? S.proj
      : await DB.kvGet(PREFIX + id);
    if (!src) throw new Error('找不到這份紀錄');

    const out = JSON.parse(JSON.stringify(src));
    out.assets = {};
    const put = async bid => {
      if (!bid || out.assets[bid]) return;
      const b = await DB.blobGet(bid);
      if (b) out.assets[bid] = await U.blobToDataURL(b);
    };
    for (const pl of (out.plans || [])) await put(pl.blobId);
    for (const p of out.photos) { await put(p.blobId); await put(p.thumbId); }
    return new Blob([JSON.stringify(out)], { type: 'application/json' });
  }

  /** 讀入 .sitelog，一律建立成新的一筆紀錄（不覆蓋既有資料），回傳新 id */
  async function importProject(file) {
    return importObject(JSON.parse(await file.text()));
  }

  /**
   * 匯入一份已經解析好的紀錄（.sitelog 的 JSON 內容）。
   * 內建示範資料走這條路 —— 它是 <script> 掛進來的物件，沒有 File 可以讀。
   */
  async function importObject(data) {
    if (!data || !Array.isArray(data.photos)) throw new Error('這不是有效的專案檔');

    const assets = data.assets || {};
    delete data.assets;
    const p = normalize(data);

    // 換新的 blobId，避免和既有紀錄的影像互相覆蓋
    const remap = {};
    for (const oldId of Object.keys(assets)) {
      const nid = U.uid();
      remap[oldId] = nid;
      await DB.blobPut(nid, await U.dataURLToBlob(assets[oldId]));
    }
    const swap = b => (b && remap[b]) || b;
    (p.plans || []).forEach(pl => { pl.blobId = swap(pl.blobId); });
    p.photos.forEach(ph => { ph.blobId = swap(ph.blobId); ph.thumbId = swap(ph.thumbId); });

    const now = Date.now();
    p.id = U.uid(); p.createdAt = now; p.updatedAt = now;
    await DB.kvSet(PREFIX + p.id, p);
    return p.id;
  }

  SR.state = {
    S, on, emit, init, url, urlSync,
    listProjects, loadProject, createProject, deleteProject, duplicateProject, closeProject,
    plans, planById, activePlan, setActivePlan, addPlans, removePlan,
    addPhotos, photo, indexOf, selected, select,
    removePhoto, reorder, setPin, setDir, setCaption, setAnno,
    setPhotoCrop, setPlanCrop, setPlanCal, setSlot, setSlots, swapSlots, clearSlots,
    setBox, setPlanBox, setSheets, commitLayout, clearBoxes, setMeta, setOpt, setProjectName,
    exportProject, importProject, importObject, save, saveFrameDefault,
    isSaving: () => S._saving
  };
})(window.SR);
