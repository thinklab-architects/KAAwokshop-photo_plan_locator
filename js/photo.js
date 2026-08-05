/* ══════════════════════════════════════════════════════════
   照片標註 — 以 SVG 疊層儲存，可事後修改，列印時仍是向量
   座標一律正規化 (0–1)，渲染時映射到 1000 × 1000·ar 的單位空間，
   因此同一份標註在編輯區與 A1 圖面上比例完全一致。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state, CROP = SR.crop;
  const { $, svgEl, clamp } = U;

  const COLORS = ['#e53935', '#ffd400', '#43a047', '#1e88e5', '#ffffff', '#111111'];
  const UNIT   = 1000;                       // 單位空間寬度
  const FONT   = { 4: 30, 8: 44, 14: 62 };   // 線寬 → 字級

  const tool = { name: 'pen', color: COLORS[0], w: 8 };

  let stage, wrap, frame, img, ov;
  let cropping = false;
  let cropSession = null;
  let draft = null;          // 繪製中的圖形
  let selIdx = -1;           // 選取模式下選中的圖形索引
  let moving = null;
  let undoStack = [];
  let curId = null;

  /* ══════════ 渲染（編輯區與報告共用） ══════════ */

  /**
   * 把標註畫進 svg。ar = 原圖高/寬；pickable=true 時圖形可被點選。
   * crop 不為 null 時只把 viewBox 平移縮到裁切區 —— 標註座標仍在原圖空間，
   * 完全不需要重算，所以裁切可以隨時還原而不損失任何標記。
   */
  function renderAnno(svg, anno, ar, pickable, crop) {
    svg.textContent = '';
    const H = UNIT * ar;
    const c = crop || null;
    svg.setAttribute('viewBox', c
      ? `${c.x * UNIT} ${c.y * H} ${c.w * UNIT} ${c.h * H}`
      : `0 0 ${UNIT} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    (anno || []).forEach((a, i) => {
      const node = shapeNode(a, ar);
      if (!node) return;
      node.setAttribute('class', 'annoShape' + (pickable ? ' pickable' : '') +
        (pickable && a.t === 'text' ? ' filled' : ''));
      if (pickable) node.setAttribute('data-i', i);
      svg.appendChild(node);
    });
    return svg;
  }

  const X = v => v * UNIT;
  const Y = (v, ar) => v * UNIT * ar;

  function shapeNode(a, ar) {
    const c = a.c || '#e53935', w = a.w || 8;
    const common = {
      stroke: c, 'stroke-width': w, fill: 'none',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    };

    switch (a.t) {
      case 'pen': {
        if (!a.pts || a.pts.length < 2) return null;
        const d = a.pts.map((p, i) => (i ? 'L' : 'M') + U.round(X(p[0]), 2) + ',' + U.round(Y(p[1], ar), 2)).join('');
        return svgEl('path', Object.assign({ d }, common));
      }
      case 'line':
        return svgEl('line', Object.assign({
          x1: X(a.x1), y1: Y(a.y1, ar), x2: X(a.x2), y2: Y(a.y2, ar)
        }, common));

      case 'arrow': {
        const x1 = X(a.x1), y1 = Y(a.y1, ar), x2 = X(a.x2), y2 = Y(a.y2, ar);
        const ang = Math.atan2(y2 - y1, x2 - x1);
        const L = w * 4.2, S = 0.42;
        const d = `M${x1},${y1}L${x2},${y2}` +
                  `M${x2},${y2}L${x2 - Math.cos(ang - S) * L},${y2 - Math.sin(ang - S) * L}` +
                  `M${x2},${y2}L${x2 - Math.cos(ang + S) * L},${y2 - Math.sin(ang + S) * L}`;
        return svgEl('path', Object.assign({ d }, common));
      }
      case 'rect': {
        const x = Math.min(X(a.x1), X(a.x2)), y = Math.min(Y(a.y1, ar), Y(a.y2, ar));
        return svgEl('rect', Object.assign({
          x, y, width: Math.abs(X(a.x2) - X(a.x1)), height: Math.abs(Y(a.y2, ar) - Y(a.y1, ar))
        }, common));
      }
      case 'ell': {
        const cx = (X(a.x1) + X(a.x2)) / 2, cy = (Y(a.y1, ar) + Y(a.y2, ar)) / 2;
        return svgEl('ellipse', Object.assign({
          cx, cy, rx: Math.abs(X(a.x2) - X(a.x1)) / 2, ry: Math.abs(Y(a.y2, ar) - Y(a.y1, ar)) / 2
        }, common));
      }
      case 'text': {
        if (!a.s) return null;
        const size = FONT[w] || 44;
        const g = svgEl('g');
        const lines = String(a.s).split('\n');
        lines.forEach((ln, i) => {
          const yy = Y(a.y, ar) + i * size * 1.25;
          // 外框描邊讓文字在任何底色上都看得見
          const halo = svgEl('text', {
            x: X(a.x), y: yy, 'font-size': size, 'font-weight': '700',
            'font-family': '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif',
            fill: 'none', stroke: c === '#ffffff' || c === '#ffd400' ? '#000' : '#fff',
            'stroke-width': size * 0.16, 'stroke-linejoin': 'round', 'paint-order': 'stroke'
          });
          halo.textContent = ln;
          const t = svgEl('text', {
            x: X(a.x), y: yy, 'font-size': size, 'font-weight': '700',
            'font-family': '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif',
            fill: c
          });
          t.textContent = ln;
          g.appendChild(halo); g.appendChild(t);
        });
        return g;
      }
    }
    return null;
  }

  /* ══════════ 編輯區 ══════════ */

  const curPhoto = () => ST.selected();
  const arOf = p => (p && p.w) ? p.h / p.w : 0.75;
  /** 裁切模式下顯示全圖，其餘顯示裁切區 */
  const cropOf = p => (cropping || !p || !p.crop) ? null : p.crop;

  function draw() {
    const p = curPhoto();
    if (!p) return;
    const list = draft ? p.anno.concat([draft]) : p.anno;
    renderAnno(ov, list, arOf(p), tool.name === 'select' && !cropping, cropOf(p));
    if (tool.name === 'select' && selIdx >= 0) {
      const n = ov.querySelector(`[data-i="${selIdx}"]`);
      if (n) {
        n.setAttribute('stroke-dasharray', '10 6');
        n.style.filter = 'drop-shadow(0 0 3px #fff)';
      }
    }
  }

  /** 依編輯區大小決定照片框的實際尺寸（跨瀏覽器最穩的做法） */
  function sizeBox() {
    const p = curPhoto();
    if (!p || !stage) return;
    const c = cropOf(p) || CROP.FULL;
    const r = stage.getBoundingClientRect();
    const pad = 20;
    const box = U.fitContain(p.w * c.w, p.h * c.h,
      Math.max(40, r.width - pad), Math.max(40, r.height - pad));
    wrap.style.width = Math.floor(box.w) + 'px';
    wrap.style.height = Math.floor(box.h) + 'px';
    Object.assign(img.style, CROP.imgStyle({ crop: cropOf(p) }));
  }

  /** 螢幕座標 → 原圖正規化座標（裁切時要換算回原圖空間） */
  function toNorm(e) {
    const p = curPhoto();
    const c = (p && cropOf(p)) || CROP.FULL;
    const r = ov.getBoundingClientRect();
    const lx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const ly = clamp((e.clientY - r.top) / r.height, 0, 1);
    return { x: c.x + lx * c.w, y: c.y + ly * c.h };
  }

  function pushUndo() {
    const p = curPhoto(); if (!p) return;
    undoStack.push(JSON.stringify(p.anno));
    if (undoStack.length > 40) undoStack.shift();
  }

  function commit(anno) {
    const p = curPhoto(); if (!p) return;
    ST.setAnno(p.id, anno);
  }

  /* ─────────── 指標事件 ─────────── */
  function onDown(e) {
    const p = curPhoto();
    if (!p || cropping || e.button !== 0) return;
    try { ov.setPointerCapture(e.pointerId); } catch (_) {}
    const n = toNorm(e);

    if (tool.name === 'select') {
      const hit = e.target.closest('[data-i]');
      selIdx = hit ? +hit.getAttribute('data-i') : -1;
      if (selIdx >= 0) { pushUndo(); moving = { x: n.x, y: n.y }; }
      draw();
      return;
    }

    if (tool.name === 'text') {
      const s = window.prompt('輸入標註文字');
      if (s && s.trim()) {
        pushUndo();
        commit(p.anno.concat([{ t: 'text', x: n.x, y: n.y, s: s.trim(), c: tool.color, w: tool.w }]));
      }
      return;
    }

    if (tool.name === 'pen') draft = { t: 'pen', pts: [[n.x, n.y]], c: tool.color, w: tool.w };
    else draft = { t: tool.name === 'ellipse' ? 'ell' : tool.name, x1: n.x, y1: n.y, x2: n.x, y2: n.y, c: tool.color, w: tool.w };
    draw();
    e.preventDefault();
  }

  function onMove(e) {
    const p = curPhoto(); if (!p || cropping) return;

    if (moving && selIdx >= 0) {
      const n = toNorm(e), dx = n.x - moving.x, dy = n.y - moving.y;
      moving = n;
      const a = p.anno[selIdx];
      if (!a) return;
      if (a.t === 'pen') a.pts = a.pts.map(pt => [clamp(pt[0] + dx, 0, 1), clamp(pt[1] + dy, 0, 1)]);
      else if (a.t === 'text') { a.x = clamp(a.x + dx, 0, 1); a.y = clamp(a.y + dy, 0, 1); }
      else {
        a.x1 = clamp(a.x1 + dx, 0, 1); a.y1 = clamp(a.y1 + dy, 0, 1);
        a.x2 = clamp(a.x2 + dx, 0, 1); a.y2 = clamp(a.y2 + dy, 0, 1);
      }
      draw();
      return;
    }

    if (!draft) return;
    const n = toNorm(e);
    if (draft.t === 'pen') {
      const last = draft.pts[draft.pts.length - 1];
      if (Math.hypot(n.x - last[0], n.y - last[1]) > 0.003) draft.pts.push([n.x, n.y]);
    } else {
      if (e.shiftKey && (draft.t === 'rect' || draft.t === 'ell')) {
        // 按住 Shift 畫正方形 / 正圓（依照片長寬比換算）
        const ar = arOf(p);
        const dx = n.x - draft.x1, dy = (n.y - draft.y1) * ar;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        draft.x2 = clamp(draft.x1 + Math.sign(dx || 1) * m, 0, 1);
        draft.y2 = clamp(draft.y1 + Math.sign(dy || 1) * m / ar, 0, 1);
      } else { draft.x2 = n.x; draft.y2 = n.y; }
    }
    draw();
  }

  function onUp(e) {
    const p = curPhoto();
    try { ov.releasePointerCapture(e.pointerId); } catch (_) {}

    if (moving) { moving = null; if (p) commit(p.anno); return; }
    if (!draft || !p) return;

    const d = draft; draft = null;
    let keep = true;
    if (d.t === 'pen') keep = d.pts.length > 1;
    else keep = Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > 0.008;

    if (keep) { pushUndo(); commit(p.anno.concat([d])); }
    else draw();
  }

  /* ─────────── 工具列 ─────────── */
  function setTool(name) {
    tool.name = name;
    selIdx = -1;
    U.$$('.toolBtn[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === name));
    ov.classList.toggle('selectMode', name === 'select');
    draw();
  }
  function setColor(c) {
    tool.color = c;
    U.$$('.swatch').forEach(b => b.classList.toggle('on', b.dataset.color === c));
  }
  function setWidth(w) {
    tool.w = w;
    U.$$('.wBtn').forEach(b => b.classList.toggle('on', +b.dataset.w === w));
  }

  function undo() {
    const p = curPhoto();
    if (!p || !undoStack.length) { U.toast('沒有可復原的步驟'); return; }
    selIdx = -1;
    ST.setAnno(p.id, JSON.parse(undoStack.pop()));
  }

  function clearAnno() {
    const p = curPhoto();
    if (!p || !p.anno.length) return;
    pushUndo(); selIdx = -1;
    ST.setAnno(p.id, []);
  }

  function deleteSelected() {
    const p = curPhoto();
    if (!p || selIdx < 0) return;
    pushUndo();
    const a = p.anno.slice();
    a.splice(selIdx, 1);
    selIdx = -1;
    ST.setAnno(p.id, a);
  }

  /* ─────────── 依狀態重繪 ─────────── */
  async function refresh(what) {
    const p = curPhoto();
    const empty = $('#editEmpty');

    if (!p) {
      wrap.classList.remove('ready');
      img.removeAttribute('src');
      empty.hidden = false;
      $('#editTitle').textContent = '照片標註';
      ov.textContent = '';
      curId = null;
      return;
    }

    empty.hidden = true;
    wrap.classList.add('ready');
    if (curId !== p.id) {
      if (cropping) endCrop(false);
      curId = p.id;
      undoStack = [];
      selIdx = -1;
      img.src = await ST.url(p.blobId);
      img.alt = p.name || '';
    }
    const cropped = !!p.crop;
    $('#editTitle').textContent =
      (`照片 ${ST.indexOf(p.id) + 1}　${p.name || ''}`).trim() + (cropped ? '　· 已裁切' : '');
    $('#btnCropPhoto').classList.toggle('on', cropping);
    sizeBox();
    draw();
  }

  /* ─────────── 裁切 ─────────── */
  async function startCrop() {
    const p = curPhoto();
    if (!p) { U.toast('先選一張照片', true); return; }
    cropping = true;
    $('#photoCropBar').hidden = false;
    await refresh('crop');
    cropSession = CROP.begin(frame, p.crop, null);
  }

  function endCrop(apply) {
    const p = curPhoto();
    const rect = cropSession ? cropSession.rect() : null;
    if (cropSession) { cropSession.destroy(); cropSession = null; }
    cropping = false;
    $('#photoCropBar').hidden = true;
    if (apply && p) {
      ST.setPhotoCrop(p.id, rect);
      U.toast(rect ? '已套用裁切' : '已還原為全圖');
    }
    refresh('crop');
  }

  /* ─────────── 啟動 ─────────── */
  function mount() {
    stage = $('#editStage');
    wrap  = $('#photoWrap');
    frame = $('#photoFrame');
    img   = $('#photoImg');
    ov    = $('#photoOverlay');

    $('#btnCropPhoto').addEventListener('click', () => cropping ? endCrop(true) : startCrop());
    $('#photoCropApply').addEventListener('click', () => endCrop(true));
    $('#photoCropCancel').addEventListener('click', () => endCrop(false));
    $('#photoCropReset').addEventListener('click', () => cropSession && cropSession.reset());

    // 顏色色票
    const sw = $('#colorSwatches');
    COLORS.forEach(c => {
      const b = U.el('button', 'swatch');
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.addEventListener('click', () => setColor(c));
      sw.appendChild(b);
    });

    U.$$('.toolBtn[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
    U.$$('.wBtn').forEach(b => b.addEventListener('click', () => setWidth(+b.dataset.w)));
    $('#btnUndo').addEventListener('click', undo);
    $('#btnClearAnno').addEventListener('click', clearAnno);

    ov.addEventListener('pointerdown', onDown);
    ov.addEventListener('pointermove', onMove);
    ov.addEventListener('pointerup', onUp);
    ov.addEventListener('pointercancel', onUp);

    new ResizeObserver(() => sizeBox()).observe(stage);

    setTool('pen'); setColor(COLORS[0]); setWidth(8);

    ST.on('change', what => {
      if (what === 'meta' || what === 'opts' || what === 'pins') return;
      refresh(what);
    });
  }

  SR.photo = { mount, refresh, renderAnno, setTool, undo, deleteSelected, tool, COLORS,
               isCropping: () => cropping, endCrop };
})(window.SR);
