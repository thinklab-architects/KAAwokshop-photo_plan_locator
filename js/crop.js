/* ══════════════════════════════════════════════════════════
   裁切框 — 平面圖與照片共用

   裁切是非破壞性的：只記錄一個正規化矩形 {x,y,w,h}，原始影像完全不動，
   隨時可以按「全圖」還原。標註與位置點的座標也一律留在原圖空間，
   顯示時靠 SVG viewBox 換算，因此裁切前後畫的標記都不會跑掉。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util;
  const { el, clamp } = U;

  const MIN = 0.04;                      // 最小裁切比例
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  /**
   * @param host  裁切框要覆蓋的容器（需 position:relative，且尺寸剛好等於影像顯示框）
   * @param rect  初始矩形，null 表示全圖
   * @param onChange 每次調整都會呼叫
   */
  function begin(host, rect, onChange) {
    const box = { x: 0, y: 0, w: 1, h: 1 };
    if (rect) Object.assign(box, rect);

    const overlay = el('div', 'cropOverlay');
    const frame   = el('div', 'cropRect');
    HANDLES.forEach(h => {
      const n = el('div', 'cropHandle h-' + h);
      n.dataset.h = h;
      frame.appendChild(n);
    });
    frame.appendChild(el('div', 'cropGrid'));
    overlay.appendChild(frame);
    host.appendChild(overlay);

    function paint() {
      frame.style.left   = (box.x * 100) + '%';
      frame.style.top    = (box.y * 100) + '%';
      frame.style.width  = (box.w * 100) + '%';
      frame.style.height = (box.h * 100) + '%';
      if (onChange) onChange(current());
    }

    const norm = e => {
      const r = overlay.getBoundingClientRect();
      return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) };
    };

    let drag = null;

    overlay.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const p = norm(e);
      const h = e.target.dataset && e.target.dataset.h;
      // 框還是滿版（剛進裁切、還沒框選）時，「按在框內」不可能是想移動 ——
      // 滿版的框哪裡都移不了。此時直接當成拉新框，第一次拖曳才有反應。
      const isFull = box.w >= 0.999 && box.h >= 0.999;

      if (h) drag = { mode: 'resize', h, box: Object.assign({}, box) };
      else if (e.target === frame && !isFull) drag = { mode: 'move', p, box: Object.assign({}, box) };
      else { // 在框外按下（或滿版時按在任何地方）→ 重新拉一個新框
        drag = { mode: 'new', ax: p.x, ay: p.y };
        box.x = p.x; box.y = p.y; box.w = 0; box.h = 0;
        paint();
      }
      try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
      e.stopPropagation();
    });

    overlay.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = norm(e);

      if (drag.mode === 'new') {
        box.x = Math.min(drag.ax, p.x); box.w = Math.abs(p.x - drag.ax);
        box.y = Math.min(drag.ay, p.y); box.h = Math.abs(p.y - drag.ay);
      } else if (drag.mode === 'move') {
        const b = drag.box;
        box.x = clamp(b.x + (p.x - drag.p.x), 0, 1 - b.w);
        box.y = clamp(b.y + (p.y - drag.p.y), 0, 1 - b.h);
      } else {
        const b = drag.box;
        let l = b.x, t = b.y, r = b.x + b.w, bo = b.y + b.h;
        if (drag.h.includes('w')) l = Math.min(p.x, r - MIN);
        if (drag.h.includes('e')) r = Math.max(p.x, l + MIN);
        if (drag.h.includes('n')) t = Math.min(p.y, bo - MIN);
        if (drag.h.includes('s')) bo = Math.max(p.y, t + MIN);
        box.x = clamp(l, 0, 1); box.y = clamp(t, 0, 1);
        box.w = clamp(r, 0, 1) - box.x; box.h = clamp(bo, 0, 1) - box.y;
      }
      paint();
    });

    const stop = e => {
      if (!drag) return;
      drag = null;
      try { overlay.releasePointerCapture(e.pointerId); } catch (_) {}
      // 隨手點一下（框太小）視為取消動作，還原成全圖
      if (box.w < MIN || box.h < MIN) { box.x = 0; box.y = 0; box.w = 1; box.h = 1; }
      paint();
    };
    overlay.addEventListener('pointerup', stop);
    overlay.addEventListener('pointercancel', stop);

    /** 回傳目前矩形；等於全圖時回傳 null，讓上層知道「沒有裁切」 */
    function current() {
      const full = box.x <= 0.001 && box.y <= 0.001 && box.w >= 0.999 && box.h >= 0.999;
      return full ? null : {
        x: U.round(box.x, 4), y: U.round(box.y, 4),
        w: U.round(box.w, 4), h: U.round(box.h, 4)
      };
    }

    paint();

    return {
      rect: current,
      reset() { box.x = 0; box.y = 0; box.w = 1; box.h = 1; paint(); },
      destroy() { overlay.remove(); }
    };
  }

  /* ─────────── 共用換算 ─────────── */

  const full = { x: 0, y: 0, w: 1, h: 1 };
  const of = o => (o && o.crop) ? o.crop : full;

  /** 套用裁切後的顯示尺寸（像素） */
  function size(o) {
    const c = of(o);
    return { w: (o.w || 1) * c.w, h: (o.h || 1) * c.h };
  }

  /**
   * 讓 <img> 只露出裁切區所需的樣式：把整張圖放大 1/crop.w 倍再往左上推，
   * 外層 overflow:hidden 切掉多餘部分。
   * 一律用百分比，所以 px 容器（編輯區）和 mm 容器（報告圖面）可以共用同一份程式。
   * 容器必須是 position:relative 且尺寸已等於裁切後的長寬比。
   */
  function imgStyle(o) {
    const c = of(o);
    return {
      position: 'absolute',
      left:   U.round(-c.x / c.w * 100, 4) + '%',
      top:    U.round(-c.y / c.h * 100, 4) + '%',
      width:  U.round(100 / c.w, 4) + '%',
      height: U.round(100 / c.h, 4) + '%'
    };
  }

  /** 標註 SVG 在裁切後應該使用的 viewBox（座標仍是原圖空間，因此標註不需重算） */
  function viewBox(o, unit) {
    const c = of(o);
    const ar = (o.h && o.w) ? o.h / o.w : 0.75;
    const U0 = unit || 1000;
    return `${c.x * U0} ${c.y * U0 * ar} ${c.w * U0} ${c.h * U0 * ar}`;
  }

  /** 原圖正規化座標 → 裁切後正規化座標；落在裁切範圍外時回傳 null */
  function project(pt, o) {
    const c = of(o);
    const x = (pt.x - c.x) / c.w, y = (pt.y - c.y) / c.h;
    return (x < -0.002 || x > 1.002 || y < -0.002 || y > 1.002) ? null : { x, y };
  }

  /** 有多少位置點會被裁掉 */
  function outsideCount(photos, plan) {
    if (!plan || !plan.crop) return 0;
    return photos.filter(p => p.pin && !project(p.pin, plan)).length;
  }

  SR.crop = { begin, of, size, imgStyle, viewBox, project, outsideCount, FULL: full };
})(window.SR);
