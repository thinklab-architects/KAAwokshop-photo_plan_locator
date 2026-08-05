/* ══════════════════════════════════════════════════════════
   檔案轉換 — PDF 在瀏覽器內轉成影像

   全部本機處理，檔案不離開這台電腦。
   引擎用到才載入（lazy）：PDF → vendor/pdfjs（Mozilla pdf.js）

   DWG/DXF 曾以 LibreDWG（WASM）直接轉檔，已移除：轉換器產出的 SVG
   在實務圖檔上錯誤太多（文字未跳脫 XML、新版 DWG 轉不出圖形、大圖撐爆
   字串上限並凍住畫面）。請改由 CAD 輸出 PDF 再匯入。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util;

  const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
  // 不再轉檔，只用來認出 CAD 檔並給明確指引
  const isCad = f => /\.(dwg|dxf)$/i.test(f.name || '');
  const isImage = f => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '');

  const CAD_HINT = 'DWG／DXF 不支援，請在 CAD 裡輸出 PDF（或另存圖檔）再匯入';

  /* ─────────── PDF ─────────── */
  let pdfjsReady = null;

  function loadPdfJs() {
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'vendor/pdfjs/pdf.min.js';
      sc.onload = () => {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
          res(window.pdfjsLib);
        } catch (e) { rej(e); }
      };
      sc.onerror = () => rej(new Error('無法載入 PDF 引擎（vendor/pdfjs）'));
      document.head.appendChild(sc);
    });
    return pdfjsReady;
  }

  /**
   * PDF → 影像 File 陣列。
   * @param opts.maxEdge   輸出長邊像素（照片 2000 / 平面圖 4000）
   * @param opts.pages     指定頁碼陣列（1 起算）；不給就全部
   * @param opts.maxPages  頁數上限，超過會截斷並回報
   * @returns { files, total, rendered, truncated }
   */
  async function pdfToImages(file, opts) {
    const o = opts || {};
    const lib = await loadPdfJs();
    const buf = await file.arrayBuffer();
    const doc = await lib.getDocument({ data: buf }).promise;

    const total = doc.numPages;
    let pages = o.pages && o.pages.length
      ? o.pages.filter(n => n >= 1 && n <= total)
      : Array.from({ length: total }, (_, i) => i + 1);
    const cap = o.maxPages || 30;
    const truncated = pages.length > cap;
    if (truncated) pages = pages.slice(0, cap);

    const base = (file.name || 'pdf').replace(/\.pdf$/i, '');
    const files = [];
    const metas = [];
    for (const n of pages) {
      const page = await doc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      // PDF 座標 1pt = 1/72 吋 → 原始頁面實體尺寸（mm），輸入式比例尺要用
      metas.push({ srcMM: { w: U.round(vp1.width * 25.4 / 72, 1),
                            h: U.round(vp1.height * 25.4 / 72, 1) } });
      const scale = Math.min(8, (o.maxEdge || 2000) / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const ctx = cv.getContext('2d');
      // PDF 常是透明底，畫在白底上才不會出現黑底照片
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      // intent:'print' 讓 pdf.js 用 microtask 而非 requestAnimationFrame 排程 ——
      // 分頁在背景（或任何不合成畫格的環境）時，rAF 不觸發會讓渲染永遠卡住
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
      files.push(new File([blob],
        total > 1 ? `${base}_p${n}.jpg` : `${base}.jpg`, { type: 'image/jpeg' }));
      page.cleanup && page.cleanup();
    }
    doc.destroy && doc.destroy();
    return { files, metas, total, rendered: pages, truncated };
  }

  /** 問 PDF 頁數，不渲染（平面圖多頁時先問要哪頁） */
  async function pdfPageCount(file) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = doc.numPages;
    doc.destroy && doc.destroy();
    return n;
  }

  /* ─────────── 匯入前置處理 ───────────
     把使用者給的一批檔案（影像 / PDF）展開成純影像 File 清單 */

  /** 照片用：影像直接過，PDF 每頁一張 */
  async function expandForPhotos(files) {
    const out = [], notes = [];
    for (const f of files) {
      if (isImage(f)) { out.push(f); continue; }
      if (isPdf(f)) {
        U.toast('轉換 PDF：' + f.name + ' …');
        try {
          const r = await pdfToImages(f, { maxEdge: 2000, maxPages: 30 });
          out.push(...r.files);
          if (r.truncated) notes.push(f.name + ' 共 ' + r.total + ' 頁，只取前 30 頁');
        } catch (e) { console.error(e); notes.push(f.name + '：' + e.message); }
        continue;
      }
      if (isCad(f)) { notes.push(f.name + '：' + CAD_HINT); continue; }
      notes.push(f.name + '：不支援的格式');
    }
    return { files: out, notes };
  }

  /** 解析「1,3-5」這種頁碼字串 */
  function parsePages(str, total) {
    if (!str || /^all$|^全部$/i.test(str.trim())) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const out = new Set();
    str.split(/[,，、\s]+/).forEach(tk => {
      const m = tk.match(/^(\d+)\s*[-–~]\s*(\d+)$/);
      if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= total) out.add(i); }
      else { const n = parseInt(tk, 10); if (n >= 1 && n <= total) out.add(n); }
    });
    return Array.from(out).sort((a, b) => a - b);
  }

  /**
   * 平面圖用：一個檔案 → 一或多張平面圖。
   *   影像 → 1 張；PDF 多頁 → 問要哪些頁（預設全部，各成一張平面圖）。
   * @returns [{ file, meta }]；使用者取消回傳 []
   */
  async function plansFromFile(f) {
    if (isImage(f)) return [{ file: f, meta: null }];
    if (isPdf(f)) {
      const total = await pdfPageCount(f);
      let pages = [1];
      if (total > 1) {
        const ans = window.prompt(
          '這份 PDF 有 ' + total + ' 頁，每頁會各成一張平面圖。\n要匯入哪些頁？（例：1,3-5；all＝全部）', 'all');
        if (ans === null) return [];
        pages = parsePages(ans, total);
        if (!pages.length) { U.toast('沒有有效的頁碼', true); return []; }
        if (pages.length > 12 && !window.confirm('要一次匯入 ' + pages.length + ' 張平面圖嗎？')) return [];
      }
      U.toast('轉換 PDF ' + pages.length + ' 頁…');
      const r = await pdfToImages(f, { maxEdge: 4000, pages, maxPages: 24 });
      return r.files.map((file, i) => ({ file, meta: r.metas[i] || null }));
    }
    if (isCad(f)) throw new Error(CAD_HINT);
    throw new Error('平面圖支援：影像、PDF');
  }

  SR.convert = { isPdf, isCad, isImage, CAD_HINT,
                 pdfToImages, pdfPageCount,
                 expandForPhotos, plansFromFile, parsePages };
})(window.SR);
