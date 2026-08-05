/* ══════════════════════════════════════════════════════════
   介面組裝、主介面 ↔ 編輯器導覽、啟動
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state;
  const { $, $$, el } = U;

  let inEditor = false;

  // 內部 HTML5 拖曳進行中（清單排序、報告互換）。
  // 瀏覽器拖曳含 <img> 的元素時會把圖檔塞進 dataTransfer，
  // 沒有這個旗標的話，拖曳排序放開在清單外就會被拖放匯入當成新照片收下。
  let internalDrag = false;
  const setInternalDrag = v => { internalDrag = !!v; };

  /* ══════════ 導覽 ══════════ */
  async function openProject(id) {
    try {
      await ST.loadProject(id);
    } catch (e) {
      console.error(e);
      U.toast('開啟失敗：' + e.message, true);
      return;
    }
    inEditor = true;
    $('#homeView').hidden = true;
    $('#editorView').hidden = false;
    refreshMeta();
    refreshCaptionBox();
    await SR.plan.refresh();
    await SR.photo.refresh();
    // 版面此時才有寬高，平面圖要等一幀再置中
    requestAnimationFrame(() => SR.plan.fit());
  }

  async function goHome() {
    if (SR.plan.isCropping()) SR.plan.endCrop(false);
    if (SR.plan.isCalibrating()) SR.plan.endCal(false);
    if (SR.photo.isCropping()) SR.photo.endCrop(false);
    await ST.save(true);
    await ST.closeProject();
    inEditor = false;
    $('#editorView').hidden = true;
    $('#homeView').hidden = false;
    await SR.home.refresh();
  }

  /* ══════════ 側欄寬度 ══════════ */
  const WKEY = 'sitelog.paneWidths';
  const LIMITS = { L: [140, 480], R: [260, 760] };
  const DEFAULTS = { L: 210, R: 400 };

  function applyWidths(w) {
    const ws = $('#workspace');
    ws.style.setProperty('--wL', w.L + 'px');
    ws.style.setProperty('--wR', w.R + 'px');
  }

  function loadWidths() {
    try {
      const w = JSON.parse(localStorage.getItem(WKEY));
      if (w && w.L && w.R) return w;
    } catch (_) {}
    return Object.assign({}, DEFAULTS);
  }

  function mountResizers() {
    const widths = loadWidths();
    applyWidths(widths);

    const setup = (handle, side) => {
      handle.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const startX = e.clientX;
        const start = widths[side];
        const [lo, hi] = LIMITS[side];
        handle.classList.add('dragging');
        document.body.classList.add('resizing');
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}

        const move = ev => {
          // 右欄往左拖是變寬，所以方向相反
          const d = (ev.clientX - startX) * (side === 'L' ? 1 : -1);
          // 另外保證中間的平面圖區至少留 240px，不然會被兩側擠成 0 寬
          const other = widths[side === 'L' ? 'R' : 'L'];
          const room = Math.max(lo, window.innerWidth - other - 250);
          widths[side] = U.clamp(Math.round(start + d), lo, Math.min(hi, room));
          applyWidths(widths);
        };
        const up = ev => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          handle.classList.remove('dragging');
          document.body.classList.remove('resizing');
          try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
          localStorage.setItem(WKEY, JSON.stringify(widths));
          SR.photo.refresh();          // 照片框要依新寬度重算
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
        e.preventDefault();
      });

      handle.addEventListener('dblclick', () => {
        widths[side] = DEFAULTS[side];
        applyWidths(widths);
        localStorage.setItem(WKEY, JSON.stringify(widths));
        SR.photo.refresh();
      });
    };

    setup($('#resizeL'), 'L');
    setup($('#resizeR'), 'R');
  }

  /* ══════════ 照片清單 ══════════ */
  const listEl = () => $('#photoList');

  function renderList() {
    const ul = listEl();
    const photos = ST.S.proj ? ST.S.proj.photos : [];
    ul.textContent = '';
    photos.forEach((p, i) => ul.appendChild(listItem(p, i)));
    $('#photoCount').textContent = photos.length;
    $('#photoEmpty').hidden = photos.length > 0;
  }

  function listItem(p, i) {
    const li = el('li', 'photoItem' + (p.id === ST.S.selId ? ' sel' : ''));
    li.dataset.id = p.id;
    li.draggable = true;

    li.appendChild(el('span', 'piNum', String(i + 1)));

    const th = new Image();
    th.className = 'piThumb';
    th.src = ST.urlSync(p.thumbId) || ST.urlSync(p.blobId);
    th.alt = '';
    th.draggable = false;
    li.appendChild(th);

    const meta = el('div', 'piMeta');
    meta.appendChild(el('div', 'piCap' + (p.caption ? '' : ' none'),
      p.caption || (p.name || '未填寫說明')));

    const flags = el('div', 'piFlags');
    let pinTxt = p.pin ? '已定位' : '未定位';
    if (p.pin && ST.plans().length > 1) {
      // 多張平面圖時直接標樓層名，一眼看出照片釘在哪張圖
      const pl = ST.planById(p.pin.planId);
      if (pl) pinTxt = pl.name.length > 7 ? pl.name.slice(0, 7) + '…' : pl.name;
    }
    flags.appendChild(el('span', 'flag ' + (p.pin ? 'on' : 'warn'), pinTxt));
    if (p.anno && p.anno.length) flags.appendChild(el('span', 'flag on', '標註 ' + p.anno.length));
    if (p.crop) flags.appendChild(el('span', 'flag on', '已裁切'));
    if (p.dir !== null && p.dir !== undefined) flags.appendChild(el('span', 'flag on', p.dir + '°'));
    meta.appendChild(flags);

    li.appendChild(meta);
    li.addEventListener('click', () => ST.select(p.id));
    return li;
  }

  function patchSelection() {
    $$('.photoItem').forEach(li => li.classList.toggle('sel', li.dataset.id === ST.S.selId));
    const sel = $('.photoItem.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  /* ─────────── 拖曳排序 ─────────── */
  let dragId = null;

  function mountDragSort() {
    const ul = listEl();

    ul.addEventListener('dragstart', e => {
      const li = e.target.closest('.photoItem');
      if (!li) return;
      dragId = li.dataset.id;
      setInternalDrag(true);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });

    ul.addEventListener('dragend', () => {
      dragId = null;
      setInternalDrag(false);
      $$('.photoItem').forEach(n => n.classList.remove('dragging', 'dropBefore', 'dropAfter'));
    });

    ul.addEventListener('dragover', e => {
      if (!dragId) return;                       // 只處理內部排序，外部檔案交給全域處理
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const li = e.target.closest('.photoItem');
      $$('.photoItem').forEach(n => n.classList.remove('dropBefore', 'dropAfter'));
      if (!li || li.dataset.id === dragId) return;
      const r = li.getBoundingClientRect();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'dropBefore' : 'dropAfter');
    });

    ul.addEventListener('drop', e => {
      if (!dragId) return;
      e.preventDefault();
      e.stopPropagation();
      const li = e.target.closest('.photoItem');
      const from = ST.indexOf(dragId);
      let to;
      if (!li) to = ST.S.proj.photos.length;
      else {
        const r = li.getBoundingClientRect();
        to = ST.indexOf(li.dataset.id) + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      }
      $$('.photoItem').forEach(n => n.classList.remove('dropBefore', 'dropAfter'));
      ST.reorder(from, to);
      dragId = null;
    });
  }

  /* ══════════ 說明文字 / 方向 ══════════ */
  function refreshCaptionBox() {
    const p = ST.selected();
    const ta = $('#capText'), dir = $('#dirAngle');

    ta.disabled = !p;
    dir.disabled = !p || !p.pin;
    $('#btnClearDir').disabled = !p || p.dir === null || p.dir === undefined;
    $('#btnClearPin').disabled = !p || !p.pin;
    $('#btnDelPhoto').disabled = !p;
    $('#btnCropPhoto').disabled = !p;

    if (!p) { ta.value = ''; dir.value = ''; $('#capCounter').textContent = '0'; return; }
    if (document.activeElement !== ta) ta.value = p.caption || '';
    if (document.activeElement !== dir) dir.value = (p.dir === null || p.dir === undefined) ? '' : p.dir;
    $('#capCounter').textContent = (p.caption || '').length;
  }

  /* ══════════ 專案基本資料 ══════════ */
  const META = { mProject: 'project', mSubject: 'subject', mDate: 'date', mAuthor: 'author' };

  function refreshMeta() {
    if (!ST.S.proj) return;
    const m = ST.S.proj.meta;
    for (const id in META) {
      const n = document.getElementById(id);
      if (document.activeElement !== n) n.value = m[META[id]] || '';
    }
  }

  /* ══════════ 檔案匯入 ══════════ */
  async function importPhotos(files) {
    U.toast('匯入中…');
    // 影像直接收；PDF 先在本機轉成影像（每頁一張）
    const ex = await SR.convert.expandForPhotos(Array.from(files));
    ex.notes.forEach(n => U.toast(n, true));
    if (!ex.files.length) { if (!ex.notes.length) U.toast('沒有可匯入的檔案', true); return; }
    const added = await ST.addPhotos(ex.files);
    if (added.length) {
      if (!ST.S.selId) ST.select(added[0].id);
      U.toast('已匯入 ' + added.length + ' 張照片');
    }
  }

  async function importPlan(file) {
    try {
      // 一個檔案可能變成多張平面圖（PDF 每頁一張）；PDF 會附帶原始頁面尺寸供比例尺用
      const items = await SR.convert.plansFromFile(file);
      if (!items.length) return;                          // 使用者取消選頁
      U.toast('載入平面圖…');
      const added = await ST.addPlans(items);
      U.toast(added.length > 1 ? '已加入 ' + added.length + ' 張平面圖' : '平面圖已載入');
    } catch (e) { console.error(e); U.toast('平面圖載入失敗：' + e.message, true); }
  }

  function mountFileInputs() {
    $('#btnAddPhotos').addEventListener('click', () => $('#filePhotos').click());
    $('#btnAddPlan').addEventListener('click',   () => $('#filePlan').click());

    $('#filePhotos').addEventListener('change', async e => {
      if (e.target.files.length) await importPhotos(e.target.files);
      e.target.value = '';
    });
    $('#filePlan').addEventListener('change', async e => {
      if (e.target.files[0]) await importPlan(e.target.files[0]);
      e.target.value = '';
    });
    $('#fileProj').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const id = await SR.home.importFile(f);
      if (id && !inEditor) { /* 停在主介面，讓使用者看到新加入的那一張卡 */ }
    });

    $('#btnSaveFile').addEventListener('click', async () => {
      const p = ST.S.proj;
      if (!p || (!p.photos.length && !p.plans.length)) { U.toast('目前沒有內容可匯出', true); return; }
      U.toast('打包中…');
      try {
        const blob = await ST.exportProject(p.id);
        const name = [(p.meta.project || '圖說紀錄'), (p.meta.subject || ''), (p.meta.date || '')]
          .filter(Boolean).join('_').replace(/[\\/:*?"<>|]/g, '-');
        U.downloadBlob(blob, name + '.sitelog');
        U.toast('已匯出紀錄檔');
      } catch (e) { console.error(e); U.toast('匯出失敗：' + e.message, true); }
    });

    $('#btnBackHome').addEventListener('click', goHome);
  }

  /* ══════════ 拖放匯入 ══════════
     只接受「從系統拖進來」的檔案。內部拖曳（清單排序、報告互換）期間
     internalDrag 為真，全域 drop 一律忽略 —— 這就是之前
     「換個順序卻多一張照片」的解法：問題不在拖放匯入本身，
     而在瀏覽器會把被拖的 <img> 一併塞進 dataTransfer 的檔案清單。 */
  function mountDropZone() {
    const veil = $('#dropVeil');
    const msg = $('#dropVeilMsg');
    let depth = 0;

    const external = e => !internalDrag &&
      e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    window.addEventListener('dragenter', e => {
      if (!external(e)) return;
      e.preventDefault();
      depth++;
      msg.textContent = inEditor
        ? '放開以匯入 —— 丟在平面圖區當平面圖，其他地方當照片'
        : '放開以匯入 —— 照片會自動開一份新紀錄，.sitelog 直接讀入';
      veil.hidden = false;
    });
    window.addEventListener('dragover', e => { if (external(e)) e.preventDefault(); });
    window.addEventListener('dragleave', e => {
      if (!external(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) veil.hidden = true;
    });

    window.addEventListener('drop', async e => {
      if (!external(e)) { depth = 0; veil.hidden = true; return; }
      e.preventDefault();
      depth = 0; veil.hidden = true;

      const files = Array.from(e.dataTransfer.files);
      if (!files.length) return;

      const proj = files.find(f => /\.(sitelog|json)$/i.test(f.name));
      if (proj) { await SR.home.importFile(proj); if (!inEditor) await SR.home.refresh(); return; }

      const C = SR.convert;
      // CAD 檔已不支援，但認得出來就講清楚，不要丟一句籠統的「不支援」
      if (files.some(C.isCad)) U.toast(C.CAD_HINT, true);
      const usable = files.filter(f => C.isImage(f) || C.isPdf(f));
      if (!usable.length) {
        if (!files.some(C.isCad)) U.toast('支援：影像、PDF、.sitelog', true);
        return;
      }

      if (!inEditor) {
        // 主介面收到檔案 → 自動開一份新紀錄
        const id = await ST.createProject();
        await openProject(id);
      }

      // 丟在平面圖區 → 全部當平面圖，其他地方 → 當照片
      const onPlan = (e.target.closest && e.target.closest('.panePlan')) || null;
      if (onPlan && inEditor) { for (const f of usable) await importPlan(f); }
      else await importPhotos(usable);
    });
  }

  /* ══════════ 鍵盤 ══════════ */
  const TOOL_KEYS = { v: 'select', p: 'pen', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };

  function mountKeys() {
    document.addEventListener('keydown', e => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '');
      if (typing || SR.report.isOpen() || !inEditor) return;
      if (SR.plan.isCropping() || SR.photo.isCropping()) {
        if (e.key === 'Escape') {
          if (SR.plan.isCropping())  SR.plan.endCrop(false);
          if (SR.photo.isCropping()) SR.photo.endCrop(false);
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); SR.photo.undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (TOOL_KEYS[k]) { SR.photo.setTool(TOOL_KEYS[k]); e.preventDefault(); return; }

      if (e.key === 'Delete' || e.key === 'Backspace') { SR.photo.deleteSelected(); e.preventDefault(); return; }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const arr = ST.S.proj ? ST.S.proj.photos : [];
        if (!arr.length) return;
        const i = ST.indexOf(ST.S.selId);
        const ni = U.clamp((i < 0 ? 0 : i) + (e.key === 'ArrowDown' ? 1 : -1), 0, arr.length - 1);
        ST.select(arr[ni].id);
        e.preventDefault();
      }
    });
  }

  function mountNav() {
    const step = d => {
      const arr = ST.S.proj ? ST.S.proj.photos : [];
      if (!arr.length) return;
      const i = ST.indexOf(ST.S.selId);
      ST.select(arr[U.clamp((i < 0 ? 0 : i) + d, 0, arr.length - 1)].id);
    };
    $('#btnPrev').addEventListener('click', () => step(-1));
    $('#btnNext').addEventListener('click', () => step(1));
  }

  /* ══════════ 欄位綁定 ══════════ */
  function mountFields() {
    for (const id in META) {
      document.getElementById(id).addEventListener('input', e => ST.setMeta(META[id], e.target.value));
    }

    $('#capText').addEventListener('input', e => {
      const p = ST.selected(); if (!p) return;
      ST.setCaption(p.id, e.target.value);
    });

    $('#dirAngle').addEventListener('input', e => {
      const p = ST.selected(); if (!p || !p.pin) return;
      const v = e.target.value.trim();
      ST.setDir(p.id, v === '' ? null : Number(v));
    });

    $('#btnClearDir').addEventListener('click', () => {
      const p = ST.selected(); if (p) ST.setDir(p.id, null);
    });
    $('#btnClearPin').addEventListener('click', () => {
      const p = ST.selected(); if (p) ST.setPin(p.id, null);
    });
    $('#btnDelPhoto').addEventListener('click', () => {
      const p = ST.selected(); if (!p) return;
      if (!confirm('刪除第 ' + (ST.indexOf(p.id) + 1) + ' 張照片？')) return;
      ST.removePhoto(p.id);
    });
  }

  /* ══════════ 存檔指示 ══════════ */
  function mountSaveState() {
    const n = $('#saveState');
    ST.on('save', st => {
      n.classList.toggle('saving', st === 'saving');
      n.classList.toggle('error', st === 'error');
      n.textContent = st === 'saving' ? '儲存中…' : st === 'error' ? '未儲存' : '已儲存';
    });
  }

  /* ══════════ 狀態變動 → 介面 ══════════ */
  function onChange(what) {
    if (!inEditor && what !== 'all') return;
    if (what === 'sel') { patchSelection(); refreshCaptionBox(); return; }
    if (what === 'meta' || what === 'opts') return;

    renderList();
    refreshCaptionBox();
    if (what === 'all') refreshMeta();
  }

  /* ══════════ 啟動 ══════════ */
  async function boot() {
    SR.plan.mount();
    SR.photo.mount();
    SR.report.mount();
    SR.home.mount();
    mountFileInputs();
    mountDropZone();
    mountDragSort();
    mountKeys();
    mountNav();
    mountFields();
    mountResizers();
    mountSaveState();

    ST.on('change', onChange);

    try {
      await ST.init();
    } catch (e) {
      console.error(e);
      U.toast('無法讀取本機存檔', true);
    }

    if (SR.db.isMemoryMode()) {
      const foot = $('.paneList .paneFoot .hint');
      foot.textContent = '⚠ 這個瀏覽器不允許本機儲存，關掉分頁內容就會消失 — 請用「匯出紀錄檔」保存';
      foot.style.color = '#e8b366';
      U.toast('自動存檔無法使用，請記得手動「匯出紀錄檔」', true);
    }

    // 全新的電腦上先放兩份示範紀錄，才不會開起來是一片空白
    await SR.sample.maybeSeed();

    await SR.home.refresh();

    // 離開前把未寫入的變更 flush 掉
    window.addEventListener('beforeunload', () => { if (ST.S.proj) ST.save(true); });
  }

  SR.app = { openProject, goHome, setInternalDrag, isEditor: () => inEditor };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.SR);
