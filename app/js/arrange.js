/* ══════════════════════════════════════════════════════════
   自由排版 — 在報告預覽上直接拖曳／縮放照片與平面圖

   位置一律存 mm 絕對座標，和 layout.js 的輸出同一個座標系，
   所以拖出來的結果列印時完全一致，不需要任何換算。

   吸附點取自：內容區的四邊與中線、平面圖的四邊與中線、其他照片的四邊與中線。
   門檻用「螢幕像素」換算成 mm，因此不論預覽縮到多小，手感都一樣。

   照片可以直接拖到另一張圖面上（限同一張平面圖的分頁 —— 照片跟著它釘的圖走）；
   拖到預覽視窗上下邊緣會自動捲動。

   復原 / 重做：每次異動（拖曳、縮放、互換、方向鍵、重排）前先拍快照，
   Ctrl+Z / Ctrl+Y 在快照間來回。快照內容 = 所有照片的 box+sheet 與各平面圖框。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state;
  const { $, svgEl, round, clamp } = U;

  const MM_PX = 96 / 25.4;
  const SNAP_PX = 7;            // 吸附門檻（螢幕像素）
  const MIN_W  = 12;            // 元素最小寬度 mm

  // 平面圖的拖曳識別：'plan:<planId>'（每張平面圖各自一個框）
  const isPlanId = id => typeof id === 'string' && id.indexOf('plan:') === 0;
  const planIdOf = id => id.slice(5);

  let drag = null;
  let selId = null;
  let lastPt = null;
  let raf = 0, scrollTimer = 0;

  const isFree = () => ST.S.proj && ST.S.proj.opts.edges === 'free';
  const snapOn = () => ST.S.proj && ST.S.proj.opts.snap !== false;

  /* ─────────── 復原 / 重做 ─────────── */
  const HIST_MAX = 50;
  let hist = [], redoStack = [];
  let lastArrowPush = 0;

  /** 目前自由排版的完整狀態（深拷貝） */
  function snapshot() {
    const P = ST.S.proj;
    if (!P) return null;
    const photos = {};
    P.photos.forEach(p => {
      photos[p.id] = {
        box: p.box ? { x: p.box.x, y: p.box.y, w: p.box.w } : null,
        sheet: (p.sheet === null || p.sheet === undefined) ? null : p.sheet
      };
    });
    return { photos, planBoxes: JSON.parse(JSON.stringify(P.opts.planBoxes || {})) };
  }

  function applySnap(s) {
    const P = ST.S.proj;
    if (!P || !s) return;
    P.photos.forEach(p => {
      const e = s.photos[p.id];
      if (!e) return;                       // 快照之後才加入的照片維持現狀
      p.box = e.box ? { x: e.box.x, y: e.box.y, w: e.box.w } : null;
      p.sheet = (e.sheet === null || e.sheet === undefined) ? null : e.sheet;
    });
    P.opts.planBoxes = JSON.parse(JSON.stringify(s.planBoxes || {}));
    ST.commitLayout();
    SR.report.render();
    if (selId) select(selId);
  }

  /** 異動前呼叫：把「現在」推進歷史，並清空重做 */
  function pushHistory(snap) {
    const s = snap || snapshot();
    if (!s) return;
    hist.push(s);
    if (hist.length > HIST_MAX) hist.shift();
    redoStack = [];
  }

  function undo() {
    if (!hist.length) { U.toast('沒有可復原的排版動作'); return; }
    const cur = snapshot();
    const prev = hist.pop();
    if (cur) redoStack.push(cur);
    applySnap(prev);
  }

  function redo() {
    if (!redoStack.length) { U.toast('沒有可重做的排版動作'); return; }
    const cur = snapshot();
    const next = redoStack.pop();
    if (cur) hist.push(cur);
    applySnap(next);
  }

  /* ─────────── 座標 ─────────── */
  /** 預覽縮放倍率：sheet 的 transform scale */
  function scaleOf(sheetEl) {
    const m = (sheetEl.style.transform || '').match(/scale\(([\d.]+)\)/);
    return m ? +m[1] : 1;
  }
  const sheetElOf = node => node.closest('.sheet');
  const sheetIndexOf = node => {
    const box = node.closest('.sheetBox');
    return box ? U.$$('.sheetBox').indexOf(box) : -1;
  };
  const rectOf = si => {
    const b = U.$$('.sheetBox')[si];
    return b ? b.getBoundingClientRect() : null;
  };

  /** 游標落在哪一張圖面上；不在任何一張上時取最近的那張 */
  function sheetAt(cx, cy) {
    const boxes = U.$$('.sheetBox');
    let near = null;
    for (let i = 0; i < boxes.length; i++) {
      const r = boxes[i].getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return { i: i, rect: r };
      const d = Math.max(r.top - cy, cy - r.bottom, 0) + Math.max(r.left - cx, cx - r.right, 0);
      if (!near || d < near.d) near = { i: i, rect: r, d: d };
    }
    return near;
  }

  function markTarget(si) {
    U.$$('.sheet').forEach((n, i) => n.classList.toggle('dropSheet', i === si));
  }

  /** 游標下的另一張照片（互換目標）；用 mm 座標找，不受 DOM 疊序影響 */
  function swapTargetAt(sheet, si, cx, cy) {
    const rect = rectOf(si);
    if (!rect || !sheet) return null;
    const k = drag ? drag.k : 1;
    const mx = (cx - rect.left) / k, my = (cy - rect.top) / k;
    return sheet.cards.find(c =>
      c.id !== drag.id &&
      mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h) || null;
  }

  function markSwap(id) {
    U.$$('.sh-imgframe').forEach(n =>
      n.classList.toggle('dropTarget', !!id && n.dataset.arrId === id));
  }

  /** 縮放時被「等大小」吸附選中的那張照片（洋紅虛線框） */
  function markSize(id) {
    U.$$('.sh-imgframe').forEach(n =>
      n.classList.toggle('sizeMatch', !!id && n.dataset.arrId === id));
  }

  /**
   * 縮放對齊：在門檻內挑「差距最小」的一個套用 ——
   *   右緣 → 垂直對齊線、下緣 → 水平對齊線、寬 / 高 → 跟另一張照片一樣大。
   * 回傳 { w, gx, gy, matchId }；沒有可吸附的就回 null。
   */
  function findResizeSnap(box, sheet, excludeId, thr, ar) {
    const cands = [];
    const lines = snapLines(sheet, excludeId);

    lines.xs.forEach(v => {
      const d = v - (box.x + box.w);
      if (Math.abs(d) <= thr) cands.push({ d: Math.abs(d), w: box.w + d, gx: v, gy: null, matchId: null });
    });
    lines.ys.forEach(v => {
      const w2 = (v - box.y) / ar;
      const d = w2 - box.w;
      if (w2 >= MIN_W && Math.abs(d) <= thr) cands.push({ d: Math.abs(d), w: w2, gx: null, gy: v, matchId: null });
    });
    if (!isPlanId(excludeId)) sheet.cards.forEach(c => {
      if (c.id === excludeId) return;
      const dw = c.w - box.w;
      if (Math.abs(dw) <= thr) cands.push({ d: Math.abs(dw), w: c.w, gx: null, gy: null, matchId: c.id });
      const wh = c.h / ar, dh = wh - box.w;
      if (wh >= MIN_W && Math.abs(dh) <= thr) cands.push({ d: Math.abs(dh), w: wh, gx: null, gy: null, matchId: c.id });
    });

    if (!cands.length) return null;
    // 同分時偏好「等大小」：反白參照照片比一條輔助線更能說明發生了什麼
    cands.sort((a, b) => (a.d - (a.matchId ? 0.05 : 0)) - (b.d - (b.matchId ? 0.05 : 0)));
    return cands[0];
  }

  /* ─────────── 目前的框 ─────────── */
  function boxOf(sheet, id) {
    if (isPlanId(id)) {
      if (!sheet.planBox || 'plan:' + sheet.planId !== id) return null;
      return Object.assign({}, sheet.planBox);
    }
    const c = sheet.cards.find(x => x.id === id);
    return c ? { x: c.x, y: c.y, w: c.w, h: c.h } : null;
  }

  /** 把拖曳結果寫回狀態；quiet=true 時不存檔（拖曳過程中用） */
  function writeBox(id, box, quiet) {
    if (isPlanId(id)) {
      ST.setPlanBox(planIdOf(id), { x: round(box.x, 2), y: round(box.y, 2),
                                    w: round(box.w, 2), h: round(box.h, 2) }, quiet);
    } else {
      // 照片只存左上角與寬度，高度永遠由照片比例決定，避免變形
      ST.setBox(id, { x: round(box.x, 2), y: round(box.y, 2), w: round(box.w, 2) }, quiet);
    }
  }

  /* ─────────── 吸附 ─────────── */
  function snapLines(sheet, excludeId) {
    const xs = [], ys = [];
    const c = sheet.content;
    xs.push(c.x, c.x + c.w, c.x + c.w / 2);
    ys.push(c.y, c.y + c.h, c.y + c.h / 2);

    if (sheet.planImg && 'plan:' + sheet.planId !== excludeId) {
      const p = sheet.planImg;
      xs.push(p.x, p.x + p.w, p.x + p.w / 2);
      ys.push(p.y, p.y + p.h, p.y + p.h / 2);
    }
    sheet.cards.forEach(cd => {
      if (cd.id === excludeId) return;
      xs.push(cd.x, cd.x + cd.w, cd.x + cd.w / 2);
      ys.push(cd.y, cd.y + cd.h, cd.y + cd.h / 2);
    });
    return { xs: xs, ys: ys };
  }

  /** 回傳 { dx, dy, gx, gy }：需要位移多少、以及對齊到哪兩條線（畫輔助線用） */
  function findSnap(box, lines, thr) {
    const best = (own, cand) => {
      let hit = null;
      own.forEach(o => cand.forEach(v => {
        const d = v - o;
        if (Math.abs(d) <= thr && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d: d, v: v };
      }));
      return hit;
    };
    const hx = best([box.x, box.x + box.w / 2, box.x + box.w], lines.xs);
    const hy = best([box.y, box.y + box.h / 2, box.y + box.h], lines.ys);
    return { dx: hx ? hx.d : 0, dy: hy ? hy.d : 0,
             gx: hx ? hx.v : null, gy: hy ? hy.v : null };
  }

  /* ─────────── 輔助線 ─────────── */
  // 每次重畫都會把圖面 DOM 換掉，所以輔助線狀態存在這裡，
  // 由 refresh()（report.render() 結尾會呼叫）重新畫上去
  let guideAt = null;

  function guides(sheetEl, sheet, gx, gy) {
    let g = sheetEl.querySelector('.sh-guides');
    if (!g) {
      g = svgEl('svg', { class: 'sh-guides', viewBox: '0 0 ' + sheet.W + ' ' + sheet.H,
                         preserveAspectRatio: 'none' });
      g.style.width = sheet.W + 'mm';
      g.style.height = sheet.H + 'mm';
      sheetEl.appendChild(g);
    }
    g.textContent = '';
    if (gx !== null) g.appendChild(svgEl('line', { class: 'gd', x1: gx, y1: 0, x2: gx, y2: sheet.H }));
    if (gy !== null) g.appendChild(svgEl('line', { class: 'gd', x1: 0, y1: gy, x2: sheet.W, y2: gy }));
  }
  function clearGuides() { guideAt = null; U.$$('.sh-guides').forEach(n => n.remove()); }

  function drawGuides() {
    if (!guideAt) return;
    const node = U.$$('.sheet')[guideAt.si];
    const sheet = SR.report.sheets()[guideAt.si];
    if (node && sheet) guides(node, sheet, guideAt.gx, guideAt.gy);
  }

  /* ─────────── 選取 ─────────── */
  function select(id) {
    selId = id;
    U.$$('.sh-imgframe, .sh-planbox').forEach(n => {
      n.classList.toggle('selected', n.dataset.arrId === id);
    });
  }

  /* ─────────── 拖曳 ─────────── */
  function onDown(e) {
    if (!isFree() || e.button !== 0) return;
    const handle = e.target.closest('.sh-handle');
    const node = e.target.closest('[data-arr-id]');
    if (!node) { select(null); return; }

    const sheetEl = sheetElOf(node);
    const si = sheetIndexOf(node);
    const sheet = SR.report.sheets()[si];
    const rect = rectOf(si);
    if (!sheet || !rect) return;

    const id = node.dataset.arrId;
    const start = boxOf(sheet, id);
    if (!start) return;

    select(id);
    const k = scaleOf(sheetEl) * MM_PX;     // 1mm 等於幾個螢幕 px
    drag = {
      id: id, si: si, sheet: sheet, k: k, start: start,
      mode: handle ? 'resize' : 'move',
      targetSi: si,
      groupPlanId: sheet.planId,            // 跨頁移動限同一張平面圖的分頁
      snap0: snapshot(),                    // 異動前快照，放開時才進歷史
      sx: e.clientX, sy: e.clientY,
      // 游標壓在方框內的哪個位置（px）；移到另一張圖面時用它換算新座標
      grabX: e.clientX - (rect.left + start.x * k),
      grabY: e.clientY - (rect.top + start.y * k),
      // 平面圖用長寬比鎖定縮放，照片則只有寬度可調（高度由比例決定）
      ar: start.h / start.w
    };
    lastPt = { x: e.clientX, y: e.clientY, alt: false };
    startAutoScroll();
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    e.preventDefault();
    e.stopPropagation();
  }

  /* 拖到預覽視窗上下邊緣時自動捲動，否則另一張圖面在畫面外就搬不過去 */
  function startAutoScroll() {
    const sc = $('#reportScroll');
    clearInterval(scrollTimer);
    scrollTimer = setInterval(() => {
      if (!drag || !lastPt || drag.mode !== 'move') return;
      const r = sc.getBoundingClientRect(), EDGE = 80, SPEED = 16;
      let dy = 0;
      if (lastPt.y < r.top + EDGE) dy = -SPEED;
      else if (lastPt.y > r.bottom - EDGE) dy = SPEED;
      if (!dy) return;
      const before = sc.scrollTop;
      sc.scrollTop += dy;
      if (sc.scrollTop !== before) apply();   // 捲動後方框要跟著游標走
    }, 16);
  }
  function stopAutoScroll() { clearInterval(scrollTimer); scrollTimer = 0; }

  function apply() {
    if (!drag || !lastPt) return;
    const s = drag.start;
    let box, sheet, si;

    if (drag.mode === 'move' && !isPlanId(drag.id)) {
      // 以「游標所在的圖面」為基準換算，所以拖到另一張圖面上就會跟著過去
      const hit = sheetAt(lastPt.x, lastPt.y);
      si = hit ? hit.i : drag.si;
      sheet = SR.report.sheets()[si] || drag.sheet;
      const rect = (hit && hit.rect) || rectOf(drag.si);
      if (!rect) return;
      box = {
        x: (lastPt.x - rect.left - drag.grabX) / drag.k,
        y: (lastPt.y - rect.top  - drag.grabY) / drag.k,
        w: s.w, h: s.h
      };
    } else if (drag.mode === 'move') {
      // 平面圖只能在自己的圖面上移動（它的框是「每張平面圖」一個，跟頁無關）
      si = drag.si;
      sheet = drag.sheet;
      const rect = rectOf(drag.si);
      if (!rect) return;
      box = {
        x: (lastPt.x - rect.left - drag.grabX) / drag.k,
        y: (lastPt.y - rect.top  - drag.grabY) / drag.k,
        w: s.w, h: s.h
      };
    } else {
      si = drag.si;
      sheet = drag.sheet;
      const w = Math.max(MIN_W, s.w + (lastPt.x - drag.sx) / drag.k);
      box = { x: s.x, y: s.y, w: w, h: w * drag.ar };
    }

    // Alt 暫時關閉吸附
    let gx = null, gy = null, sizeId = null;
    if (snapOn() && !lastPt.alt) {
      const thr = SNAP_PX / drag.k;
      if (drag.mode === 'move') {
        const sn = findSnap(box, snapLines(sheet, drag.id), thr);
        box.x += sn.dx; box.y += sn.dy;
        gx = sn.gx; gy = sn.gy;
      } else {
        const rs = findResizeSnap(box, sheet, drag.id, thr, drag.ar);
        if (rs) {
          box.w = Math.max(MIN_W, rs.w);
          box.h = box.w * drag.ar;
          gx = rs.gx; gy = rs.gy; sizeId = rs.matchId;
        }
      }
    }

    // 不要拖出圖框外
    box.x = clamp(box.x, sheet.M, sheet.W - sheet.M - box.w);
    box.y = clamp(box.y, sheet.M, sheet.H - sheet.M - box.h);

    drag.box = box;
    drag.targetSi = si;
    drag.sheet = sheet;
    // 跨到別張平面圖的頁 → 位置照畫，但放開時不换頁（照片跟著它釘的圖）
    drag.crossPlan = sheet.planId !== drag.groupPlanId;

    // 游標壓在另一張照片上 → 這是「互換」而不是「移動」（照片與說明一起換）。
    // 拿的是照片各自原本的位置，所以互換時不套吸附位移。
    const tgt = (drag.mode === 'move' && !isPlanId(drag.id) && !lastPt.alt && !drag.crossPlan)
      ? swapTargetAt(sheet, si, lastPt.x, lastPt.y) : null;
    drag.swapWith = tgt ? tgt.id : null;

    writeBox(drag.id, box, true);            // 過程中只改記憶體，不存檔
    guideAt = (!tgt && (gx !== null || gy !== null)) ? { si: si, gx: gx, gy: gy } : null;
    drawGuides();
    markTarget(si !== drag.si ? si : -1);     // 換頁時把目標圖面標起來
    markSwap(drag.swapWith);                  // 互換目標即時反白，不等重畫
    markSize(sizeId);                         // 等大小吸附的參照照片
    drag.sizeId = sizeId;

    if (!raf) raf = requestAnimationFrame(() => {
      raf = 0;
      if (!drag) return;
      SR.report.render();
      markTarget(drag.targetSi !== drag.si ? drag.targetSi : -1);
      markSwap(drag.swapWith);
      markSize(drag.sizeId);
    });
  }

  function onMove(e) {
    if (!drag) return;
    lastPt = { x: e.clientX, y: e.clientY, alt: e.altKey };
    apply();
  }

  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    stopAutoScroll();
    if (!drag) return;
    const d = drag; drag = null; lastPt = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    clearGuides();
    markTarget(-1);
    markSwap(null);
    markSize(null);

    if (d.box) {
      pushHistory(d.snap0);                   // 這次拖曳成為一步復原

      /** 圖面重新編頁後，把每張照片目前所屬的「組內」頁碼固定下來，並套用本次異動 */
      const restamp = mutate => {
        const entries = [];
        SR.report.sheets().forEach(s => s.cards.forEach(c => entries.push({ id: c.id, sheet: s.localIndex })));
        mutate(entries);
        ST.setSheets(entries);
      };

      if (d.swapWith) {
        // 互換：兩張照片交換「原本的」位置與大小；跨頁時所屬頁碼也跟著交換
        const sheets0 = SR.report.sheets();
        const findCard = id => {
          for (let i = 0; i < sheets0.length; i++) {
            const c = sheets0[i].cards.find(x => x.id === id);
            if (c) return { c: c, si: i };
          }
          return null;
        };
        const other = findCard(d.swapWith);
        if (other) {
          ST.setBox(d.id, { x: round(other.c.x, 2), y: round(other.c.y, 2), w: round(other.c.w, 2) }, true);
          ST.setBox(d.swapWith, { x: round(d.start.x, 2), y: round(d.start.y, 2), w: round(d.start.w, 2) }, true);
          restamp(entries => {
            const a = entries.find(x => x.id === d.id);
            const b = entries.find(x => x.id === d.swapWith);
            if (a) a.sheet = sheets0[other.si].localIndex;
            if (b) b.sheet = sheets0[d.si].localIndex;
          });
          U.toast('已互換位置');
        }
      } else {
        if (d.crossPlan && d.mode === 'move' && !isPlanId(d.id)) {
          // 拖到別張平面圖的頁上 → 退回原本的頁（照片跟著它釘的平面圖分組）
          U.toast('照片跟著它釘的平面圖；要換樓層請回編輯畫面重新標位置', true);
        }
        writeBox(d.id, d.box, true);
        // 跨頁了 → 把整份重新標一次所屬圖面，索引才不會因為空頁被濾掉而漂掉
        if (d.mode === 'move' && d.targetSi !== d.si && !isPlanId(d.id) && !d.crossPlan) {
          const sheets0 = SR.report.sheets();
          const tgtSheet = sheets0[d.targetSi];
          restamp(entries => {
            const me = entries.find(x => x.id === d.id);
            const li = tgtSheet ? tgtSheet.localIndex : 0;
            if (me) me.sheet = li; else entries.push({ id: d.id, sheet: li });
          });
          U.toast('已移到第 ' + (d.targetSi + 1) + ' 張圖面');
        }
      }
      ST.commitLayout();
    }
    SR.report.render();
    select(d.id);
  }

  /* ─────────── 鍵盤：微調 + 復原/重做 ─────────── */
  function onKey(e) {
    if (!isFree() || !SR.report.isOpen()) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) return;

    // Ctrl+Z / Ctrl+Y（Ctrl+Shift+Z 也算重做）
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === 'z' && e.shiftKey) { redo(); e.preventDefault(); return; }
      if (key === 'z') { undo(); e.preventDefault(); return; }
      if (key === 'y') { redo(); e.preventDefault(); return; }
      return;
    }

    if (!selId || e.key.indexOf('Arrow') !== 0) return;

    const sheets = SR.report.sheets();
    const sheet = sheets.find(s =>
      isPlanId(selId) ? ('plan:' + s.planId === selId && s.planBox)
                      : s.cards.some(c => c.id === selId));
    if (!sheet) return;
    const box = boxOf(sheet, selId);
    if (!box) return;

    // 連續按方向鍵算一步：距上次推快照超過 1 秒才再推
    const now = Date.now();
    if (now - lastArrowPush > 1000) { pushHistory(); lastArrowPush = now; }
    else lastArrowPush = now;

    const step = e.shiftKey ? 5 : 1;          // Shift 一次 5mm
    if (e.key === 'ArrowLeft')  box.x -= step;
    if (e.key === 'ArrowRight') box.x += step;
    if (e.key === 'ArrowUp')    box.y -= step;
    if (e.key === 'ArrowDown')  box.y += step;
    box.x = clamp(box.x, sheet.M, sheet.W - sheet.M - box.w);
    box.y = clamp(box.y, sheet.M, sheet.H - sheet.M - box.h);

    writeBox(selId, box, true);
    ST.commitLayout();
    SR.report.render();
    select(selId);
    e.preventDefault();
  }

  /* ─────────── 啟動 ─────────── */
  function mount() {
    $('#sheets').addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    // 換一份紀錄 → 歷史不共用
    ST.on('change', what => { if (what === 'all') { hist = []; redoStack = []; lastArrowPush = 0; } });
  }

  /** report.js 每次重畫後呼叫，維持選取外框與拖曳中的輔助線 */
  function refresh() { if (selId) select(selId); drawGuides(); }

  SR.arrange = { mount, refresh, isFree, select, selected: () => selId,
                 pushHistory, undo, redo };
})(window.SR);
