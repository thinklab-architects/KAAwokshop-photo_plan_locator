/* ══════════════════════════════════════════════════════════
   主介面 — 依「專案」分組列出所有現場紀錄

   一個專案（工程 / 案場）底下可以有很多份紀錄報告，
   分組鍵就是每份紀錄的 meta.project（專案名稱）。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, ST = SR.state;
  const { $, el } = U;

  let rows = [];            // 目前載入的摘要
  let query = '';
  let sortBy = 'updated';

  /* ─────────── 相對時間 ─────────── */
  function ago(ts) {
    if (!ts) return '';
    const d = Date.now() - ts, m = Math.floor(d / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return m + ' 分鐘前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小時前';
    const day = Math.floor(h / 24);
    if (day === 1) return '昨天';
    if (day < 7) return day + ' 天前';
    const dt = new Date(ts), p = n => String(n).padStart(2, '0');
    return dt.getFullYear() + '.' + p(dt.getMonth() + 1) + '.' + p(dt.getDate());
  }

  /* ─────────── 讀取與繪製 ─────────── */
  async function refresh() {
    rows = await ST.listProjects();
    // 封面縮圖需要 object URL
    await Promise.all(rows.filter(r => r.coverId).map(r => ST.url(r.coverId)));
    render();
  }

  function filtered() {
    const q = query.trim().toLowerCase();
    let out = rows;
    if (q) out = out.filter(r => {
      const m = r.meta;
      return [m.project, m.subject, m.author, m.date].join(' ').toLowerCase().includes(q);
    });
    out = out.slice();
    if (sortBy === 'name')   out.sort((a, b) => U.natCmp(a.meta.project || '', b.meta.project || ''));
    if (sortBy === 'date')   out.sort((a, b) => String(b.meta.date || '').localeCompare(String(a.meta.date || '')));
    if (sortBy === 'photos') out.sort((a, b) => b.photoCount - a.photoCount);
    if (sortBy === 'updated')out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  /** 依專案名稱分組；組的順序 = 排序後第一筆出現的順序，未分類固定最後 */
  function grouped(list) {
    const map = new Map();
    list.forEach(r => {
      const key = (r.meta.project || '').trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    });
    const groups = Array.from(map, ([name, items]) => ({ name, items }));
    return groups.sort((a, b) => (a.name === '' ? 1 : 0) - (b.name === '' ? 1 : 0));
  }

  function render() {
    const host = $('#projGrid');
    const list = filtered();
    host.textContent = '';
    grouped(list).forEach(g => host.appendChild(groupSection(g)));

    $('#projEmpty').hidden   = rows.length > 0;
    $('#projNoMatch').hidden = !(rows.length > 0 && list.length === 0);

    const names = new Set(rows.map(r => (r.meta.project || '').trim()).filter(Boolean));
    const totalPhotos = rows.reduce((s, r) => s + r.photoCount, 0);
    $('#projStats').textContent = rows.length
      ? `共 ${names.size} 個專案 · ${rows.length} 份紀錄 · ${totalPhotos} 張照片`
      : '';
  }

  /** 一個專案：標題列（名稱、份數、動作）＋ 底下的紀錄卡片 */
  function groupSection(g) {
    const sec = el('section', 'projGroup');
    const head = el('div', 'pgHead');

    head.appendChild(el('h2', 'pgName' + (g.name ? '' : ' none'), g.name || '未分類（沒填專案名稱）'));
    head.appendChild(el('span', 'pgCount', g.items.length + ' 份紀錄'));

    const acts = el('div', 'pgActs');
    const mkBtn = (label, title, fn, cls) => {
      const b = el('button', 'pgAct' + (cls ? ' ' + cls : ''), label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    if (g.name) {
      acts.appendChild(mkBtn('重新命名', '改這個專案的名稱（底下所有紀錄一起改）', () => renameGroup(g)));
    }
    acts.appendChild(mkBtn('＋ 新增紀錄', '在這個專案底下開一份新紀錄', () => create(g.name), 'primary'));
    head.appendChild(acts);
    sec.appendChild(head);

    const grid = el('div', 'pgGrid');
    g.items.forEach(r => grid.appendChild(cardFor(r)));
    sec.appendChild(grid);
    return sec;
  }

  async function renameGroup(g) {
    const name = prompt('專案的新名稱（底下 ' + g.items.length + ' 份紀錄一起改）：', g.name);
    if (name === null) return;
    const v = name.trim();
    if (!v || v === g.name) return;
    for (const r of g.items) await ST.setProjectName(r.id, v);
    await refresh();
    U.toast('已把專案改名為「' + v + '」');
  }

  function cardFor(r) {
    const card = el('article', 'projCard');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    /* 封面 */
    const cover = el('div', 'pcCover');
    if (r.coverId && ST.urlSync(r.coverId)) {
      const im = new Image();
      im.src = ST.urlSync(r.coverId);
      im.alt = '';
      cover.appendChild(im);
    } else {
      cover.classList.add('blank');
      cover.appendChild(el('span', null, '尚無照片'));
    }

    const badges = el('div', 'pcBadges');
    if (!r.hasPlan) badges.appendChild(el('span', 'pcBadge warn', '缺平面圖'));
    else if (r.photoCount && r.pinnedCount < r.photoCount)
      badges.appendChild(el('span', 'pcBadge warn', (r.photoCount - r.pinnedCount) + ' 張未定位'));
    else if (r.photoCount) badges.appendChild(el('span', 'pcBadge ok', '已完成定位'));
    cover.appendChild(badges);
    card.appendChild(cover);

    /* 內文：專案名稱已經在分組標題上，卡片主標改用「紀錄項目」 */
    const body = el('div', 'pcBody');
    body.appendChild(el('h3', 'pcTitle' + (r.meta.subject ? '' : ' none'), r.meta.subject || '未填寫紀錄項目'));

    const facts = el('div', 'pcFacts');
    facts.appendChild(el('span', null, U.fmtDate(r.meta.date) || '無日期'));
    facts.appendChild(el('span', null, r.photoCount + ' 張'));
    facts.appendChild(el('span', null, (r.opts.paper || 'A3') + (r.opts.orient === 'portrait' ? ' 直式' : ' 橫式')));
    if (r.meta.author) facts.appendChild(el('span', null, r.meta.author));
    body.appendChild(facts);
    body.appendChild(el('div', 'pcTime', '編輯於 ' + ago(r.updatedAt)));
    card.appendChild(body);

    /* 動作 */
    const acts = el('div', 'pcActions');
    const act = (label, title, fn, cls) => {
      const b = el('button', 'pcAct' + (cls ? ' ' + cls : ''), label);
      b.title = title;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };
    acts.appendChild(act('複製', '複製一份（影像一併複製，兩份互不影響）', () => dup(r.id)));
    acts.appendChild(act('匯出', '存成 .sitelog 備份檔', () => exportOne(r)));
    acts.appendChild(act('刪除', '刪除這份紀錄', () => del(r), 'danger'));
    card.appendChild(acts);

    card.addEventListener('click', () => SR.app.openProject(r.id));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); SR.app.openProject(r.id); }
    });
    return card;
  }

  /* ─────────── 動作 ─────────── */
  /** @param projectName 從專案分組的「＋ 新增紀錄」進來時會帶名稱，新紀錄直接歸進該專案 */
  async function create(projectName) {
    const id = await ST.createProject(
      (typeof projectName === 'string' && projectName) ? { project: projectName } : undefined);
    await SR.app.openProject(id);
  }

  async function dup(id) {
    try {
      U.toast('複製中…');
      await ST.duplicateProject(id);
      await refresh();
      U.toast('已複製一份');
    } catch (e) { console.error(e); U.toast('複製失敗：' + e.message, true); }
  }

  async function exportOne(r) {
    try {
      U.toast('打包中…');
      const blob = await ST.exportProject(r.id);
      const name = [(r.meta.project || '圖說紀錄'), (r.meta.subject || ''), (r.meta.date || '')]
        .filter(Boolean).join('_').replace(/[\\/:*?"<>|]/g, '-');
      U.downloadBlob(blob, name + '.sitelog');
      U.toast('已匯出');
    } catch (e) { console.error(e); U.toast('匯出失敗：' + e.message, true); }
  }

  async function del(r) {
    const label = [r.meta.project, r.meta.subject].filter(Boolean).join('－') || '這份未命名紀錄';
    if (!confirm(`刪除「${label}」？\n包含 ${r.photoCount} 張照片與所有標註，無法復原。`)) return;
    await ST.deleteProject(r.id);
    await refresh();
    U.toast('已刪除');
  }

  async function importFile(file) {
    try {
      U.toast('讀取紀錄中…');
      const id = await ST.importProject(file);
      await refresh();
      U.toast('已加入一份紀錄');
      return id;
    } catch (e) { console.error(e); U.toast('開啟失敗：' + e.message, true); return null; }
  }

  /* ─────────── 啟動 ─────────── */
  function mount() {
    $('#btnNewProj').addEventListener('click', () => create());
    $('#btnOpenFile').addEventListener('click', () => $('#fileProj').click());
    $('#btnHelp').addEventListener('click', () =>
      window.open('docs/使用說明.html', '_blank', 'noopener'));
    $('#btnSample').addEventListener('click', () => SR.sample.loadNow());

    $('#projSearch').addEventListener('input', e => { query = e.target.value; render(); });
    $('#projSort').addEventListener('change', e => { sortBy = e.target.value; render(); });
  }

  SR.home = { mount, refresh, render, importFile, create };
})(window.SR);
