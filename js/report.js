/* ══════════════════════════════════════════════════════════
   報告產生 — 把 layout.js 算出的 mm 座標畫成 DOM
   螢幕預覽用 transform 縮放；列印時移除縮放並以 @page 指定實際紙張
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state, LO = SR.layout, CROP = SR.crop;
  const { $, el, svgEl, round } = U;

  const MM_PX = 96 / 25.4;        // CSS 標準：1mm = 3.7795px
  let sheets = [];

  /* ─────────── 開 / 關 ─────────── */
  function open() {
    const p = ST.S.proj;
    if (!p.photos.length) { U.toast('還沒有照片，先匯入幾張再產生報告', true); return; }
    syncControls();
    $('#reportModal').hidden = false;
    document.body.style.overflow = 'hidden';
    render();
  }
  function close() {
    $('#reportModal').hidden = true;
    document.body.style.overflow = '';
  }

  function syncControls() {
    const o = ST.S.proj.opts;
    $('#optPaper').value    = o.paper;
    $('#optOrient').value   = o.orient;
    $('#optPerSheet').value = String(o.perSheet);
    $('#optFont').value     = String(o.font || 1);
    $('#optEdges').value    = o.edges || 'auto';
    // 沒有任何一張平面圖有比例尺時，比例形同關閉，選單顯示「自動大小」
    const calOk = ST.plans().some(p => p.cal && p.cal.px > 0);
    $('#optScale').value = (o.planScale && calOk) ? String(o.planScale) : '';
    syncFreeBar();
    $('#optLeaders').checked= !!o.leaders;
    $('#optGhost').checked  = !!o.ghost;
  }

  function syncFreeBar() {
    const o = ST.S.proj.opts;
    const free = o.edges === 'free';
    $('#freeBar').hidden = !free;
    if (free) $('#optSnap').checked = o.snap !== false;
  }

  /* ─────────── 主要繪製 ─────────── */
  function render() {
    const proj = ST.S.proj;
    sheets = LO.build(proj);

    const host = $('#sheets');
    host.textContent = '';
    sheets.forEach(s => host.appendChild(buildSheet(s, proj)));

    const o = proj.opts;
    const noPin = proj.photos.filter(p => !p.pin).length;
    // cropped 是「每張平面圖」的統計，同一張圖的多頁只算一次
    const cut = sheets.reduce((n, s) => n + (s.localIndex === 0 ? s.cropped : 0), 0);
    const scales = Array.from(new Set(sheets.filter(s => s.scaleUsed).map(s => s.scaleUsed)));
    const warnSheet = sheets.find(s => s.scaleWarn);
    $('#sheetInfo').textContent =
      `${sheets.length} 張圖面` +
      (sheets[0].planCount > 1 ? `（${sheets[0].planCount} 張平面圖）` : '') +
      ` · ${o.paper} ${o.orient === 'portrait' ? '直式' : '橫式'}` +
      ` · ${sheets[0].rows}+${sheets[0].rows}` +
      (sheets[0].topCount || sheets[0].bottomCount
        ? ` 兩側，上 ${sheets[0].topCount} 下 ${sheets[0].bottomCount}` : ' 兩側') +
      (scales.length ? ` · 平面圖 1:${scales.join('、1:')}` : '') +
      (warnSheet
        ? ` · ⚠ ${warnSheet.planCount > 1 ? '「' + warnSheet.planName + '」' : ''}1:${warnSheet.scaleWarn.want} 需 ${warnSheet.scaleWarn.needW}×${warnSheet.scaleWarn.needH}mm 放不下，已縮至約 1:${warnSheet.scaleWarn.actual} —— 換大紙張或小比例`
        : '') +
      (noPin ? ` · ${noPin} 張照片未標位置` : '') +
      (cut ? ` · ${cut} 個位置點在裁切範圍外` : '');

    fitCaptions();
    fitScale();
    setPageSize(sheets[0].W, sheets[0].H);
    syncFreeBar();
    if (SR.arrange) SR.arrange.refresh();
  }

  /**
   * 說明文字若超出卡片高度就逐級縮小字級，寧可字小一點也不要被裁掉。
   * 縮到下限仍放不下時才截斷，並在最後補上刪節號。
   */
  function fitCaptions() {
    U.$$('.sh-cap').forEach(cap => {
      const base = parseFloat(getComputedStyle(cap).fontSize);
      if (!base) return;
      let px = base;
      const min = base * 0.68;
      let guard = 24;
      while (cap.scrollHeight > cap.clientHeight + 1 && px > min && guard-- > 0) {
        px -= base * 0.04;
        cap.style.fontSize = px + 'px';
        cap.style.lineHeight = '1.28';
      }
      cap.classList.toggle('clipped', cap.scrollHeight > cap.clientHeight + 1);
    });
  }

  function setPageSize(W, H) {
    let st = document.getElementById('pageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
    st.textContent = `@page{ size:${W}mm ${H}mm; margin:0; }`;
  }

  /** 依視窗寬度縮放預覽 */
  function fitScale() {
    if (!sheets.length) return;
    const scroll = $('#reportScroll');
    const avail = scroll.clientWidth - 56;
    const s = sheets[0];
    const pxW = s.W * MM_PX, pxH = s.H * MM_PX;
    const k = Math.min(1, avail / pxW);

    U.$$('.sheetBox').forEach(box => {
      box.style.width  = Math.round(pxW * k) + 'px';
      box.style.height = Math.round(pxH * k) + 'px';
      box.firstElementChild.style.transform = `scale(${k})`;
    });
  }

  /* ─────────── 單張圖面 ─────────── */
  function buildSheet(s, proj) {
    const box = el('div', 'sheetBox');
    const sh  = el('div', 'sheet');
    sh.style.width  = s.W + 'mm';
    sh.style.height = s.H + 'mm';
    sh.style.setProperty('--fs', s.font);      // 全圖面文字等比縮放
    const tf = s.titleFont;
    sh.style.setProperty('--t-k', tf.k + 'mm');
    sh.style.setProperty('--t-v', tf.v + 'mm');
    sh.style.setProperty('--t-w', tf.w + 'mm');
    sh.style.setProperty('--t-p', tf.p + 'mm');
    sh.style.setProperty('--t-pad', tf.pad + 'mm');
    if (s.free) sh.classList.add('freeMode');

    /* 圖框 */
    const fr = el('div', 'sh-frame');
    css(fr, { left: s.M, top: s.M, width: s.W - 2 * s.M, height: s.H - 2 * s.M });
    sh.appendChild(fr);

    /* 標題欄 */
    sh.appendChild(titleBlock(s, proj));

    /* 平面圖（每張圖面用自己那一張） */
    if (s.planImg) {
      // planImg 已經是「裁切後」尺寸的 contain 結果，所以框跟圖等比，直接套 imgStyle
      const pb = el('div', 'sh-planbox');
      css(pb, { left: s.planImg.x, top: s.planImg.y, width: s.planImg.w, height: s.planImg.h });
      if (s.free) {
        pb.dataset.arrId = 'plan:' + s.planId;
        // 比例鎖定時尺寸是 1:N 算出來的，不給縮放把手（仍可拖曳移動）
        if (!s.scaleUsed) pb.appendChild(el('div', 'sh-handle'));
      }
      const plan = ST.planById(s.planId);
      const im = new Image();
      im.src = ST.urlSync(s.planBlobId);
      im.alt = '';
      Object.assign(im.style, CROP.imgStyle(plan || {}));
      pb.appendChild(im);
      // 多張平面圖時印出圖名，一看就知道這頁是哪一層
      if (s.planCount > 1 && s.planName) {
        pb.appendChild(el('div', 'sh-planname', s.planName));
      }
      // SCALE 標示：有指定比例才印，跟著平面圖右下角
      if (s.scaleUsed) {
        const lb = el('div', 'sh-scale', 'SCALE 1:' + s.scaleUsed);
        pb.appendChild(lb);
      }
      sh.appendChild(pb);
    } else {
      const np = el('div', 'sh-noplan', '尚未載入平面圖');
      css(np, { left: s.planBox.x, top: s.planBox.y, width: s.planBox.w, height: s.planBox.h });
      sh.appendChild(np);
    }

    /* 空格位：手動模式下當作拖曳落點，列印時隱藏 */
    s.empties.forEach(e => {
      const n = el('div', 'sh-slot');
      css(n, { left: e.x, top: e.y, width: e.w, height: e.h });
      n.dataset.side = e.side; n.dataset.idx = e.idx;
      sh.appendChild(n);
    });

    /* 照片卡 */
    s.cards.forEach(c => sh.appendChild(card(c)));


    /* 引線與位置點（疊在最上層） */
    sh.appendChild(leaderLayer(s));

    box.appendChild(sh);
    return box;
  }

  function css(node, mm) {
    for (const k in mm) node.style[k] = mm[k] + 'mm';
  }

  function titleBlock(s, proj) {
    const m = proj.meta;
    const fr = proj.opts.frame || {};
    const t = el('div', 'sh-title');
    css(t, { left: s.M, top: s.M, width: s.W - 2 * s.M, height: s.TH });

    const cell = (key, val, cls) => {
      const c = el('div', 'sh-cell' + (cls ? ' ' + cls : ''));
      c.appendChild(el('div', 'k', key));
      c.appendChild(el('div', 'v', val || '—'));
      return c;
    };

    // 事務所格（logo＋名稱）放最左 —— 事務所自訂圖框的主角
    if (fr.logo || fr.office) {
      const oc = el('div', 'sh-cell office');
      if (fr.logo) {
        const im = new Image();
        im.src = fr.logo;
        im.alt = '';
        im.className = 'sh-logo';
        im.style.height = (s.TH * 0.62) + 'mm';
        oc.appendChild(im);
      }
      if (fr.office) oc.appendChild(el('div', 'on', fr.office));
      t.appendChild(oc);
    }

    // 只有前兩格會伸縮，其餘依內容自動撐寬，所以日期與圖號永遠不會被切掉
    t.appendChild(cell('專案名稱', m.project, 'grow wide'));
    t.appendChild(cell('紀錄項目', m.subject, 'grow'));
    (fr.extras || []).forEach(x => {
      if (x && (x.k || x.v)) t.appendChild(cell(x.k || '', x.v || ''));
    });
    t.appendChild(cell('日期', U.fmtDate(m.date)));
    t.appendChild(cell('紀錄者', m.author));
    t.appendChild(cell('圖號', s.index + ' / ' + s.total, 'pageno'));
    return t;
  }

  /** 照片與說明；兩者的絕對 mm 矩形都由 layout 算好，這裡只負責畫 */
  function card(c) {
    const frag = document.createDocumentFragment();

    const fr = el('div', 'sh-imgframe');
    css(fr, { left: c.imgRect.x, top: c.imgRect.y, width: c.imgRect.w, height: c.imgRect.h });
    fr.dataset.id = c.id;
    fr.dataset.side = c.side;
    fr.dataset.idx = c.idx;
    if (c.free !== undefined || ST.S.proj.opts.edges === 'free') {
      fr.dataset.arrId = c.id;               // 自由排版：任意拖放
      fr.appendChild(el('div', 'sh-handle'));
      fr.title = '拖曳移動，右下角把手縮放';
    } else {
      fr.draggable = true;                   // 格位模式：拖到另一張照片上即互換
      fr.title = '拖曳可與其他照片互換位置';
    }

    const im = new Image();
    im.src = ST.urlSync(c.photo.blobId);
    im.alt = c.photo.name || '';
    Object.assign(im.style, CROP.imgStyle(c.photo));
    fr.appendChild(im);

    if (c.photo.anno && c.photo.anno.length) {
      const ov = svgEl('svg', { class: 'anno', preserveAspectRatio: 'none' });
      SR.photo.renderAnno(ov, c.photo.anno, c.photo.h / c.photo.w, false, c.photo.crop);
      fr.appendChild(ov);
    }
    fr.appendChild(el('div', 'sh-badge', String(c.num)));
    frag.appendChild(fr);

    const cap = el('div', 'sh-cap' + (c.photo.caption ? '' : ' empty'));
    css(cap, { left: c.capRect.x, top: c.capRect.y, width: c.capRect.w, height: c.capRect.h });
    // 沒填說明就整條留白（連編號都不出現），預覽和列印一致
    if (c.photo.caption) {
      cap.appendChild(el('span', 'cn', String(c.num) + '.'));
      cap.appendChild(document.createTextNode(c.photo.caption));
    }
    frag.appendChild(cap);

    return frag;
  }

  function leaderLayer(s) {
    const svg = svgEl('svg', {
      class: 'sh-leaders', viewBox: `0 0 ${s.W} ${s.H}`,
      width: '100%', height: '100%', preserveAspectRatio: 'none'
    });
    svg.style.width = s.W + 'mm';
    svg.style.height = s.H + 'mm';

    // 其他頁的位置點
    s.ghosts.forEach(g => {
      svg.appendChild(svgEl('circle', { class: 'ld-ghost', cx: g.x, cy: g.y, r: s.pinR * 0.8 }));
    });

    s.leaders.forEach(l => {
      // 引線
      svg.appendChild(svgEl('polyline', {
        class: 'ld-line', points: l.pts.map(p => p[0] + ',' + p[1]).join(' ')
      }));
      // 卡片端的小圓點
      svg.appendChild(svgEl('circle', { class: 'ld-dot', cx: l.pts[0][0], cy: l.pts[0][1], r: s.pinR * 0.28 }));

      // 拍攝方向錐
      if (l.dir !== null) {
        const a = (l.dir - 90) * Math.PI / 180, sp = 0.40, R = s.coneR;
        const x = l.pin.x, y = l.pin.y;
        const p1 = [x + Math.cos(a - sp) * R, y + Math.sin(a - sp) * R];
        const p2 = [x + Math.cos(a + sp) * R, y + Math.sin(a + sp) * R];
        svg.appendChild(svgEl('path', {
          class: 'ld-cone',
          d: `M${round(x,2)},${round(y,2)}L${round(p1[0],2)},${round(p1[1],2)}` +
             `A${R},${R} 0 0 1 ${round(p2[0],2)},${round(p2[1],2)}Z`
        }));
      }

      // 位置點
      svg.appendChild(svgEl('circle', { class: 'ld-pin-ring', cx: l.pin.x, cy: l.pin.y, r: s.pinR }));
      const t = svgEl('text', {
        class: 'ld-pin-txt', x: l.pin.x, y: l.pin.y, 'font-size': s.pinFont
      });
      t.textContent = String(l.num);
      svg.appendChild(t);
    });

    return svg;
  }

  /** 把目前算出來的版面寫成明確的 mm 座標，作為自由排版的起點 */
  function seedFreeBoxes() {
    const seen = new Set(), seenPlan = new Set();
    const boxes = ST.S.proj.opts.planBoxes || {};
    sheets.forEach(s => {
      s.cards.forEach(c => {
        if (seen.has(c.id)) return;
        seen.add(c.id);
        ST.setBox(c.id, { x: c.x, y: c.y, w: c.w }, true);
      });
      if (s.planId && s.planBox && !seenPlan.has(s.planId) && !boxes[s.planId]) {
        seenPlan.add(s.planId);
        ST.setPlanBox(s.planId, Object.assign({}, s.planBox), true);
      }
    });
    ST.commitLayout();
  }

  /* ═══════════ 手動調整位置 ═══════════ */

  /**
   * 把整張圖面目前的排法「凍結」成明確的格位，再套用這次的異動。
   * 不這麼做的話，只指定一張照片會讓同一邊的其他照片跟著重排，很難預期。
   */
  function freeze(sheetIndex, mutate) {
    const sheet = sheets[sheetIndex];
    if (!sheet) return;
    const entries = sheet.cards.map(c => ({ id: c.id, slot: { side: c.side, i: c.idx } }));
    mutate(entries);
    ST.setSlots(entries);
    render();
  }

  const sheetOf = node => {
    const box = node.closest('.sheetBox');
    return box ? U.$$('.sheetBox').indexOf(box) : -1;
  };

  let dragInfo = null;

  function mountDragSwap() {
    const host = $('#sheets');

    host.addEventListener('dragstart', e => {
      const fr = e.target.closest('.sh-imgframe');
      if (!fr) return;
      dragInfo = { id: fr.dataset.id, sheet: sheetOf(fr) };
      if (SR.app) SR.app.setInternalDrag(true);
      fr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', fr.dataset.id);
    });

    host.addEventListener('dragend', () => {
      dragInfo = null;
      if (SR.app) SR.app.setInternalDrag(false);
      U.$$('.sh-imgframe, .sh-slot').forEach(n => n.classList.remove('dragging', 'dropTarget'));
    });

    host.addEventListener('dragover', e => {
      if (!dragInfo) return;
      const t = e.target.closest('.sh-imgframe, .sh-slot');
      U.$$('.dropTarget').forEach(n => n.classList.remove('dropTarget'));
      if (!t || t.dataset.id === dragInfo.id || sheetOf(t) !== dragInfo.sheet) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      t.classList.add('dropTarget');
    });

    host.addEventListener('drop', e => {
      if (!dragInfo) return;
      const t = e.target.closest('.sh-imgframe, .sh-slot');
      if (!t || sheetOf(t) !== dragInfo.sheet) return;
      e.preventDefault();
      const srcId = dragInfo.id;
      const dstId = t.dataset.id || null;                    // 空格位沒有 id
      const dstSlot = { side: t.dataset.side, i: +t.dataset.idx };
      dragInfo = null;

      freeze(sheetOf(t), entries => {
        const a = entries.find(x => x.id === srcId);
        if (!a) return;
        if (dstId) {                                          // 與另一張照片互換
          const b = entries.find(x => x.id === dstId);
          if (!b) return;
          const tmp = a.slot; a.slot = b.slot; b.slot = tmp;
        } else {                                              // 移到空格位
          a.slot = dstSlot;
        }
      });
      U.toast(dstId ? '已互換位置' : '已移動位置');
    });
  }

  /* ═══════════ 圖框設定 ═══════════ */
  let frameDraft = null;          // 面板編輯中的暫存，按「套用」才寫回

  function openFrameDlg() {
    const f = ST.S.proj.opts.frame || { office: '', logo: null, extras: [] };
    frameDraft = JSON.parse(JSON.stringify(f));
    frameDraft.extras = frameDraft.extras || [];
    $('#frOffice').value = frameDraft.office || '';
    $('#frDefault').checked = false;
    renderFrameDlg();
    $('#frameDlg').hidden = false;
  }

  function renderFrameDlg() {
    const prev = $('#frLogoPrev'), clearBtn = $('#frLogoClear');
    if (frameDraft.logo) { prev.src = frameDraft.logo; prev.hidden = false; clearBtn.hidden = false; }
    else { prev.removeAttribute('src'); prev.hidden = true; clearBtn.hidden = true; }

    const host = $('#frExtras');
    host.textContent = '';
    frameDraft.extras.forEach((x, i) => {
      const row = el('div', 'fdExtraRow');
      const k = document.createElement('input');
      k.type = 'text'; k.placeholder = '欄名（如 監造）'; k.value = x.k || '';
      k.addEventListener('input', () => { frameDraft.extras[i].k = k.value; });
      const v = document.createElement('input');
      v.type = 'text'; v.placeholder = '內容'; v.value = x.v || '';
      v.addEventListener('input', () => { frameDraft.extras[i].v = v.value; });
      const d = el('button', 'fdDel', '×');
      d.type = 'button';
      d.title = '刪除這個欄位';
      d.addEventListener('click', () => { frameDraft.extras.splice(i, 1); renderFrameDlg(); });
      row.appendChild(k); row.appendChild(v); row.appendChild(d);
      host.appendChild(row);
    });
  }

  async function pickLogo(file) {
    try {
      const info = await U.probeImage(file);
      if (!info.bitmap) { U.toast('無法讀取這張圖', true); return; }
      // Logo 縮到 400px 存成 dataURL —— 直接放進專案 JSON，匯出 .sitelog 也會帶著走
      const r = await U.makeRaster(info.bitmap, 400, 0.9);
      if (info.bitmap.close) info.bitmap.close();
      frameDraft.logo = await U.blobToDataURL(r.blob);
      renderFrameDlg();
    } catch (e) { console.error(e); U.toast('Logo 載入失敗：' + e.message, true); }
  }

  function applyFrame() {
    frameDraft.office = $('#frOffice').value.trim();
    frameDraft.extras = (frameDraft.extras || [])
      .filter(x => (x.k || '').trim() || (x.v || '').trim()).slice(0, 6);
    ST.setOpt('frame', JSON.parse(JSON.stringify(frameDraft)));
    if ($('#frDefault').checked) {
      const ok = ST.saveFrameDefault(frameDraft);
      U.toast(ok ? '已套用，並設為新紀錄的預設圖框'
                 : '已套用（預設儲存失敗，可能是 Logo 太大）', !ok);
    } else U.toast('已套用圖框設定');
    $('#frameDlg').hidden = true;
    render();
  }

  function mountFrameDlg() {
    $('#btnFrame').addEventListener('click', () => {
      if ($('#frameDlg').hidden) openFrameDlg();
      else $('#frameDlg').hidden = true;
    });
    $('#frClose').addEventListener('click', () => { $('#frameDlg').hidden = true; });
    $('#frSave').addEventListener('click', applyFrame);
    $('#frAddExtra').addEventListener('click', () => {
      if (frameDraft.extras.length >= 6) { U.toast('最多 6 個額外欄位', true); return; }
      frameDraft.extras.push({ k: '', v: '' });
      renderFrameDlg();
    });
    $('#frLogoPick').addEventListener('click', () => $('#fileLogo').click());
    $('#frLogoClear').addEventListener('click', () => { frameDraft.logo = null; renderFrameDlg(); });
    $('#fileLogo').addEventListener('change', async e => {
      if (e.target.files[0]) await pickLogo(e.target.files[0]);
      e.target.value = '';
    });
  }

  /* ═══════════ 列印 ═══════════ */
  function print() {
    const s = sheets[0];
    if (!s) return;
    setPageSize(s.W, s.H);
    // 讓瀏覽器先套用列印樣式再開對話框
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  }

  /* ─────────── 啟動 ─────────── */
  function mount() {
    $('#btnReport').addEventListener('click', open);
    $('#btnCloseReport').addEventListener('click', close);
    $('#btnPrint').addEventListener('click', print);

    const bind = (sel, key, get) => $(sel).addEventListener('change', e => {
      ST.setOpt(key, get(e.target));
      render();
    });

    /** 紙張或方向改變時，把自由排版的所有座標等比換算到新紙張。
        A 系列同方向縮放比例兩軸相同（√2 級距），照片高度由寬度推得、
        平面圖以 contain 放進框內，因此換算後不會變形。 */
    const dims = () => {
      const o = ST.S.proj.opts;
      let [W, H] = LO.PAPER[o.paper] || LO.PAPER.A1;
      return o.orient === 'portrait' ? [H, W] : [W, H];
    };
    const bindPaper = (sel, key, get) => $(sel).addEventListener('change', e => {
      const [oW, oH] = dims();
      ST.setOpt(key, get(e.target));
      const [nW, nH] = dims();
      const rx = nW / oW, ry = nH / oH;
      const P = ST.S.proj;
      const boxIds = Object.keys(P.opts.planBoxes || {});
      const hasFree = boxIds.length || P.photos.some(p => p.box);
      if (hasFree && (rx !== 1 || ry !== 1)) {
        P.photos.forEach(p => {
          if (p.box) p.box = { x: U.round(p.box.x * rx, 2), y: U.round(p.box.y * ry, 2),
                               w: U.round(p.box.w * rx, 2) };
        });
        boxIds.forEach(pid => {
          const b = P.opts.planBoxes[pid];
          P.opts.planBoxes[pid] = { x: U.round(b.x * rx, 2), y: U.round(b.y * ry, 2),
                                    w: U.round(b.w * rx, 2), h: U.round(b.h * ry, 2) };
        });
        ST.save();
      }
      render();
    });
    bindPaper('#optPaper',  'paper',  t => t.value);
    bindPaper('#optOrient', 'orient', t => t.value);
    bind('#optPerSheet', 'perSheet', t => +t.value);
    bind('#optFont',     'font',     t => +t.value);

    $('#optScale').addEventListener('change', e => {
      const v = e.target.value ? +e.target.value : null;
      const withCal = ST.plans().filter(p => p.cal && p.cal.px > 0).length;
      if (v && !withCal) {
        U.toast('先回編輯畫面按「比例尺」：輸入原圖比例（如 1:100）或量測兩點', true);
        e.target.value = '';
        return;
      }
      if (v && withCal < ST.plans().length) {
        U.toast('有平面圖還沒設定比例尺，那幾張會維持自動大小', true);
      }
      ST.setOpt('planScale', v);
      render();
    });

    // 切到「自訂」時，用目前自動算出來的配置當起始值，畫面才不會突然大跳
    $('#optEdges').addEventListener('change', e => {
      const v = e.target.value;
      ST.setOpt('edges', v);
      render();
      // 切到自由排版時，把目前算出來的位置寫成明確座標，之後才會停在原地
      if (v === 'free') { seedFreeBoxes(); render(); }
    });

    $('#optSnap').addEventListener('change', e => { ST.setOpt('snap', e.target.checked); });

    $('#btnResetFree').addEventListener('click', () => {
      if (SR.arrange) SR.arrange.pushHistory();   // 重排前留一步，Ctrl+Z 可以回來
      ST.clearBoxes();
      render(); seedFreeBoxes(); render();
      U.toast('已依自動排版重排（Ctrl+Z 可復原）');
    });

    mountDragSwap();
    mountFrameDlg();
    if (SR.arrange) SR.arrange.mount();
    bind('#optLeaders',  'leaders',  t => t.checked);
    bind('#optGhost',    'ghost',    t => t.checked);

    window.addEventListener('resize', () => { if (!$('#reportModal').hidden) fitScale(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('#reportModal').hidden) close();
    });
  }

  SR.report = { mount, open, close, render, print, seedFreeBoxes,
                sheets: () => sheets, isOpen: () => !$('#reportModal').hidden };
})(window.SR);
