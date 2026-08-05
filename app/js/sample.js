/* ══════════════════════════════════════════════════════════
   內建示範資料

   第一次開啟（資料庫裡一份紀錄都沒有）時自動載入兩份示範紀錄，
   讓人一進來就有東西可以點、可以按「產生報告」看結果。

   資料本體（含影像，約 1.8 MB）放在 sample/data.js，
   用到才以 <script> 掛進來 —— 不能用 fetch，因為雙擊 index.html
   走 file:// 時 fetch 會被同源政策擋掉，<script> 則照樣載得進來。

   載入過就記在 localStorage，之後把示範資料刪掉也不會自己長回來。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state;

  const FLAG = 'sitelog.sampleSeeded';
  const SRC  = 'sample/data.js';

  const seen = () => { try { return !!localStorage.getItem(FLAG); } catch (_) { return false; } };
  const mark = () => { try { localStorage.setItem(FLAG, '1'); } catch (_) {} };

  let loading = null;
  function loadData() {
    if (SR.sampleData) return Promise.resolve(SR.sampleData);
    if (loading) return loading;
    loading = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = SRC;
      sc.onload = () => SR.sampleData ? res(SR.sampleData) : rej(new Error('示範資料檔內容不正確'));
      sc.onerror = () => rej(new Error('找不到 ' + SRC));
      document.head.appendChild(sc);
    });
    return loading;
  }

  /** 把示範資料寫成新的紀錄。回傳加入的份數。 */
  async function install() {
    const data = await loadData();
    const recs = (data && data.records) || [];
    let n = 0;
    for (const r of recs) {
      // 每次都當成新的一份匯入：id 與 blobId 全部換新，不會蓋掉既有資料
      await ST.importObject(JSON.parse(JSON.stringify(r)));
      n++;
    }
    mark();
    return n;
  }

  /** 首頁「示範資料」按鈕 */
  async function loadNow() {
    try {
      U.toast('載入示範資料…');
      const data = await loadData();
      // 已經有一份了還按，多半是手滑；問一下，不然按兩下就多出兩份一模一樣的
      const names = new Set(((data && data.records) || []).map(r => (r.meta || {}).project).filter(Boolean));
      const rows = await ST.listProjects();
      if (rows.some(r => names.has((r.meta.project || '').trim())) &&
          !window.confirm('示範資料已經在清單裡了，要再加入一份嗎？')) {
        U.toast('已取消');
        return;
      }
      const n = await install();
      await SR.home.refresh();
      U.toast('已加入 ' + n + ' 份示範紀錄');
    } catch (e) {
      console.error(e);
      U.toast('載入示範資料失敗：' + e.message, true);
    }
  }

  /** 啟動時呼叫：只有「沒載過」而且「一份紀錄都沒有」才會塞進去 */
  async function maybeSeed() {
    if (seen()) return false;
    try {
      const rows = await ST.listProjects();
      if (rows.length) { mark(); return false; }   // 使用者已經有自己的資料了
      await install();
      return true;
    } catch (e) {
      console.warn('示範資料載入失敗', e);
      return false;
    }
  }

  SR.sample = { maybeSeed, loadNow, install };
})(window.SR);
