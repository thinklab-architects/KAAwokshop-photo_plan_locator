/* ══════════════════════════════════════════════════════════
   平面圖檢視 — 多張平面圖分頁 / 平移縮放 / 位置點與拍攝方向 / 裁切 / 比例尺

   位置點座標存在「該張平面圖的原圖正規化空間」，並帶 planId。
   顯示時靠 SVG viewBox 平移到裁切區，所以裁切前後標好的點都不會跑掉。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state, CROP = SR.crop;
  const { $, svgEl, el, clamp } = U;

  const view = { tx: 0, ty: 0, scale: 1 };
  const MIN_S = 0.05, MAX_S = 12;
  const CLICK_SLOP = 4;          // 位移小於此值視為「點擊」而非拖曳

  let vp, canvas, frame, img, ov;
  let drag = null;               // { mode:'pan'|'pin'|'dir', ... }
  let cropping = false;
  let cropSession = null;
  let calPick = false;           // 兩點量測模式
  let calPts = [];

  const curPlan = () => ST.activePlan ? ST.activePlan() : null;

  /** 目前顯示幾何：裁切模式下顯示全圖，其餘顯示裁切區 */
  function geom() {
    const p = curPlan();
    if (!p) return null;
    const c = (cropping || !p.crop) ? CROP.FULL : p.crop;
    return { p, c, w: p.w * c.w, h: p.h * c.h, ox: c.x * p.w, oy: c.y * p.h };
  }

  /* ─────────── 座標轉換 ─────────── */
  function toImage(clientX, clientY) {
    const g = geom(), r = vp.getBoundingClientRect();
    const lx = (clientX - r.left - view.tx) / view.scale;
    const ly = (clientY - r.top  - view.ty) / view.scale;
    return g ? { x: g.ox + lx, y: g.oy + ly } : { x: lx, y: ly };
  }

  /* ─────────── 檢視 ─────────── */
  function applyView() {
    canvas.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.scale})`;
    const lbl = $('#zoomLabel');
    if (lbl) lbl.textContent = Math.round(view.scale * 100) + '%';
    // 裁切框的邊線與把手畫在被縮放的畫布裡，要反向補償才不會縮到看不見
    if (cropping && frame) frame.style.setProperty('--cropK', String(clamp(1 / view.scale, 0.2, 60)));
    renderPins();
  }

  function fit() {
    const g = geom();
    if (!g) return;
    const r = vp.getBoundingClientRect();
    const pad = 24;
    view.scale = clamp(Math.min((r.width - pad * 2) / g.w, (r.height - pad * 2) / g.h), MIN_S, MAX_S);
    view.tx = (r.width  - g.w * view.scale) / 2;
    view.ty = (r.height - g.h * view.scale) / 2;
    applyView();
  }

  function zoomAt(factor, clientX, clientY) {
    const r = vp.getBoundingClientRect();
    const cx = (clientX === undefined) ? r.width / 2  : clientX - r.left;
    const cy = (clientY === undefined) ? r.height / 2 : clientY - r.top;
    const ns = clamp(view.scale * factor, MIN_S, MAX_S);
    const k  = ns / view.scale;
    view.tx = cx - (cx - view.tx) * k;
    view.ty = cy - (cy - view.ty) * k;
    view.scale = ns;
    applyView();
  }

  /* ─────────── 平面圖分頁列 ─────────── */
  function renderTabs() {
    const host = $('#planTabs');
    if (!host) return;
    const list = ST.plans();
    host.textContent = '';
    host.hidden = list.length === 0;

    list.forEach(pl => {
      const tab = el('button', 'planTab' + (curPlan() && curPlan().id === pl.id ? ' on' : ''));
      tab.type = 'button';
      tab.title = pl.name;
      const pinned = ST.S.proj.photos.filter(ph => ph.pin && ph.pin.planId === pl.id).length;
      tab.appendChild(el('span', 'ptName', pl.name.length > 12 ? pl.name.slice(0, 12) + '…' : pl.name));
      tab.appendChild(el('span', 'ptCount', String(pinned)));
      const x = el('span', 'ptDel', '×');
      x.title = '移除這張平面圖';
      x.addEventListener('click', e => {
        e.stopPropagation();
        const n = ST.S.proj.photos.filter(ph => ph.pin && ph.pin.planId === pl.id).length;
        if (!confirm('移除平面圖「' + pl.name + '」？' + (n ? '\n釘在上面的 ' + n + ' 個位置點會一併清除。' : ''))) return;
        const un = ST.removePlan(pl.id);
        if (un) U.toast('已移除，' + un + ' 張照片變回未定位');
      });
      tab.appendChild(x);
      tab.addEventListener('click', () => {
        if (curPlan() && curPlan().id === pl.id) return;
        if (cropping) endCrop(false);
        if (calPick) endCalPick(false);
        ST.setActivePlan(pl.id);
        requestAnimationFrame(fit);
      });
      host.appendChild(tab);
    });
  }

  /* ─────────── 位置點 ─────────── */
  function renderPins() {
    if (!ov) return;
    const g = geom();
    ov.textContent = '';
    if (!g) return;

    ov.setAttribute('viewBox', `${g.ox} ${g.oy} ${g.w} ${g.h}`);
    ov.style.width = g.w + 'px';
    ov.style.height = g.h + 'px';

    const k = 1 / view.scale;
    const R = 11 * k, HR = 34 * k;
    const photos = ST.S.proj ? ST.S.proj.photos : [];
    const p = g.p;

    // 兩點量測中：畫端點與連線
    if (calPick && calPts.length) {
      if (calPts.length === 2) {
        ov.appendChild(svgEl('line', {
          x1: calPts[0].x, y1: calPts[0].y, x2: calPts[1].x, y2: calPts[1].y,
          stroke: '#ff2d95', 'stroke-width': 2.4 * k
        }));
      }
      calPts.forEach(pt => ov.appendChild(svgEl('circle', {
        cx: pt.x, cy: pt.y, r: 5 * k,
        fill: '#ff2d95', stroke: '#fff', 'stroke-width': 1.6 * k
      })));
    }

    photos.forEach((ph, i) => {
      if (!ph.pin || ph.pin.planId !== p.id) return;
      const x = ph.pin.x * p.w, y = ph.pin.y * p.h;
      const isSel = ph.id === ST.S.selId;
      const outside = cropping && p.crop && !CROP.project(ph.pin, p);
      const grp = svgEl('g', { class: 'pinHit', 'data-id': ph.id, opacity: outside ? 0.35 : 1 });

      if (ph.dir !== null && ph.dir !== undefined) {
        const a = (ph.dir - 90) * Math.PI / 180, spread = 0.42, L = 46 * k;
        const p1 = [x + Math.cos(a - spread) * L, y + Math.sin(a - spread) * L];
        const p2 = [x + Math.cos(a + spread) * L, y + Math.sin(a + spread) * L];
        grp.appendChild(svgEl('path', {
          d: `M${x},${y}L${p1[0]},${p1[1]}A${L},${L} 0 0 1 ${p2[0]},${p2[1]}Z`,
          fill: isSel ? 'rgba(255,179,0,.35)' : 'rgba(255,255,255,.22)',
          stroke: isSel ? '#ffb300' : '#fff',
          'stroke-width': 1.5 * k
        }));
      }

      grp.appendChild(svgEl('circle', {
        cx: x, cy: y, r: R,
        fill: isSel ? '#ffb300' : '#fff',
        stroke: isSel ? '#7a5200' : '#222',
        'stroke-width': 2 * k
      }));
      const t = svgEl('text', {
        x, y, fill: isSel ? '#3a2700' : '#222',
        'font-size': 13 * k, 'font-weight': '700',
        'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': 'sans-serif', 'pointer-events': 'none'
      });
      t.textContent = String(i + 1);
      grp.appendChild(t);
      ov.appendChild(grp);

      if (isSel && !cropping && !calPick) {
        const a = ((ph.dir === null || ph.dir === undefined) ? 0 : ph.dir - 90) * Math.PI / 180;
        const hx = x + Math.cos(a) * HR, hy = y + Math.sin(a) * HR;
        const hg = svgEl('g', { class: 'dirHandle', 'data-dir': ph.id });
        hg.appendChild(svgEl('line', {
          x1: x, y1: y, x2: hx, y2: hy,
          stroke: '#ffb300', 'stroke-width': 1.4 * k, 'stroke-dasharray': `${3 * k} ${3 * k}`
        }));
        hg.appendChild(svgEl('circle', {
          cx: hx, cy: hy, r: 5.5 * k, fill: '#1b1e24', stroke: '#ffb300', 'stroke-width': 2 * k
        }));
        ov.appendChild(hg);
      }
    });
  }

  /* ─────────── 提示 ─────────── */
  function updateTip() {
    const tip = $('#planTip');
    const p = curPlan();
    const sel = ST.selected();
    let msg = '', show = false;

    if (p && !cropping && !calPick) {
      const cut = CROP.outsideCount(
        ST.S.proj.photos.filter(ph => ph.pin && ph.pin.planId === p.id), p);
      if (cut) { msg = `有 ${cut} 個位置點在裁切範圍外，不會出現在報告上`; show = true; }
      else if (!sel) { msg = '先在左邊選一張照片'; show = true; }
      else if (!sel.pin) { msg = `點平面圖，標記第 ${ST.indexOf(sel.id) + 1} 張照片的位置`; show = true; }
      else if (sel.pin.planId !== p.id) {
        const other = ST.planById(sel.pin.planId);
        msg = `這張照片釘在「${other ? other.name : '另一張平面圖'}」上；點這裡會移過來`;
        show = true;
      }
    }
    tip.textContent = msg;
    tip.classList.toggle('show', show);
    tip.classList.toggle('warn', /裁切範圍外|另一張平面圖|移過來/.test(msg));
  }

  /* ─────────── 互動 ─────────── */
  function onPointerDown(e) {
    if (!curPlan()) return;
    if (e.button !== 0 && e.button !== 1) return;

    const dirEl = e.target.closest('.dirHandle');
    const pinEl = e.target.closest('.pinHit');
    const busy = cropping || calPick;

    if (!busy && dirEl && e.button === 0) {
      drag = { mode: 'dir', id: dirEl.getAttribute('data-dir') };
    } else if (!busy && pinEl && e.button === 0) {
      const id = pinEl.getAttribute('data-id');
      ST.select(id);
      drag = { mode: 'pin', id, moved: false };
    } else {
      drag = { mode: 'pan', moved: false, tx0: view.tx, ty0: view.ty };
    }
    drag.startX = e.clientX; drag.startY = e.clientY;
    try { vp.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (Math.abs(dx) > CLICK_SLOP || Math.abs(dy) > CLICK_SLOP) drag.moved = true;

    if (drag.mode === 'pan') {
      if (!drag.moved) return;
      vp.classList.add('panning');
      view.tx = drag.tx0 + dx;
      view.ty = drag.ty0 + dy;
      applyView();
    } else if (drag.mode === 'pin') {
      const g = geom(), pt = toImage(e.clientX, e.clientY);
      ST.setPin(drag.id, pt.x / g.p.w, pt.y / g.p.h, g.p.id);
    } else if (drag.mode === 'dir') {
      const ph = ST.photo(drag.id);
      if (!ph || !ph.pin) return;
      const g = geom(), pt = toImage(e.clientX, e.clientY);
      const vx = pt.x - ph.pin.x * g.p.w, vy = pt.y - ph.pin.y * g.p.h;
      if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) return;
      let deg = Math.atan2(vx, -vy) * 180 / Math.PI;
      if (!e.shiftKey) deg = Math.round(deg / 5) * 5;
      ST.setDir(drag.id, deg);
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag; drag = null;
    vp.classList.remove('panning');
    try { vp.releasePointerCapture(e.pointerId); } catch (_) {}

    if (d.mode !== 'pan' || d.moved || e.button !== 0) return;

    // 兩點量測
    if (calPick) {
      const g = geom(), pt = toImage(e.clientX, e.clientY);
      if (pt.x < 0 || pt.y < 0 || pt.x > g.p.w || pt.y > g.p.h) return;
      if (calPts.length >= 2) calPts = [];
      calPts.push({ x: pt.x, y: pt.y });
      const $d = $('#calDist'), $a = $('#calApply');
      if (calPts.length === 2) {
        $('#calMsg').textContent = '輸入這兩點的實際距離，或重新點選';
        $d.disabled = false; $a.disabled = false; $d.focus();
      } else {
        $('#calMsg').textContent = '再點另一端';
        $d.disabled = true; $a.disabled = true;
      }
      renderPins();
      return;
    }
    if (cropping) return;

    // 點擊 → 放置目前選取照片的位置點（在目前作用中的平面圖上）
    const sel = ST.selected();
    if (!sel) { U.toast('先在左邊選一張照片'); return; }
    const g = geom(), pt = toImage(e.clientX, e.clientY);
    if (pt.x < 0 || pt.y < 0 || pt.x > g.p.w || pt.y > g.p.h) return;
    ST.setPin(sel.id, pt.x / g.p.w, pt.y / g.p.h, g.p.id);
  }

  function onWheel(e) {
    if (!curPlan()) return;
    e.preventDefault();
    zoomAt(Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 16 : 1)), e.clientX, e.clientY);
  }

  /* ─────────── 比例尺（輸入式為主，兩點量測為輔） ─────────── */
  const PAPER_W = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };

  function openCalDlg() {
    const p = curPlan();
    if (!p) { U.toast('還沒有平面圖', true); return; }
    const dlg = $('#calDlg');
    dlg.hidden = false;

    // 目前狀態
    const st = $('#calState');
    if (p.cal) {
      st.textContent = '目前：影像全寬 ' + p.w + 'px ＝ 實際 ' +
        (p.cal.mm / p.cal.px * p.w / 1000).toFixed(2) + ' m（1px ≈ ' +
        (p.cal.mm / p.cal.px).toFixed(1) + ' mm）';
    } else st.textContent = '目前：尚未設定';

    // 紙張選單：PDF 匯入的平面圖已知原始頁面尺寸 → 自動選項
    const selP = $('#calPaper');
    selP.textContent = '';
    if (p.srcMM && p.srcMM.w > 0) {
      const o = document.createElement('option');
      o.value = 'src';
      o.textContent = 'PDF 頁面 ' + Math.round(p.srcMM.w) + '×' + Math.round(p.srcMM.h) + ' mm（自動）';
      selP.appendChild(o);
    }
    Object.keys(PAPER_W).forEach(k => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = k + '（' + PAPER_W[k][0] + '×' + PAPER_W[k][1] + '）';
      selP.appendChild(o);
    });
    const oc = document.createElement('option');
    oc.value = 'custom';
    oc.textContent = '自訂原圖寬度…';
    selP.appendChild(oc);
    $('#calCustomW').hidden = true;
    if ($('#calN').value === '') $('#calN').value = '100';
  }

  function applyCalDlg() {
    const p = curPlan();
    if (!p) return;
    const N = +$('#calN').value;
    if (!(N > 0)) { U.toast('請輸入原圖比例（例如 100 代表 1:100）', true); return; }

    // 原圖「紙面」寬度 mm
    let paperW = null;
    const v = $('#calPaper').value;
    const landscape = p.w >= p.h;
    if (v === 'src' && p.srcMM) paperW = p.srcMM.w;
    else if (PAPER_W[v]) paperW = landscape ? PAPER_W[v][0] : PAPER_W[v][1];
    else if (v === 'custom') paperW = +$('#calCustomWInput').value;
    if (!(paperW > 0)) { U.toast('請選擇或輸入原圖紙張寬度', true); return; }

    // 影像全寬 px ↔ 實際 mm：實際寬 = 紙面寬 × N
    ST.setPlanCal({ px: p.w, mm: paperW * N }, p.id);
    $('#calDlg').hidden = true;
    U.toast('比例尺已設定：原圖 1:' + N + '、紙寬 ' + Math.round(paperW) + 'mm —— 報告可用真實比例出圖');
  }

  function startCalPick() {
    $('#calDlg').hidden = true;
    if (cropping) endCrop(false);
    calPick = true;
    calPts = [];
    $('#planCalBar').hidden = false;
    $('#calMsg').textContent = '在平面圖上點出一段已知距離的兩端（例如一道牆或尺寸線）';
    $('#calDist').disabled = true;
    $('#calApply').disabled = true;
    renderPins();
  }

  function endCalPick(apply) {
    if (apply && calPts.length === 2) {
      const mm = +$('#calDist').value;
      const px = Math.hypot(calPts[1].x - calPts[0].x, calPts[1].y - calPts[0].y);
      if (!(mm > 0) || px < 2) { U.toast('請輸入有效的實際距離', true); return; }
      ST.setPlanCal({ px, mm }, curPlan() && curPlan().id);
      U.toast('比例尺已量測：圖上 1px ≈ 實際 ' + (mm / px).toFixed(1) + ' mm');
    }
    calPick = false;
    calPts = [];
    $('#planCalBar').hidden = true;
    renderPins();
    updateTip();
  }

  /* ─────────── 裁切 ─────────── */
  async function startCrop() {
    const p = curPlan();
    if (!p) { U.toast('還沒有平面圖', true); return; }
    if (calPick) endCalPick(false);
    cropping = true;
    $('#planCropBar').hidden = false;
    $('#btnCropPlan').classList.add('on');
    await refresh();
    fit();
    cropSession = CROP.begin(frame, p.crop, null);
  }

  async function endCrop(apply) {
    const p = curPlan();
    const rect = cropSession ? cropSession.rect() : null;
    if (cropSession) { cropSession.destroy(); cropSession = null; }
    cropping = false;
    if (frame) frame.style.removeProperty('--cropK');
    $('#planCropBar').hidden = true;
    $('#btnCropPlan').classList.remove('on');

    if (apply && p) {
      ST.setPlanCrop(rect, p.id);
      const mine = ST.S.proj.photos.filter(ph => ph.pin && ph.pin.planId === p.id);
      const cut = CROP.outsideCount(mine, ST.planById(p.id));
      U.toast(rect ? '已套用裁切' + (cut ? `（${cut} 個位置點被切掉）` : '') : '已還原為全圖');
    }
    await refresh();
    fit();
  }

  /* ─────────── 依狀態重繪 ─────────── */
  let lastBlobId = null;
  async function refresh() {
    const p = curPlan();
    const empty = $('#planEmpty');
    renderTabs();

    if (!p) {
      img.removeAttribute('src');
      frame.style.display = 'none';
      empty.hidden = false;
      vp.classList.add('noplan');
      lastBlobId = null;
      renderPins(); updateTip();
      return;
    }

    empty.hidden = true;
    vp.classList.remove('noplan');
    frame.style.display = 'block';

    const g = geom();
    frame.style.width  = g.w + 'px';
    frame.style.height = g.h + 'px';
    Object.assign(img.style, CROP.imgStyle({ crop: g.c === CROP.FULL ? null : g.c }));

    if (lastBlobId !== p.blobId) {
      lastBlobId = p.blobId;
      img.src = await ST.url(p.blobId);
      requestAnimationFrame(fit);
    }

    renderPins();
    updateTip();
  }

  /* ─────────── 啟動 ─────────── */
  function mount() {
    vp     = $('#planViewport');
    canvas = $('#planCanvas');
    frame  = $('#planFrame');
    img    = $('#planImg');
    ov     = $('#planOverlay');

    vp.addEventListener('pointerdown', onPointerDown);
    vp.addEventListener('pointermove', onPointerMove);
    vp.addEventListener('pointerup', onPointerUp);
    vp.addEventListener('pointercancel', onPointerUp);
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('contextmenu', e => e.preventDefault());

    $('#btnZoomIn').addEventListener('click',  () => zoomAt(1.25));
    $('#btnZoomOut').addEventListener('click', () => zoomAt(0.8));
    $('#btnZoomFit').addEventListener('click', fit);
    $('#btnCropPlan').addEventListener('click', () => cropping ? endCrop(true) : startCrop());
    $('#planCropApply').addEventListener('click', () => endCrop(true));
    $('#planCropCancel').addEventListener('click', () => endCrop(false));
    $('#planCropReset').addEventListener('click', () => cropSession && cropSession.reset());

    // 比例尺：按鈕開輸入式對話框；兩點量測從對話框進入
    $('#btnCal').addEventListener('click', () => {
      if (calPick) { endCalPick(false); return; }
      const d = $('#calDlg');
      if (d.hidden) openCalDlg(); else d.hidden = true;
    });
    $('#calDlgApply').addEventListener('click', applyCalDlg);
    $('#calDlgClose').addEventListener('click', () => { $('#calDlg').hidden = true; });
    $('#calDlgPick').addEventListener('click', startCalPick);
    $('#calDlgClear').addEventListener('click', () => {
      const p = curPlan();
      if (p) { ST.setPlanCal(null, p.id); openCalDlg(); U.toast('已清除比例尺'); }
    });
    $('#calPaper').addEventListener('change', e => {
      $('#calCustomW').hidden = e.target.value !== 'custom';
    });
    $('#calN').addEventListener('keydown', e => { if (e.key === 'Enter') applyCalDlg(); });
    $('#calApply').addEventListener('click', () => endCalPick(true));
    $('#calCancel').addEventListener('click', () => endCalPick(false));
    $('#calDist').addEventListener('keydown', e => { if (e.key === 'Enter') endCalPick(true); });

    ST.on('change', what => {
      if (what === 'anno' || what === 'caption' || what === 'meta' || what === 'opts') return;
      refresh();
    });
  }

  SR.plan = { mount, fit, refresh, renderPins,
              isCropping: () => cropping, endCrop,
              isCalibrating: () => calPick, endCal: endCalPick };
})(window.SR);
