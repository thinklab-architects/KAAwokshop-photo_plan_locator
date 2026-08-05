/* ══════════════════════════════════════════════════════════
   共用工具
   ══════════════════════════════════════════════════════════ */
window.SR = window.SR || {};

(function (SR) {
  'use strict';

  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const NS = 'http://www.w3.org/2000/svg';
  /** 建立 SVG 元素並套用屬性 */
  function svgEl(tag, attrs) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    return n;
  }

  /** 建立 HTML 元素 */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  let _seq = 0;
  const uid = () => 'i' + Date.now().toString(36) + (_seq++).toString(36) + Math.floor(Math.random() * 1e6).toString(36);

  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);
  const round = (v, d) => { const p = Math.pow(10, d || 0); return Math.round(v * p) / p; };

  /** 今天的 yyyy-mm-dd（本地時區） */
  function todayISO() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** yyyy-mm-dd → yyyy.mm.dd（報告顯示用） */
  const fmtDate = s => (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s.replace(/-/g, '.') : (s || '');

  /* ─────────── 提示訊息 ─────────── */
  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 4200 : 2200);
  }

  /* ─────────── 影像處理 ─────────── */

  /** 讀入 Blob → { blob, w, h }（已套用 EXIF 方向） */
  async function probeImage(blob) {
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { w: bmp.width, h: bmp.height, bitmap: bmp };
    } catch (e) {
      // Safari 較舊版本不支援 imageOrientation
      try {
        bmp = await createImageBitmap(blob);
        return { w: bmp.width, h: bmp.height, bitmap: bmp };
      } catch (e2) {
        return await new Promise((res, rej) => {
          const url = URL.createObjectURL(blob);
          const im = new Image();
          im.onload = () => { res({ w: im.naturalWidth, h: im.naturalHeight, bitmap: null }); URL.revokeObjectURL(url); };
          im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('無法讀取影像')); };
          im.src = url;
        });
      }
    }
  }

  /**
   * 產生縮圖 Blob。若原圖大於 maxEdge 也會一併產生「縮小後的主圖」，
   * 避免動輒 4000px 的工地照塞爆 IndexedDB 與列印記憶體。
   */
  async function makeRaster(bitmap, maxEdge, quality) {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', quality || 0.86));
    return { blob, w, h };
  }

  /* ─────────── 檔案 ─────────── */
  function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  const blobToDataURL = blob => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });

  async function dataURLToBlob(url) {
    try {
      const r = await fetch(url);
      return await r.blob();
    } catch (_) {
      // 少數瀏覽器在 file:// 下不讓 fetch 讀 data: URL，改自己解碼
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
      if (!m) throw new Error('無法解析影像資料');
      const type = m[1] || 'application/octet-stream';
      if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
      const bin = atob(m[3]);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new Blob([buf], { type });
    }
  }

  /** 依檔名自然排序（IMG_2 排在 IMG_10 前面） */
  const natCmp = (a, b) =>
    String(a).localeCompare(String(b), 'zh-Hant', { numeric: true, sensitivity: 'base' });

  /* ─────────── 幾何 ─────────── */

  /** 把 (w,h) 依 contain 方式塞進 (bw,bh)，回傳置中後的矩形 */
  function fitContain(w, h, bw, bh) {
    if (!w || !h) return { x: 0, y: 0, w: bw, h: bh };
    const s = Math.min(bw / w, bh / h);
    const fw = w * s, fh = h * s;
    return { x: (bw - fw) / 2, y: (bh - fh) / 2, w: fw, h: fh, scale: s };
  }

  /** 線段從矩形中心射出時與矩形邊界的交點（用於引線起點貼齊卡片邊緣） */
  function rectEdgePoint(cx, cy, hw, hh, tx, ty) {
    const dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const sx = dx ? hw / Math.abs(dx) : Infinity;
    const sy = dy ? hh / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  SR.util = {
    $, $$, svgEl, el, uid, clamp, round, todayISO, fmtDate, toast,
    probeImage, makeRaster, downloadBlob, blobToDataURL, dataURLToBlob,
    natCmp, fitContain, rectEdgePoint
  };
})(window.SR);
