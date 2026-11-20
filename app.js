// 抽獎系統 UI。所有資料存取都經由傳入的 api,方便測試時替換。
import { parsePrizes, parsePeople, toCsv } from './lib/parse.js';
import { createFx } from './lib/fx.js';

const ERRORS = {
  FORBIDDEN: '沒有權限執行這個操作',
  PRIZE_NOT_FOUND: '找不到這個獎項',
  ALREADY_DRAWN: '這個獎項已經抽過了,結果已鎖定',
  NO_ELIGIBLE: '沒有符合資格的抽獎人了(每個人都已達得獎上限)',
  REASON_REQUIRED: '請填寫更正原因',
  DRAW_NOT_FOUND: '這個獎項還沒有抽獎結果',
  SAME_PERSON: '新的得獎人與原本相同',
  PERSON_NOT_FOUND: '找不到這位抽獎人',
  LIMIT_REACHED: '這位抽獎人已達得獎上限(更正時可勾選「允許超過上限」)',
};

export function errorText(e) {
  const raw = `${e?.message ?? e ?? ''}`;
  for (const [code, text] of Object.entries(ERRORS)) if (raw.includes(code)) return text;
  if (/foreign key|violates/i.test(raw)) return '已有抽獎結果與它關聯,無法刪除(請先作廢該結果)';
  if (/Invalid login/i.test(raw)) return '帳號或密碼錯誤';
  return raw || '發生未知錯誤';
}

const fmtTime = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function init(api, doc = document, opts = {}) {
  const HOLD_MS = opts.holdMs ?? 3500; // 連續自動抽:每個獎揭曉後停留的時間
  const FLIP_MS = opts.flipMs ?? 1100; // 單次抽獎:揭曉後保留翻牌動畫的時間,之後才重繪整頁
  const $ = (sel) => doc.querySelector(sel);

  // ---------- 小工具 ----------
  function h(tag, props, ...kids) {
    const el = doc.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    }
    if (value !== undefined) el.value = value;
    return el;
  }

  let toastTimer;
  function toast(msg, kind = 'info') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 4500);
  }

  // ---------- 狀態 ----------
  const state = {
    prizes: [], people: [], draws: [], audit: [],
    settings: { max_per_person: 2, prefer_unwon: true },
    user: null, role: null,
    tab: 'draw', busy: false, revealing: false, pending: false, auto: false, stopAuto: false,
  };
  const ui = { prizeId: '', last: null, prizeText: '', peopleText: '', fx: { sound: false } };
  try {
    const saved = JSON.parse(doc.defaultView?.localStorage?.getItem('lottery-fx') || 'null');
    if (saved && typeof saved === 'object') Object.assign(ui.fx, saved);
  } catch { /* 沒有儲存空間也沒關係 */ }
  const saveFx = () => { try { doc.defaultView?.localStorage?.setItem('lottery-fx', JSON.stringify(ui.fx)); } catch { /* 忽略 */ } };
  const fx = createFx(doc);

  const drawByPrize = () => new Map(state.draws.map((d) => [d.prize_id, d]));
  const personById = () => new Map(state.people.map((p) => [p.id, p]));
  const winCounts = () => {
    const m = new Map();
    for (const d of state.draws) m.set(d.person_id, (m.get(d.person_id) || 0) + 1);
    return m;
  };
  const isAdmin = () => state.role === 'admin';
  const canDraw = () => state.role === 'admin' || state.role === 'operator';
  const personLabel = (p) => (p.note ? `${p.name}(${p.note})` : p.name);

  async function refresh() {
    const data = await api.loadAll();
    Object.assign(state, data);
    render();
  }

  async function refreshAuth() {
    state.user = await api.user();
    state.role = state.user ? await api.role() : null;
  }

  // ---------- 渲染 ----------
  function isTyping() {
    const a = doc.activeElement;
    return !!a && a !== doc.body && !!$('#view')?.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName);
  }

  function render() {
    if (state.revealing) { state.pending = true; return; }
    if (isTyping()) { state.pending = true; return; }
    state.pending = false;
    renderAuth();
    renderTabs();
    const view = $('#view');
    view.replaceChildren(
      state.tab === 'results' ? viewResults() : state.tab === 'admin' ? viewAdmin() : viewDraw(),
    );
  }

  function renderAuth() {
    const box = $('#auth');
    if (!state.user) {
      box.replaceChildren(h('span', { class: 'muted' }, '觀眾模式(唯讀)'),
        h('button', { class: 'btn small', onclick: openLogin }, '工作人員登入'));
      return;
    }
    const roleText = state.role === 'admin' ? 'Admin' : state.role === 'operator' ? '抽獎操作員' : '無權限帳號';
    box.replaceChildren(
      h('span', { class: `chip ${state.role || 'none'}` }, roleText),
      h('span', { class: 'muted email' }, state.user.email || ''),
      h('button', { class: 'btn small', onclick: async () => { await api.signOut(); } }, '登出'),
    );
  }

  function renderTabs() {
    const tabs = [['draw', '抽獎'], ['results', '結果']];
    if (isAdmin()) tabs.push(['admin', '管理']);
    if (state.tab === 'admin' && !isAdmin()) state.tab = 'draw';
    $('#tabs').replaceChildren(...tabs.map(([id, label]) =>
      h('button', {
        class: `tab${state.tab === id ? ' active' : ''}`,
        'aria-current': state.tab === id ? 'page' : null,
        onclick: () => { state.tab = id; render(); },
      }, label)));
  }

  // ----- 抽獎頁 -----
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pips = (n, max) => (max <= 4 ? '●'.repeat(Math.min(n, max)) + '○'.repeat(Math.max(0, max - n)) : `×${n}`);

  function viewDraw() {
    const dp = drawByPrize();
    const pm = personById();
    const wins = winCounts();
    const open = state.prizes.filter((p) => !dp.has(p.id));
    const max = state.settings.max_per_person;

    // 預設選下一個還沒抽的獎(接在剛抽完的後面)
    if (!open.some((p) => p.id === ui.prizeId)) {
      const lastIdx = ui.last ? state.prizes.findIndex((p) => p.id === ui.last.prizeId) : -1;
      ui.prizeId = (open.find((p) => state.prizes.indexOf(p) > lastIdx) || open[0])?.id || '';
    }
    const selected = state.prizes.find((p) => p.id === ui.prizeId);

    const cs = controlState();
    const btn = h('button', { class: 'btn big', id: 'drawBtn', onclick: onDraw, disabled: cs.drawDisabled },
      open.length ? '🎲 開始抽獎' : '全部抽完了');
    const autoBtn = h('button', { class: 'btn big alt', id: 'autoBtn', onclick: onAuto, disabled: cs.autoDisabled }, cs.autoText);

    const fxBox = (key, label) => {
      const cb = h('input', { type: 'checkbox', onchange: (e) => { ui.fx[key] = e.target.checked; saveFx(); } });
      cb.checked = !!ui.fx[key];
      return h('label', { class: 'check' }, cb, label);
    };

    const warn = [];
    if (drawFinished()) {
      warn.push(h('div', { class: 'note' },
        `每個人都已得獎 ${max} 個,抽獎結束(還有 ${open.length} 個獎項未抽出)。`));
    }
    if (!state.people.length || !state.prizes.length) {
      warn.push(h('div', { class: 'note' }, '還沒有資料。請 admin 到「管理」分頁匯入獎項與抽獎名單。'));
    }
    if (!canDraw()) {
      warn.push(h('div', { class: 'note' },
        state.user ? '這個帳號沒有抽獎權限。' : '你正以觀眾身分觀看,畫面會即時更新;要執行抽獎請先登入工作人員帳號。'));
    }

    const cards = state.prizes.map((p, i) => {
      const d = dp.get(p.id);
      const winner = d && pm.get(d.person_id);
      const isSel = !d && !randomPrize() && p.id === ui.prizeId;
      return h('button', {
        class: `pcard${d ? ' flipped' : ''}${isSel ? ' selected' : ''}`, type: 'button', 'data-prize': p.id,
        'aria-pressed': d ? null : String(isSel),
        'aria-label': d ? `${p.name},得獎人:${winner?.name ?? ''}` : `${p.name},尚未抽出`,
        disabled: !d && !canDraw(),
        onclick: () => selectPrize(p.id),
      }, h('div', { class: 'pcard-inner' },
        h('div', { class: 'pcard-front' }, h('span', { class: 'pnum' }, String(i + 1).padStart(2, '0')), h('span', { class: 'pname' }, p.name)),
        h('div', { class: 'pcard-back' }, h('span', { class: 'plabel' }, p.name), h('span', { class: 'pwinner' }, winner ? winner.name : ''))));
    });

    const tags = state.people.map((p) => {
      const n = wins.get(p.id) || 0;
      return h('div', { class: `ptag${n ? ' has' : ''}${ui.last?.personId === p.id ? ' last' : ''}`, 'data-person': p.id, title: p.note || null },
        h('span', { class: 'ptag-name' }, p.name),
        h('span', { class: 'pips', 'aria-label': `已得 ${n} 個` }, pips(n, max)));
    });

    return h('section', { class: 'panel' },
      h('div', { class: 'stage', 'aria-live': 'polite' },
        h('div', { class: 'stage-prize', id: 'stagePrize' },
          ui.last ? ui.last.prize : randomPrize() ? (open.length ? '獎項與得獎人都會隨機抽出' : '全部抽完了') : (selected ? selected.name : '請在下方選一個獎項')),
        h('div', { class: 'reel', id: 'stageName' },
          h('span', { class: 'reel-item' }, ui.last ? ui.last.name : '？')),
        h('div', { class: 'countdown', id: 'countdown', 'aria-hidden': 'true' })),
      h('div', { class: 'controls' }, btn, autoBtn),
      h('div', { class: 'fx-row' }, fxBox('sound', '音效')),
      ...warn,
      h('h3', null, `獎項(剩 ${open.length} / ${state.prizes.length})`,
        canDraw() && open.length ? h('span', { class: 'hint' }, randomPrize() ? '獎項會隨機抽出' : '點一張牌選擇要抽的獎') : null),
      state.prizes.length ? h('div', { class: 'pcards' }, cards) : h('p', { class: 'muted' }, '還沒有獎項。'),
      h('h3', null, `抽獎人(${state.people.length} 人,已得獎 ${wins.size} 人)`),
      state.people.length ? h('div', { class: 'ptags' }, tags) : h('p', { class: 'muted' }, '還沒有名單。'),
      h('p', { class: 'muted small rule' },
        `每人上限 ${max} 個。`,
        state.settings.prefer_unwon
          ? '規則:先讓每個人都中一個獎,再開始抽第二個(獎項多於人數時)。'
          : '規則:所有未達上限的人機率相同。'));
  }

  // 選牌:只更新選取狀態與舞台文字,不重繪整頁
  function selectPrize(id) {
    if (state.busy || state.auto || !canDraw() || randomPrize()) return;
    if (drawByPrize().has(id)) return;
    ui.prizeId = id;
    ui.last = null;
    scanTag(null);
    markSelected();
    const p = state.prizes.find((x) => x.id === id);
    const label = $('#stagePrize');
    if (label && p) label.textContent = p.name;
    setReel('？');
  }
  function markSelected() {
    doc.querySelectorAll('.pcard').forEach((c) => {
      const on = c.dataset.prize === ui.prizeId && !c.classList.contains('flipped');
      c.classList.toggle('selected', on);
      if (!c.classList.contains('flipped')) c.setAttribute('aria-pressed', String(on));
    });
  }

  // 控制按鈕狀態(viewDraw 初始渲染與抽獎過程中直接更新 DOM 共用)
  // 所有人都已達上限 → 抽獎結束(剩下的獎項不再抽)
  function drawFinished() {
    const dp = drawByPrize();
    const open = state.prizes.filter((p) => !dp.has(p.id));
    if (!open.length || !state.people.length) return false;
    const max = state.settings.max_per_person;
    const wins = winCounts();
    return state.people.every((p) => (wins.get(p.id) || 0) >= max);
  }
  const randomPrize = () => state.settings.random_prize !== false;
  const randInt = (n) => {
    const c = doc.defaultView?.crypto ?? globalThis.crypto;
    if (c?.getRandomValues) { const a = new Uint32Array(1); c.getRandomValues(a); return a[0] % n; }
    return Math.floor(Math.random() * n);
  };
  // 隨機挑一個還沒抽的獎
  function pickPrizeId() {
    const dp = drawByPrize();
    const pool = state.prizes.filter((p) => !dp.has(p.id));
    return pool.length ? pool[randInt(pool.length)].id : '';
  }
  function controlState() {
    const dp = drawByPrize();
    const left = state.prizes.filter((p) => !dp.has(p.id)).length;
    const ok = canDraw() && left > 0 && state.people.length > 0 && !drawFinished();
    return {
      drawDisabled: !ok || state.busy || state.auto,
      autoDisabled: state.auto ? state.stopAuto : !ok || state.busy,
      autoText: state.auto ? (state.stopAuto ? '暫停中…' : '⏸ 暫停') : `▶ 連續自動抽${left ? `(剩 ${left} 個)` : ''}`,
    };
  }
  function setControls() {
    const d = $('#drawBtn');
    const a = $('#autoBtn');
    if (!d || !a) return;
    const cs = controlState();
    d.disabled = cs.drawDisabled;
    a.disabled = cs.autoDisabled;
    a.textContent = cs.autoText;
  }

  // ---- 演出 ----
  function setReel(name) {
    const reel = $('#stageName');
    if (!reel) return;
    reel.replaceChildren(h('span', { class: 'reel-item' }, name));
  }
  // 滾輪換一格:舊名字往上滑出、新名字從下滑入
  function slideReel(name, ms) {
    const reel = $('#stageName');
    if (!reel) return;
    const prev = reel.lastElementChild;
    const next = h('span', { class: 'reel-item' }, name);
    reel.append(next);
    if (typeof next.animate === 'function') {
      const d = Math.max(30, Math.min(ms * 0.85, 150));
      prev?.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }], { duration: d, easing: 'ease-in', fill: 'forwards' });
      next.animate([{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: d, easing: 'ease-out' });
      setTimeout(() => prev?.remove(), d);
    } else {
      prev?.remove();
    }
  }
  function scanTag(personId) {
    doc.querySelectorAll('.ptag.scan, .ptag.last').forEach((t) => t.classList.remove('scan', 'last'));
    if (personId) doc.querySelector(`.ptag[data-person="${personId}"]`)?.classList.add('scan');
  }

  async function countdown() {
    const el = $('#countdown');
    if (!el) return;
    el.classList.add('on');
    for (const n of ['3', '2', '1']) {
      el.textContent = n;
      el.classList.remove('beat'); void el.offsetWidth; el.classList.add('beat');
      if (ui.fx.sound) fx.count();
      await sleep(700);
    }
    el.classList.remove('on', 'beat');
    el.textContent = '';
  }

  // 獎項牌牆掃描,越轉越慢,最後停在被抽到的獎項
  async function rollPrize(prizeId) {
    const label = $('#stagePrize');
    const cards = [...doc.querySelectorAll('.pcard:not(.flipped)')];
    const clear = () => cards.forEach((c) => c.classList.remove('scan'));
    const target = state.prizes.find((p) => p.id === prizeId);
    if (reducedMotion() || cards.length < 2) { if (label && target) label.textContent = target.name; return; }
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const c = cards[randInt(cards.length)];
      clear(); c.classList.add('scan');
      if (label) label.textContent = state.prizes.find((p) => p.id === c.dataset.prize)?.name ?? '';
      if (ui.fx.sound) fx.tick(i);
      await sleep(50 + i * i * 0.6);
    }
    clear();
    const hit = doc.querySelector(`.pcard[data-prize="${prizeId}"]`);
    hit?.classList.add('scan');
    if (label && target) label.textContent = target.name;
    await sleep(450);
    hit?.classList.remove('scan');
  }

  // 滾輪 + 名牌牆同步掃描,越轉越慢,最後停在得獎人
  async function roll(winner) {
    $('#stageName')?.classList.remove('won');
    const people = state.people;
    if (reducedMotion() || people.length < 2) { setReel(winner.person_name); return; }
    const steps = 30;
    for (let i = 0; i < steps; i++) {
      const p = people[Math.floor(Math.random() * people.length)];
      const ms = 45 + i * i * 0.35; // 越轉越慢
      slideReel(p.name, ms);
      scanTag(p.id);
      if (ui.fx.sound) fx.tick(i);
      await sleep(ms);
    }
    slideReel(winner.person_name, 300);
    await sleep(160);
    setReel(winner.person_name);
  }

  function revealCard(res, winnerName) {
    const card = doc.querySelector(`.pcard[data-prize="${res.prize_id}"]`);
    if (!card) return;
    card.querySelector('.pwinner').textContent = winnerName;
    card.setAttribute('aria-label', `${res.prize_name},得獎人:${winnerName}`);
    card.classList.remove('selected');
    card.classList.add('flipped');
  }

  // 抽一個獎:伺服器決定並寫入結果 → (倒數)→ 轉盤 → 揭曉。成功回傳 true。
  async function drawOne(prizeId, { hold = false, spinPrize = false } = {}) {
    if (!prizeId || state.busy) return false;
    state.busy = true;
    ui.prizeId = prizeId;
    ui.last = null;
    markSelected();
    setControls();
    let ok = false;
    try {
      if (ui.fx.sound) fx.tick(0); // 在使用者操作當下啟動音訊
      const res = await api.drawPrize(prizeId);
      state.revealing = true;
      $('#stagePrize').textContent = res.prize_name;
      setReel('？');
      const fancy = !reducedMotion();
      if (spinPrize) await rollPrize(prizeId);
      if (fancy && state.settings.fx_countdown !== false && !hold) await countdown();
      await roll(res);
      scanTag(res.person_id);
      ui.last = { prize: res.prize_name, prizeId: res.prize_id, personId: res.person_id, name: res.person_name };
      $('#stageName').classList.add('won');
      revealCard(res, res.person_name);
      if (fancy && state.settings.fx_confetti !== false) fx.confetti();
      if (ui.fx.sound) fx.win();
      toast(`🎉 ${res.prize_name} → ${res.person_name}`, 'ok');
      ok = true;
      if (hold) { if (!state.stopAuto) await sleep(HOLD_MS); } // 讓現場看清楚這個結果
      else if (!reducedMotion()) await sleep(FLIP_MS); // 讓翻牌動畫播完再重繪
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      state.busy = false;
      state.revealing = false;
      try { await refresh(); } catch (e) { toast(errorText(e), 'err'); }
      setControls();
    }
    return ok;
  }

  const onDraw = () => {
    if (!randomPrize()) return drawOne(ui.prizeId);
    const id = pickPrizeId();
    return id ? drawOne(id, { spinPrize: true }) : false;
  };

  // 連續自動抽:從目前選的獎項開始,依序抽完剩下的;再按一次「暫停」會在目前這個獎抽完後停止。
  async function onAuto() {
    if (state.auto) { state.stopAuto = true; setControls(); return; }
    if (state.busy || !canDraw()) return;
    const rnd = randomPrize();
    const open = state.prizes.filter((p) => !drawByPrize().has(p.id)).map((p) => p.id);
    const at = Math.max(0, open.indexOf(ui.prizeId));
    const queue = rnd ? [] : [...open.slice(at), ...open.slice(0, at)];
    state.auto = true;
    state.stopAuto = false;
    setControls();
    try {
      if (rnd) {
        while (!state.stopAuto && !drawFinished()) {
          const id = pickPrizeId();
          if (!id) break;
          if (!(await drawOne(id, { hold: true, spinPrize: true }))) break;
        }
      } else {
        for (const id of queue) {
          if (state.stopAuto) break;
          if (drawByPrize().has(id)) continue;
          if (!(await drawOne(id, { hold: true }))) break; // 失敗就停下來(錯誤訊息已顯示)
        }
      }
    } finally {
      state.auto = false;
      state.stopAuto = false;
      setControls();
    }
  }

  // ----- 結果頁 -----
  function viewResults() {
    const dp = drawByPrize();
    const pm = personById();
    const wins = winCounts();
    const corrected = new Set(state.audit.filter((a) => a.action === 'correct').map((a) => a.prize_id));

    const rows = state.prizes.map((p, i) => {
      const d = dp.get(p.id);
      const person = d && pm.get(d.person_id);
      return h('tr', null,
        h('td', { class: 'num' }, i + 1),
        h('td', null, p.name),
        h('td', { class: person ? 'winner' : 'muted' }, person ? personLabel(person) : '尚未抽出'),
        h('td', { class: 'muted' }, d ? fmtTime(d.drawn_at) : ''),
        h('td', null,
          d ? h('span', { class: 'chip locked' }, '已鎖定') : null,
          corrected.has(p.id) ? h('span', { class: 'chip fixed' }, '已更正') : null),
        isAdmin() ? h('td', { class: 'actions' }, d ? [
          h('button', { class: 'btn small', onclick: () => openCorrect(p, d) }, '更正'),
          h('button', { class: 'btn small danger', onclick: () => openVoid(p, d) }, '作廢'),
        ] : null) : null);
    });

    const multi = state.people.filter((p) => (wins.get(p.id) || 0) >= 2);
    const byPerson = [...wins.entries()]
      .map(([id, n]) => ({ person: pm.get(id), n, prizes: state.draws.filter((d) => d.person_id === id).map((d) => (state.prizes.find((p) => p.id === d.prize_id)?.name ?? '')) }))
      .filter((x) => x.person)
      .sort((a, b) => b.n - a.n || a.person.name.localeCompare(b.person.name, 'zh-Hant'));
    const none = state.people.length - wins.size;

    return h('section', { class: 'panel' },
      h('div', { class: 'row between' },
        h('h2', null, '抽獎結果'),
        h('button', { class: 'btn small', onclick: exportCsv, disabled: !state.draws.length }, '匯出 CSV')),
      state.prizes.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, '獎項'), h('th', null, '得獎人'), h('th', null, '時間'), h('th', null, '狀態'), isAdmin() ? h('th', null, '') : null)),
        h('tbody', null, rows))) : h('p', { class: 'muted' }, '還沒有獎項。'),
      h('h3', null, '得獎人彙整'),
      h('p', { class: 'muted small' }, `共 ${wins.size} 人得獎(其中 ${multi.length} 人得 2 個以上),${none} 人未得獎。`),
      byPerson.length ? h('ul', { class: 'plain' }, byPerson.map((x) =>
        h('li', null, h('b', null, personLabel(x.person)), ` × ${x.n}:`, x.prizes.join('、')))) : null);
  }

  function exportCsv() {
    const dp = drawByPrize();
    const pm = personById();
    const rows = [['序號', '獎項', '得獎人', '備註', '抽出時間']];
    state.prizes.forEach((p, i) => {
      const d = dp.get(p.id);
      const person = d && pm.get(d.person_id);
      rows.push([i + 1, p.name, person?.name ?? '', person?.note ?? '', d ? new Date(d.drawn_at).toLocaleString('zh-TW', { hour12: false }) : '']);
    });
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `抽獎結果_${new Date().toISOString().slice(0, 10)}.csv` });
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ----- 管理頁 -----
  function viewAdmin() {
    const hasDraws = state.draws.length > 0;

    const importBox = (title, hint, key, onImport) => {
      const ta = h('textarea', { rows: 6, placeholder: hint, 'aria-label': title,
        oninput: (e) => { ui[key] = e.target.value; refreshPreview(); } }, '');
      ta.value = ui[key];
      const preview = h('div', { class: 'muted small' });
      const importBtn = h('button', { class: 'btn', onclick: onImport }, '匯入');
      const fileIn = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', 'aria-label': `${title}檔案`,
        onchange: async (e) => {
          const f = e.target.files[0];
          if (!f) return;
          ta.value = ui[key] = await f.text();
          refreshPreview();
          e.target.value = '';
        } });
      function refreshPreview() {
        const p = key === 'prizeText' ? parsePrizes(ui[key]) : parsePeople(ui[key]);
        const n = key === 'prizeText' ? p.prizes.length : p.people.length;
        const extra = [];
        if (p.skipped) extra.push(`略過 ${p.skipped} 筆完全重複`);
        if (p.errors.length) extra.push(`${p.errors.length} 行有問題:${p.errors.slice(0, 3).map((x) => `第${x.line}行 ${x.msg}`).join(';')}`);
        preview.textContent = n || extra.length ? `可匯入 ${n} 筆${extra.length ? '。' + extra.join('。') : ''}` : '';
        importBtn.disabled = !n;
        importBtn.textContent = n ? `匯入 ${n} 筆` : '匯入';
      }
      refreshPreview();
      return h('div', { class: 'card' }, h('h3', null, title), ta,
        h('div', { class: 'row' }, fileIn, importBtn), preview);
    };

    const curMax = state.settings.max_per_person;
    const modeIn = h('select', { id: 'modeIn', 'aria-label': '抽獎模式' },
      h('option', { value: 'once' }, '一人一獎:每人只抽一次,人數抽完就結束'),
      h('option', { value: 'fair' }, '先每人一個,再抽第二個(獎項多於人數時)'),
      h('option', { value: 'random' }, '完全隨機:未達上限的人機率相同'));
    modeIn.value = curMax === 1 ? 'once' : state.settings.prefer_unwon ? 'fair' : 'random';
    const maxIn = h('input', { type: 'number', min: 1, max: 99, value: curMax === 1 ? 2 : curMax, id: 'maxIn', 'aria-label': '每人得獎上限' });
    const maxLabel = h('label', null, '每人最多可得 ', maxIn, ' 個獎');
    const syncMode = () => { maxLabel.hidden = modeIn.value === 'once'; };
    modeIn.addEventListener('change', syncMode); syncMode();
    const randIn = h('input', { type: 'checkbox', id: 'randIn' });
    randIn.checked = state.settings.random_prize !== false;
    const cdIn = h('input', { type: 'checkbox', id: 'cdIn' });
    cdIn.checked = state.settings.fx_countdown !== false;
    const confIn = h('input', { type: 'checkbox', id: 'confIn' });
    confIn.checked = state.settings.fx_confetti !== false;

    return h('section', { class: 'panel' },
      h('h2', null, '管理'),
      h('div', { class: 'grid2' },
        importBox('匯入獎項', '每行一個獎項,可加數量:\n雙人住宿券,5\n四人房住宿券 x2\n(CSV/TXT 皆可)', 'prizeText', onImportPrizes),
        importBox('匯入抽獎名單', '每行一人,可加備註(部門/編號):\n王小明\n李小華,行銷部', 'peopleText', onImportPeople)),

      h('div', { class: 'card' }, h('h3', null, '抽獎設定'),
        h('div', { class: 'row' }, h('label', null, '抽獎模式 ', modeIn), maxLabel),
        h('div', { class: 'row' },
          h('label', { class: 'check' }, randIn, '獎項也隨機抽出'),
          h('label', { class: 'check' }, cdIn, '倒數 3-2-1'),
          h('label', { class: 'check' }, confIn, '彩帶'),
          h('span', { class: 'muted small' }, '所有人的畫面都適用;連續自動抽不倒數。')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: async () => {
            const mode = modeIn.value;
            const n = mode === 'once' ? 1 : Number(maxIn.value);
            if (!Number.isInteger(n) || n < 1) return toast('上限需為 1 以上的整數', 'err');
            await run(() => api.updateSettings({ max_per_person: n, prefer_unwon: mode !== 'random', fx_countdown: cdIn.checked, fx_confetti: confIn.checked, random_prize: randIn.checked }), '設定已儲存');
          } }, '儲存設定'),
          hasDraws ? h('span', { class: 'muted small' }, '已有抽獎結果;調低上限不會影響已抽出的結果。') : null)),

      h('div', { class: 'grid2' },
        listCard('獎項清單', state.prizes, (p) => p.name, (p) => api.deletePrize(p.id), () => api.clearPrizes(), hasDraws),
        listCard('抽獎名單', state.people, personLabel, (p) => api.deletePerson(p.id), () => api.clearPeople(), hasDraws)),

      h('div', { class: 'card' }, h('h3', null, '更正紀錄'),
        state.audit.length ? h('ul', { class: 'plain audit' }, state.audit.map(auditLine))
          : h('p', { class: 'muted' }, '沒有更正紀錄。')),

      h('div', { class: 'card danger-zone' }, h('h3', null, '危險區'),
        h('p', { class: 'muted small' }, '清空所有抽獎結果(獎項與名單保留),可用於正式抽獎前的彩排重置。操作會留下紀錄。'),
        h('button', { class: 'btn danger', disabled: !hasDraws, onclick: openReset }, '清空全部抽獎結果')));
  }

  function auditLine(a) {
    const what = a.action === 'correct' ? `更正「${a.prize_name}」:${a.old_person_name} → ${a.new_person_name}`
      : a.action === 'void' ? `作廢「${a.prize_name}」(原得獎人:${a.old_person_name})`
        : `清空全部結果(${a.prize_name})`;
    return h('li', null, h('b', null, what), h('div', { class: 'muted small' },
      `${fmtTime(a.at)} · ${a.actor_email || 'admin'} · 原因:${a.reason}`));
  }

  function listCard(title, items, label, onDelete, onClear, locked) {
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', null, `${title}(${items.length})`),
        h('button', { class: 'btn small danger', disabled: !items.length || locked,
          title: locked ? '已有抽獎結果,請先清空結果' : null,
          onclick: async () => { if (await confirmBox(`確定清空整份「${title}」?`)) await run(onClear, '已清空'); } }, '清空')),
      items.length ? h('ul', { class: 'plain scroll' }, items.map((it) =>
        h('li', { class: 'row between' }, h('span', null, label(it)),
          h('button', { class: 'btn tiny', 'aria-label': `刪除 ${label(it)}`, onclick: () => run(() => onDelete(it), '已刪除') }, '✕'))))
        : h('p', { class: 'muted' }, '空的'));
  }

  async function run(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg, 'ok');
      await refresh();
    } catch (e) {
      toast(errorText(e), 'err');
    }
  }

  async function onImportPrizes() {
    const { prizes } = parsePrizes(ui.prizeText);
    if (!prizes.length) return;
    const start = state.prizes.reduce((m, p) => Math.max(m, p.sort_order), -1) + 1;
    await run(() => api.importPrizes(prizes, start), `已匯入 ${prizes.length} 個獎項`);
    ui.prizeText = '';
    render();
  }
  async function onImportPeople() {
    const { people } = parsePeople(ui.peopleText);
    if (!people.length) return;
    await run(() => api.importPeople(people), `已匯入 ${people.length} 位抽獎人`);
    ui.peopleText = '';
    render();
  }

  // ---------- 對話框 ----------
  function showDialog(title, body, actions) {
    const dlg = $('#dlg');
    const close = () => {
      if (typeof dlg.close === 'function') { if (dlg.open) dlg.close(); } else dlg.removeAttribute('open');
    };
    dlg.replaceChildren(h('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() },
      h('h3', null, title), body, h('div', { class: 'row end' }, actions(close))));
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    return close;
  }

  function confirmBox(message) {
    return new Promise((resolve) => {
      showDialog('請確認', h('p', null, message), (close) => [
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); resolve(false); } }, '取消'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => { close(); resolve(true); } }, '確定'),
      ]);
    });
  }

  function openLogin() {
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'Email' });
    const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: '密碼' });
    showDialog('工作人員登入', h('div', { class: 'stack' }, email, pw), (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
      h('button', { class: 'btn primary', type: 'submit', onclick: async (e) => {
        e.preventDefault();
        try { await api.signIn(email.value.trim(), pw.value); close(); } catch (err) { toast(errorText(err), 'err'); }
      } }, '登入'),
    ]);
    email.focus();
  }

  function openCorrect(prize, draw) {
    const pm = personById();
    const wins = winCounts();
    const max = state.settings.max_per_person;
    const cur = pm.get(draw.person_id);
    const sel = h('select', null, state.people.filter((p) => p.id !== draw.person_id).map((p) => {
      const n = wins.get(p.id) || 0;
      return h('option', { value: p.id }, `${personLabel(p)}(已得 ${n} 個${n >= max ? ',已達上限' : ''})`);
    }));
    const reason = h('textarea', { rows: 3, placeholder: '更正原因(必填,會留下紀錄)', 'aria-label': '更正原因' });
    const force = h('input', { type: 'checkbox' });
    showDialog(`更正「${prize.name}」得獎人`, h('div', { class: 'stack' },
      h('p', null, '目前得獎人:', h('b', null, cur ? personLabel(cur) : '?')),
      sel, reason, h('label', { class: 'check' }, force, '允許超過每人上限')),
    (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (!sel.value) return toast('沒有可選的人', 'err');
        if (!reason.value.trim()) return toast('請填寫更正原因', 'err');
        close();
        await run(() => api.correctDraw(prize.id, sel.value, reason.value.trim(), force.checked), '已更正');
      } }, '確認更正'),
    ]);
  }

  function openVoid(prize, draw) {
    const cur = personById().get(draw.person_id);
    const reason = h('textarea', { rows: 3, placeholder: '作廢原因(必填,會留下紀錄)', 'aria-label': '作廢原因' });
    showDialog(`作廢「${prize.name}」`, h('div', { class: 'stack' },
      h('p', null, `原得獎人 ${cur ? personLabel(cur) : '?'} 的結果會被作廢,該獎項回到待抽狀態。`), reason),
    (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!reason.value.trim()) return toast('請填寫作廢原因', 'err');
        close();
        await run(() => api.voidDraw(prize.id, reason.value.trim()), '已作廢,可重新抽獎');
      } }, '確認作廢'),
    ]);
  }

  function openReset() {
    const reason = h('textarea', { rows: 2, placeholder: '原因(必填,例如:正式抽獎前彩排重置)', 'aria-label': '重置原因' });
    showDialog('清空全部抽獎結果', h('div', { class: 'stack' },
      h('p', null, `將刪除目前 ${state.draws.length} 筆結果,無法復原(僅留下操作紀錄)。`), reason),
    (close) => [
      h('button', { class: 'btn', type: 'button', onclick: close }, '取消'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!reason.value.trim()) return toast('請填寫原因', 'err');
        close();
        await run(() => api.resetDraws(reason.value.trim()), '已清空');
      } }, '確認清空'),
    ]);
  }

  // ---------- 啟動 ----------
  doc.addEventListener('focusout', () => {
    setTimeout(() => { if (state.pending && !state.revealing && !isTyping()) render(); }, 50);
  });

  async function start() {
    if (!api.configured) {
      const b = $('#banner');
      b.hidden = false;
      b.className = 'banner';
      b.replaceChildren('尚未設定 Supabase。請編輯 config.js 填入 SUPABASE_URL 與 SUPABASE_ANON_KEY(詳見 README)。');
      renderAuth(); renderTabs();
      return;
    }
    try {
      await refreshAuth();
      await refresh();
    } catch (e) {
      const b = $('#banner');
      b.hidden = false;
      b.className = 'banner';
      b.textContent = `無法連線到資料庫:${errorText(e)}(是否已執行 supabase/schema.sql?)`;
      return;
    }
    api.onAuth(async (user) => {
      state.user = user;
      try { state.role = user ? await api.role() : null; await refresh(); } catch (e) { toast(errorText(e), 'err'); }
    });
    let t;
    api.subscribe(() => { clearTimeout(t); t = setTimeout(() => refresh().catch(() => {}), 300); });
  }

  return start();
}
