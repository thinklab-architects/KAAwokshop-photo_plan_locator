/* ══════════════════════════════════════════════════════════
   報告自動排版 — 純計算，輸出全部是 mm，不碰 DOM

   四個核心：
   1. 版面求解：在給定紙張與每頁張數下，試算各種「每欄幾張 / 上下要不要放」的組合，
      選留白最少的那一種。平面圖很扁時就會自動把照片排到上下，把中間的空白吃掉。
   2. 不交叉引線：照片依它最靠近平面圖的哪一邊分派到該邊，同一邊再依沿邊座標排序。
      單調對應保證同一邊的引線不會互相穿越。
   3. 多張平面圖：照片跟著它釘的那張圖分組，每張圖各自成一段圖面；
      沒定位的照片排進第一組。photo.sheet 是「組內」頁碼。
   4. 自由排版：photo.box / opts.planBoxes[planId] 覆寫算出來的位置。
   ══════════════════════════════════════════════════════════ */
(function (SR) {
  'use strict';
  const U = SR.util, CROP = SR.crop;

  const PAPER = {                 // 橫式 [寬, 高] mm
    A0: [1189, 841],
    A1: [841, 594],
    A2: [594, 420],
    A3: [420, 297]
  };

  const EDGES = ['L', 'R', 'T', 'B'];
  const DEF_PCT = { landscape: 0.185, portrait: 0.235 };
  // 自動排版會連「照片欄寬」一起搜尋，挑留白最少的組合，而不是寫死一個比例
  const PCTS = [0.14, 0.155, 0.17, 0.185, 0.20, 0.215, 0.23, 0.245, 0.26];

  /* ══════════ 卡片尺寸 ══════════
     說明列固定薄薄一條（約列高 15%，5.5–13mm），照片吃掉其餘全部 ——
     這是版面「擠得起來」的關鍵。 */
  function metrics(rows, cw, ch, G, pct) {
    const baseColW = cw * pct;
    const rowH   = (ch - (rows - 1) * G) / rows;
    const capH   = U.clamp(rowH * 0.15, 5.5, 13);
    const photoH = Math.min(baseColW * 0.78, rowH - capH);
    const colW   = Math.min(baseColW, photoH * 1.7);
    return { rowH, photoH, colW, capH, cardH: photoH + capH };
  }

  /** 依左右兩欄是否存在，算出中間平面圖區的水平範圍 */
  function midSpan(cap, cx0, cw, colW, G) {
    const lw = cap.L > 0 ? colW + G * 1.4 : 0;
    const rw = cap.R > 0 ? colW + G * 1.4 : 0;
    return { midX: cx0 + lw, midW: cw - lw - rw };
  }

  /* ══════════ 版面求解 ══════════ */
  function solve(o, geo) {
    const { cx0, cy0, cw, ch, G, planAR } = geo;
    const n = Math.max(2, +o.perSheet || 8);
    const defPct = DEF_PCT[o.orient] || DEF_PCT.landscape;

    /* ── 自動 / 只放兩側 ── */
    const sidesOnly = o.edges === 'sides';
    let best = null;

    for (let pi = 0; pi < PCTS.length; pi++)
    for (let r = Math.ceil(n / 2); r >= 1; r--) {
      const m = metrics(r, cw, ch, G, PCTS[pi]);
      const capTry = { L: r, R: r, T: 0, B: 0 };
      const { midX, midW } = midSpan(capTry, cx0, cw, m.colW, G);
      if (midW < m.colW * 1.2) continue;
      const cMax = Math.max(0, Math.floor((midW + G) / (m.colW + G)));

      const need = n - 2 * r;
      let nT = 0, nB = 0;
      if (need > 0) {
        if (sidesOnly || !cMax) continue;
        nT = Math.ceil(need / 2); nB = need - nT;
        if (nT > cMax) continue;
      }

      const planY = cy0 + (nT ? m.cardH + G : 0);
      const planH = ch - (nT ? m.cardH + G : 0) - (nB ? m.cardH + G : 0);
      if (planH < ch * 0.30) continue;

      // 主要指標：用掉多少版面（平面圖實際顯示面積 + 所有照片卡面積）。
      // 平面圖給 1.25 倍權重 —— 它是所有引線的參照點，被壓太小的話位置點會擠成一團。
      const pf = planAR ? U.fitContain(1, planAR, midW, planH) : { w: midW, h: planH };
      const fill = pf.w * pf.h * 1.25 + n * m.colW * m.cardH;
      // 次要指標：平面圖「框」的長寬比是否貼近平面圖本身。
      const miss = planAR ? Math.abs(Math.log((planH / midW) / planAR)) : 0;

      if (!best || fill > best.fill * 1.005 ||
          (fill > best.fill * 0.995 && miss < best.miss - 0.02)) {
        best = Object.assign({
          rows: r, cap: { L: r, R: r, T: nT, B: nB },
          midX, midW, planY, planH, fill, miss
        }, m);
      }
    }
    if (best) return best;

    // 什麼組合都不滿足（例如每頁張數極大）→ 退回最單純的兩側等分
    const r = Math.ceil(n / 2);
    const m = metrics(r, cw, ch, G, defPct);
    const cap = { L: r, R: r, T: 0, B: 0 };
    const { midX, midW } = midSpan(cap, cx0, cw, m.colW, G);
    return Object.assign({ rows: r, cap, midX, midW, planY: cy0, planH: ch, fill: 0, miss: 0 }, m);
  }

  /* ══════════ 分派到四邊的格位 ══════════ */
  /** 回傳 { L:[item|null,…], R:…, T:…, B:… }，長度等於該邊格位數 */
  function assign(items, planRect, cap) {
    const slots = {};
    EDGES.forEach(e => { slots[e] = new Array(Math.max(0, cap[e])).fill(null); });

    // 1) 先讓有指定位置的照片佔位
    const rest = [];
    items.forEach(it => {
      const s = it.ph.slot;
      if (s && slots[s.side] && s.i >= 0 && s.i < slots[s.side].length && !slots[s.side][s.i]) {
        slots[s.side][s.i] = it;
      } else rest.push(it);
    });

    const freeOf = e => slots[e].reduce((n, v) => n + (v ? 0 : 1), 0);
    const bucket = { L: [], R: [], T: [], B: [] };
    const room = { L: freeOf('L'), R: freeOf('R'), T: freeOf('T'), B: freeOf('B') };

    const distOf = pin => ({
      L: pin.x - planRect.x,
      R: planRect.x + planRect.w - pin.x,
      T: pin.y - planRect.y,
      B: planRect.y + planRect.h - pin.y
    });

    // 2) 越貼近某一邊的照片，越該優先拿到那一邊；因此依「最近距離」由小到大處理
    rest.filter(i => i.pin).map(it => {
      const d = distOf(it.pin);
      const order = EDGES.filter(e => room[e] > 0).sort((a, b) => d[a] - d[b]);
      return { it, order, best: order.length ? d[order[0]] : Infinity };
    })
    .sort((a, b) => a.best - b.best)
    .forEach(rk => {
      const e = rk.order.find(x => bucket[x].length < room[x])
             || EDGES.find(x => bucket[x].length < room[x]) || 'L';
      bucket[e].push(rk.it);
    });

    rest.filter(i => !i.pin).forEach(it => {
      const e = EDGES.find(x => bucket[x].length < room[x]) || 'L';
      bucket[e].push(it);
    });

    // 3) 每一邊依沿邊座標排序後填進剩下的空位 → 引線不會交叉
    const by = ax => (a, b) => (a.pin ? a.pin[ax] : Infinity) - (b.pin ? b.pin[ax] : Infinity);
    EDGES.forEach(e => {
      bucket[e].sort(by(e === 'L' || e === 'R' ? 'y' : 'x'));
      let k = 0;
      for (let i = 0; i < slots[e].length && k < bucket[e].length; i++) {
        if (!slots[e][i]) slots[e][i] = bucket[e][k++];
      }
    });
    return slots;
  }

  /* ══════════ 主流程 ══════════ */
  function build(proj) {
    const o = proj.opts;
    let [W, H] = PAPER[o.paper] || PAPER.A1;
    if (o.orient === 'portrait') { const t = W; W = H; H = t; }

    // 以 A1 為基準的等比縮放，讓不同紙張上的線寬與間距看起來一致
    const k = Math.min(W, H) / 594;

    const M   = U.round(10 * k, 2);
    // 標題欄高度設下限：A3 上若照 k 等比縮，標題文字會塞不下而被切掉
    const TH  = U.round(U.clamp(20 * k, 14, 26), 2);
    const G   = U.round(2.4 * k, 2);
    const STUB= U.round(5 * k, 2);
    // 圖框與內容之間的留白：照片、編號、說明文字都不該貼在圖框線上
    const PAD = U.round(Math.max(3, 4.5 * k), 2);

    const cx0 = M + PAD, cy0 = M + TH + PAD;
    const cw  = W - 2 * (M + PAD);
    const ch  = H - 2 * M - TH - 2 * PAD;

    const free = o.edges === 'free';
    const all = proj.photos;
    const plansArr = proj.plans || [];

    /* ── 依平面圖分組：照片跟著它釘的那張圖；沒定位（或圖已被移除）→ 第一組。
       每張平面圖至少出一張圖面，樓層還沒拍照也看得到圖。 ── */
    const groups = [];
    if (!plansArr.length) {
      groups.push({ plan: null, photos: all.slice() });
    } else {
      const byId = new Map(plansArr.map(p => [p.id, []]));
      all.forEach(ph => {
        const pid = (ph.pin && byId.has(ph.pin.planId)) ? ph.pin.planId : plansArr[0].id;
        byId.get(pid).push(ph);
      });
      plansArr.forEach(p => groups.push({ plan: p, photos: byId.get(p.id) }));
    }

    const sheets = [];

    groups.forEach(group => {
      const plan = group.plan;
      const gPhotos = group.photos;

      const planSize = plan ? CROP.size(plan) : null;
      const planAR = planSize ? planSize.h / planSize.w : null;

      const L = solve(o, { cx0, cy0, cw, ch, G, planAR });
      const { cap, colW, photoH, capH, cardH } = L;

      /* ── 比例尺：cal（圖上 px ↔ 實際 mm）＋ planScale（1:N）→ 紙上尺寸 ──
         紙上寬 = 裁切後像素寬 × (實際mm/px) ÷ N。 */
      const cal = plan ? plan.cal : null;
      const N = +o.planScale || 0;
      const scaleActive = !!(planSize && cal && cal.px > 0 && cal.mm > 0 && N > 0);
      const scaleW = scaleActive ? planSize.w * (cal.mm / cal.px) / N : 0;
      const scaleH = scaleActive ? planSize.h * (cal.mm / cal.px) / N : 0;

      // 自由模式：平面圖框只信任 x/y/w，高度一律由平面圖目前的長寬比推導；
      // 比例鎖定時連寬度都不信任，直接用 1:N 算出的紙上尺寸。
      const savedBox = (free && plan && o.planBoxes) ? o.planBoxes[plan.id] : null;
      const planBox = savedBox
        ? (() => { const w = scaleActive ? scaleW : Math.max(20, savedBox.w);
                   return { x: U.round(savedBox.x, 2), y: U.round(savedBox.y, 2),
                            w: U.round(w, 2),
                            h: U.round(planAR ? w * planAR : (savedBox.h || w), 2) }; })()
        : { x: U.round(L.midX, 2), y: U.round(L.planY, 2),
            w: U.round(L.midW, 2), h: U.round(L.planH, 2) };

      let scaleUsed = null, scaleWarn = null;
      const planImg = planSize
        ? (() => {
            if (scaleActive && free) {
              scaleUsed = N;
              return { x: planBox.x, y: planBox.y,
                       w: U.round(scaleW, 2), h: U.round(scaleH, 2) };
            }
            if (scaleActive && scaleW <= planBox.w + 0.5 && scaleH <= planBox.h + 0.5) {
              // 自動版面：1:N 放得下 → 置中、精確尺寸
              scaleUsed = N;
              return { x: U.round(planBox.x + (planBox.w - scaleW) / 2, 2),
                       y: U.round(planBox.y + (planBox.h - scaleH) / 2, 2),
                       w: U.round(scaleW, 2), h: U.round(scaleH, 2) };
            }
            const f = U.fitContain(planSize.w, planSize.h, planBox.w, planBox.h);
            if (scaleActive) {
              // 放不下：縮到可用空間，並回報實際上變成幾分之一
              const eff = planSize.w * (cal.mm / cal.px) / f.w;
              scaleWarn = { want: N, needW: U.round(scaleW, 0), needH: U.round(scaleH, 0),
                            actual: U.round(eff, 0) };
            }
            return { x: U.round(planBox.x + f.x, 2), y: U.round(planBox.y + f.y, 2),
                     w: U.round(f.w, 2), h: U.round(f.h, 2) };
          })()
        : null;

      /* ── 組內分頁 ── */
      const capacity = cap.L + cap.R + cap.T + cap.B;
      const perSheet = Math.max(1, Math.min(Math.max(2, +o.perSheet || 8), capacity || 99));
      let pages = [];
      if (free) {
        // 自由排版：photo.sheet 是「這一組裡」的頁碼（跨頁拖曳），沒指定的照原順序分頁。
        // 空白頁不輸出，把某頁的照片全搬走那一頁就會消失。
        const autoPage = new Map();
        gPhotos.forEach((p, i) => autoPage.set(p.id, Math.floor(i / perSheet)));
        let maxPage = Math.max(0, Math.ceil(gPhotos.length / perSheet) - 1);
        gPhotos.forEach(p => { if (p.sheet !== null && p.sheet !== undefined) maxPage = Math.max(maxPage, p.sheet | 0); });
        const buckets = [];
        for (let i = 0; i <= maxPage; i++) buckets.push([]);
        gPhotos.forEach(p => {
          const n = (p.sheet !== null && p.sheet !== undefined)
            ? U.clamp(p.sheet | 0, 0, maxPage) : autoPage.get(p.id);
          buckets[n].push(p);
        });
        pages = buckets.filter(b => b.length);
      } else {
        for (let i = 0; i < gPhotos.length; i += perSheet) pages.push(gPhotos.slice(i, i + perSheet));
      }
      if (!pages.length) pages.push([]);   // 這張平面圖還沒有照片 → 仍出一張只有圖的圖面

      /** 原圖正規化位置 → 圖面 mm 座標；被裁切掉或釘在別張圖的點回傳 null */
      const sheetPin = ph => {
        if (!planImg || !ph.pin || !plan || ph.pin.planId !== plan.id) return null;
        const pr = CROP.project(ph.pin, plan);
        return pr ? { x: planImg.x + pr.x * planImg.w, y: planImg.y + pr.y * planImg.h } : null;
      };

      const anchorRect = planImg || planBox;

      pages.forEach((pageGroup, pi) => {
        const items = pageGroup.map(ph => ({ ph, num: all.indexOf(ph) + 1, pin: sheetPin(ph) }));
        const slots = assign(items, anchorRect, cap);
        const cards = [], empties = [];

        /** 一個格位的左上角座標 */
        const slotXY = (side, i, count) => {
          if (side === 'L' || side === 'R') {
            const blockH = count * cardH + (count - 1) * G;
            const y0 = cy0 + Math.max(0, (ch - blockH) / 2);
            return { x: side === 'L' ? cx0 : cx0 + cw - colW, y: y0 + i * (cardH + G) };
          }
          const blockW = count * colW + (count - 1) * G;
          const x0 = planBox.x + Math.max(0, (planBox.w - blockW) / 2);
          return { x: x0 + i * (colW + G), y: side === 'T' ? cy0 : cy0 + ch - cardH };
        };

        /** 把一張照片放進格子：照片依實際長寬比 contain，說明文字緊貼在照片正下方 */
        const mk = (it, side, idx, sx, sy) => {
          const cs = CROP.size(it.ph);
          const f  = U.fitContain(cs.w || 4, cs.h || 3, colW, photoH);
          const total = f.h + capH;
          const top = sy + (cardH - total) / 2;
          const img = {
            x: U.round(sx + (colW - f.w) / 2, 2), y: U.round(top, 2),
            w: U.round(f.w, 2), h: U.round(f.h, 2)
          };
          const capR = {
            x: U.round(sx, 2), y: U.round(top + f.h, 2),
            w: U.round(colW, 2), h: U.round(capH, 2)
          };
          // 引線一律從朝向平面圖的那一側拉出
          const anchor =
            side === 'L' ? { x: img.x + img.w, y: img.y + img.h / 2 } :
            side === 'R' ? { x: img.x,         y: img.y + img.h / 2 } :
            side === 'T' ? { x: sx + colW / 2, y: capR.y + capR.h } :
                           { x: sx + colW / 2, y: img.y };
          cards.push({
            id: it.ph.id, photo: it.ph, num: it.num, side, idx,
            x: U.round(sx, 2), y: U.round(sy, 2), w: colW, h: cardH,
            imgRect: img, capRect: capR,
            anchor: { x: U.round(anchor.x, 2), y: U.round(anchor.y, 2) },
            pin: it.pin
          });
        };

        EDGES.forEach(side => {
          const arr = slots[side];
          if (!arr.length) return;
          const list = arr.filter(Boolean);
          const count = list.length;
          list.forEach((it, i) => {
            const p = slotXY(side, i, count);
            mk(it, side, i, p.x, p.y);
          });
        });

        // 自由排版下每頁張數不受格位容量限制（照片可以跨頁搬過來），
        // 所以格位沒收下的照片要補上，否則會憑空消失
        if (free) {
          const placed = new Set(cards.map(c => c.id));
          items.filter(it => !placed.has(it.ph.id)).forEach((it, kk) => {
            const b = it.ph.box || {
              x: cx0 + (kk % 3) * (colW + G),
              y: cy0 + Math.floor(kk / 3) * (cardH + G)
            };
            mk(it, 'L', -1, b.x, b.y);
          });
        }

        /* ── 自由排版：用照片自己的 box 覆寫上面算出來的格位位置 ── */
        if (free) {
          const capRatio = capH / colW;
          cards.forEach(c => {
            const b = c.photo.box;
            if (!b) return;
            const cs = CROP.size(c.photo);
            const ar = (cs.h || 3) / (cs.w || 4);
            const iw = b.w, ih = b.w * ar;
            const ch2 = Math.max(capH * 0.45, b.w * capRatio);
            c.free = true;
            c.x = U.round(b.x, 2); c.y = U.round(b.y, 2);
            c.w = U.round(iw, 2);  c.h = U.round(ih + ch2, 2);
            c.imgRect = { x: c.x, y: c.y, w: c.w, h: U.round(ih, 2) };
            c.capRect = { x: c.x, y: U.round(b.y + ih, 2), w: c.w, h: U.round(ch2, 2) };
          });
          // 引線改從「卡片中心朝向位置點」那一側的邊緣拉出，任意角度都正確
          cards.forEach(c => {
            if (!c.pin) return;
            const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
            const e = U.rectEdgePoint(cx, cy, c.w / 2, c.h / 2, c.pin.x, c.pin.y);
            c.anchor = { x: U.round(e.x, 2), y: U.round(e.y, 2) };
          });
        }

        /* ── 引線 ── */
        const leaders = [];
        if (o.leaders) cards.forEach(c => {
          if (!c.pin) return;
          const a = c.anchor;
          const mid = free ? null :
            c.side === 'L' ? { x: a.x + STUB, y: a.y } :
            c.side === 'R' ? { x: a.x - STUB, y: a.y } :
            c.side === 'T' ? { x: a.x, y: a.y + STUB } :
                             { x: a.x, y: a.y - STUB };
          leaders.push({
            num: c.num,
            pts: mid
              ? [[a.x, a.y], [U.round(mid.x, 2), U.round(mid.y, 2)],
                 [U.round(c.pin.x, 2), U.round(c.pin.y, 2)]]
              : [[a.x, a.y], [U.round(c.pin.x, 2), U.round(c.pin.y, 2)]],
            pin: { x: U.round(c.pin.x, 2), y: U.round(c.pin.y, 2) },
            dir: (c.photo.dir === null || c.photo.dir === undefined) ? null : c.photo.dir
          });
        });

        /* ── 同一張平面圖、其他頁照片的位置點（淡色參考） ── */
        const onThis = new Set(pageGroup.map(p => p.id));
        const ghosts = (o.ghost && planImg)
          ? gPhotos.filter(p => p.pin && !onThis.has(p.id))
               .map(sheetPin).filter(Boolean)
               .map(s => ({ x: U.round(s.x, 2), y: U.round(s.y, 2) }))
          : [];

        sheets.push({
          // index / total 之後統一補（要等全部組跑完才知道總頁數）
          planId: plan ? plan.id : null,
          planBlobId: plan ? plan.blobId : null,
          planName: plan ? plan.name : '',
          planCount: plansArr.length,
          localIndex: pi, localTotal: pages.length,
          W, H, k, M, TH, G, PAD, colW, photoH, capH, cardH,
          rows: L.rows, cap, capacity, perSheet,
          topCount: cap.T, bottomCount: cap.B,
          font: +o.font || 1,
          scaleUsed, scaleWarn, hasCal: !!(cal && cal.px > 0),
          cropped: gPhotos.filter(p => p.pin && p.pin.planId === (plan && plan.id) && !sheetPin(p)).length,
          // 標題欄字級由標題欄高度推得，任何紙張都不會塞不下
          titleFont: {
            k: U.round(Math.max(TH * 0.17, 2.3), 2),
            v: U.round(TH * 0.22, 2),
            w: U.round(TH * 0.26, 2),
            p: U.round(TH * 0.26, 2),
            pad: U.round(Math.max(1.8, 3 * k), 2)
          },
          content: { x: cx0, y: cy0, w: cw, h: ch },
          free,
          planBox, planImg, cards, empties: free ? [] : empties, leaders, ghosts,
          pinR: U.round(3.6 * k, 2),
          pinFont: U.round(4.2 * k, 2),
          coneR: U.round(11 * k, 2)
        });
      });
    });

    sheets.forEach((s, i) => { s.index = i + 1; s.total = sheets.length; });
    return sheets;
  }

  /** 目前自動算出來的配置，供外部參考起始值 */
  function autoSlots(proj) {
    const s = build(proj)[0];
    return { L: s.cap.L, R: s.cap.R, T: s.cap.T, B: s.cap.B, colWPct: s.colW / s.content.w };
  }

  SR.layout = { build, autoSlots, PAPER, DEF_PCT };
})(window.SR);
