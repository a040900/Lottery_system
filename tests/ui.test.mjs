// 用 jsdom + 假的 api 走一遍主要操作流程(不連 Supabase)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { init, errorText } from '../app.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
let uid = 0;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeApi(role) {
  const db = { prizes: [], people: [], draws: [], audit: [], settings: { max_per_person: 2, prefer_unwon: true, random_prize: false } };
  let listeners = [];
  const api = {
    configured: true,
    db,
    user: async () => (role ? { email: `${role}@x.com` } : null),
    role: async () => role,
    onAuth() {},
    subscribe(cb) { listeners.push(cb); return () => {}; },
    signIn: async () => {}, signOut: async () => {},
    loadAll: async () => structuredClone(db),
    async importPrizes(list, start) { list.forEach((p, i) => db.prizes.push({ id: `pz${++uid}`, name: p.name, sort_order: start + i })); },
    async importPeople(list) { list.forEach((p) => db.people.push({ id: `pe${++uid}`, name: p.name, note: p.note })); },
    async updateSettings(s) { Object.assign(db.settings, s); },
    async drawPrize(pid) {
      if (db.draws.some((d) => d.prize_id === pid)) throw new Error('ALREADY_DRAWN');
      const cnt = (id) => db.draws.filter((d) => d.person_id === id).length;
      const elig = db.people.filter((p) => cnt(p.id) < db.settings.max_per_person);
      if (!elig.length) throw new Error('NO_ELIGIBLE');
      const min = Math.min(...elig.map((p) => cnt(p.id)));
      const person = elig.filter((p) => cnt(p.id) === min)[0];
      db.draws.push({ id: `d${++uid}`, prize_id: pid, person_id: person.id, drawn_at: new Date().toISOString() });
      return { prize_id: pid, prize_name: db.prizes.find((p) => p.id === pid).name, person_id: person.id, person_name: person.name };
    },
    async correctDraw(pid, personId, reason) {
      if (!reason) throw new Error('REASON_REQUIRED');
      const d = db.draws.find((x) => x.prize_id === pid);
      const prize = db.prizes.find((p) => p.id === pid);
      db.audit.unshift({ id: ++uid, action: 'correct', prize_id: pid, prize_name: prize.name,
        old_person_name: db.people.find((p) => p.id === d.person_id).name,
        new_person_name: db.people.find((p) => p.id === personId).name, reason, at: new Date().toISOString(), actor_email: 'admin@x.com' });
      d.person_id = personId;
    },
    async voidDraw(pid) { db.draws = db.draws.filter((d) => d.prize_id !== pid); },
    async resetDraws() { db.draws = []; },
    async deletePrize(id) { db.prizes = db.prizes.filter((p) => p.id !== id); },
    async deletePerson(id) { db.people = db.people.filter((p) => p.id !== id); },
    async clearPrizes() { db.prizes = []; }, async clearPeople() { db.people = []; },
  };
  return api;
}

function boot(role, opts = { flipMs: 0 }) {
  const dom = new JSDOM(html, { pretendToBeVisual: true });
  globalThis.matchMedia = () => ({ matches: true }); // 略過轉動動畫
  const doc = dom.window.document;
  const api = fakeApi(role);
  return { dom, doc, api, ready: init(api, doc, opts) };
}
const click = (doc, text, root = doc) => {
  const el = [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text || b.textContent.includes(text));
  assert.ok(el, `找不到按鈕:${text}`);
  assert.ok(!el.disabled, `按鈕被停用:${text}`);
  el.click();
  return el;
};
const setText = (el, v) => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); };

test('admin:匯入 → 抽獎(一人可中 2 個)→ 結果鎖定 → 更正與稽核', async () => {
  const { doc, api, ready } = boot('admin');
  await ready; await tick();
  assert.ok([...doc.querySelectorAll('.tab')].some((t) => t.textContent === '管理'));

  click(doc, '管理'); await tick();
  const [prizeTa, peopleTa] = doc.querySelectorAll('textarea');
  setText(prizeTa, '雙人住宿券,3\n四人房 x1');
  setText(peopleTa, '王小明\n李小華');
  const importBtns = [...doc.querySelectorAll('button')].filter((b) => /^匯入 \d+ 筆$/.test(b.textContent));
  assert.equal(importBtns.length, 2);
  assert.match(importBtns[0].textContent, /4 筆/);
  importBtns[0].click(); await tick();
  setText(doc.querySelectorAll('textarea')[1], '王小明\n李小華');
  [...doc.querySelectorAll('button')].find((b) => /^匯入 2 筆$/.test(b.textContent)).click(); await tick();
  assert.equal(api.db.prizes.length, 4);
  assert.equal(api.db.people.length, 2);

  click(doc, '抽獎'); await tick();
  assert.match(doc.querySelector('.panel').textContent, /剩 4 \/ 4/);
  for (let i = 0; i < 4; i++) { click(doc, '開始抽獎'); await tick(60); }
  assert.equal(api.db.draws.length, 4);
  const per = {};
  api.db.draws.forEach((d) => { per[d.person_id] = (per[d.person_id] || 0) + 1; });
  assert.deepEqual(Object.values(per).sort(), [2, 2]); // 每人 2 個
  assert.ok(doc.querySelector('#drawBtn').disabled); // 抽完

  click(doc, '結果'); await tick();
  assert.equal(doc.querySelectorAll('tbody tr').length, 4);
  assert.equal(doc.querySelectorAll('.chip.locked').length, 4);
  assert.match(doc.querySelector('.panel').textContent, /2 人得 2 個以上/);

  click(doc, '更正'); await tick();
  const dlg = doc.querySelector('#dlg');
  assert.ok(dlg.hasAttribute('open'));
  click(doc, '確認更正', dlg); // 未填原因 → 被擋
  await tick();
  assert.equal(api.db.audit.length, 0);
  setText(dlg.querySelector('textarea'), '名單抄錯');
  dlg.querySelector('input[type=checkbox]').checked = true;
  dlg.querySelector('input[type=checkbox]').dispatchEvent(new doc.defaultView.Event('change'));
  click(doc, '確認更正', dlg); await tick(60);
  assert.equal(api.db.audit.length, 1);
  assert.ok(doc.querySelector('.chip.fixed'));
});

test('觀眾:看得到結果、不能抽獎、沒有管理分頁', async () => {
  const { doc, api, ready } = boot(null);
  api.db.prizes.push({ id: 'p1', name: '雙人券', sort_order: 0 });
  api.db.people.push({ id: 'a', name: '王小明', note: null });
  await ready; await tick();
  assert.ok(doc.querySelector('#drawBtn').disabled);
  assert.ok(![...doc.querySelectorAll('.tab')].some((t) => t.textContent === '管理'));
  assert.match(doc.querySelector('#auth').textContent, /觀眾模式/);
  assert.match(doc.querySelector('.panel').textContent, /觀眾身分/);
});

test('operator 可抽獎但看不到管理與更正', async () => {
  const { doc, api, ready } = boot('operator');
  api.db.prizes.push({ id: 'p1', name: '雙人券', sort_order: 0 });
  api.db.people.push({ id: 'a', name: '王小明', note: null });
  await ready; await tick();
  assert.ok(![...doc.querySelectorAll('.tab')].some((t) => t.textContent === '管理'));
  click(doc, '開始抽獎'); await tick(60);
  assert.equal(api.db.draws.length, 1);
  click(doc, '結果'); await tick();
  assert.ok(![...doc.querySelectorAll('button')].some((b) => b.textContent === '更正'));
});

test('名額不足時顯示警告;匿名資料以文字呈現不執行 HTML', async () => {
  const { doc, api, ready } = boot('admin');
  api.db.prizes.push(...[1, 2, 3].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '<img src=x onerror=alert(1)>', note: null });
  api.db.settings.max_per_person = 1;
  await ready; await tick();
  assert.equal(doc.querySelector('.warn'), null); // 不再顯示「抽不完」提示
  assert.equal(doc.querySelector('img'), null);
});

test('errorText 對應錯誤碼', () => {
  assert.match(errorText(new Error('NO_ELIGIBLE')), /沒有符合資格/);
  assert.match(errorText({ message: 'update or delete violates foreign key constraint' }), /無法刪除/);
});

test('連續自動抽:按一次依序抽完所有剩餘獎項,結束後按鈕復原', async () => {
  const { doc, api, ready } = boot('admin', { holdMs: 5, flipMs: 0 });
  api.db.prizes.push(...[1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null }, { id: 'b', name: '李小華', note: null });
  await ready; await tick();
  assert.match(doc.querySelector('#autoBtn').textContent, /剩 4 個/);
  click(doc, '連續自動抽');
  assert.equal(doc.querySelector('#autoBtn').textContent, '⏸ 暫停');
  assert.ok(doc.querySelector('#drawBtn').disabled); // 自動抽期間不能手動抽
  for (let i = 0; i < 40 && api.db.draws.length < 4; i++) await tick(20);
  await tick(60);
  assert.equal(api.db.draws.length, 4);
  assert.deepEqual(api.db.draws.map((d) => d.prize_id), ['p1', 'p2', 'p3', 'p4']); // 依序
  assert.ok(doc.querySelector('#drawBtn').disabled); // 已全部抽完
  assert.ok(doc.querySelector('#autoBtn').disabled);
});

test('連續自動抽:從選定的獎項開始;按暫停會在目前這個獎抽完後停止', async () => {
  const { doc, api, ready } = boot('admin', { holdMs: 150, flipMs: 0 });
  api.db.prizes.push(...[1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null }, { id: 'b', name: '李小華', note: null });
  await ready; await tick();
  doc.querySelector('.pcard[data-prize="p3"]').click();
  click(doc, '連續自動抽');
  await tick(40); // 第一個獎(p3)已抽出,正在停留
  assert.deepEqual(api.db.draws.map((d) => d.prize_id), ['p3']);
  click(doc, '暫停');
  assert.equal(doc.querySelector('#autoBtn').textContent, '暫停中…');
  await tick(400);
  assert.deepEqual(api.db.draws.map((d) => d.prize_id), ['p3']); // 沒有繼續抽
  assert.match(doc.querySelector('#autoBtn').textContent, /連續自動抽/);
  assert.ok(!doc.querySelector('#autoBtn').disabled);
  assert.ok(!doc.querySelector('#drawBtn').disabled); // 可以手動接著抽
});

test('連續自動抽:出錯就停下來;觀眾沒有權限', async () => {
  const { doc, api, ready } = boot('admin', { holdMs: 5, flipMs: 0 });
  api.db.prizes.push(...[1, 2, 3].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null });
  api.db.settings.max_per_person = 1; // 只夠抽 1 個
  await ready; await tick();
  click(doc, '連續自動抽');
  await tick(150);
  assert.equal(api.db.draws.length, 1);
  assert.match(doc.querySelector('#toast').textContent, /沒有符合資格/);
  assert.match(doc.querySelector('#autoBtn').textContent, /連續自動抽/);

  const v = boot(null);
  v.api.db.prizes.push({ id: 'p1', name: '獎1', sort_order: 0 });
  v.api.db.people.push({ id: 'a', name: '王小明', note: null });
  await v.ready; await tick();
  assert.ok(v.doc.querySelector('#autoBtn').disabled);
});

test('獎項卡牌牆與名牌牆:點選、抽出後翻面顯示得獎人、名牌顯示得獎數', async () => {
  const { doc, api, ready } = boot('admin');
  api.db.prizes.push(...[1, 2, 3].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null }, { id: 'b', name: '李小華', note: null });
  await ready; await tick();
  assert.equal(doc.querySelectorAll('.pcard').length, 3);
  assert.equal(doc.querySelectorAll('.ptag').length, 2);
  assert.equal(doc.querySelector('.pcard.selected').dataset.prize, 'p1'); // 預設選第一個

  doc.querySelector('.pcard[data-prize="p2"]').click();
  assert.equal(doc.querySelector('.pcard.selected').dataset.prize, 'p2');
  assert.equal(doc.querySelector('#stagePrize').textContent, '獎2');
  assert.equal(doc.querySelector('#stageName').textContent, '？');

  click(doc, '開始抽獎'); await tick(60);
  assert.equal(api.db.draws[0].prize_id, 'p2');
  const flipped = doc.querySelectorAll('.pcard.flipped');
  assert.equal(flipped.length, 1);
  assert.equal(flipped[0].dataset.prize, 'p2');
  assert.match(flipped[0].querySelector('.pwinner').textContent, /王小明|李小華/);
  assert.equal(doc.querySelector('.pcard.selected').dataset.prize, 'p3'); // 自動接到下一個還沒抽的獎
  assert.ok(doc.querySelector('.ptag.has .pips').textContent.includes('●○')); // 已得 1 個、上限 2

  doc.querySelector('.pcard[data-prize="p2"]').click(); // 已抽出的牌不能再選
  assert.equal(doc.querySelector('.pcard.selected').dataset.prize, 'p3');
});

test('觀眾不能選牌;音效開關存在', async () => {
  const { doc, api, ready } = boot(null);
  api.db.prizes.push({ id: 'p1', name: '獎1', sort_order: 0 });
  api.db.people.push({ id: 'a', name: '王小明', note: null });
  await ready; await tick();
  assert.ok(doc.querySelector('.pcard').disabled);
  assert.equal(doc.querySelectorAll('.fx-row input[type=checkbox]').length, 1);
});

test('抽完後最後得獎人的名牌保持亮起,選別的牌後取消', async () => {
  const { doc, api, ready } = boot('admin');
  api.db.prizes.push(...[1, 2].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null }, { id: 'b', name: '李小華', note: null });
  await ready; await tick();
  click(doc, '開始抽獎'); await tick(60);
  const last = doc.querySelector('.ptag.last');
  assert.ok(last);
  assert.equal(last.querySelector('.ptag-name').textContent, doc.querySelector('#stageName').textContent);
  doc.querySelector('.pcard[data-prize="p2"]').click();
  assert.equal(doc.querySelector('.ptag.last'), null);
});

test('一人一獎:人數抽完就結束;設定頁的模式選單會存成上限 1', async () => {
  const { doc, api, ready } = boot('admin', { holdMs: 5, flipMs: 0 });
  api.db.prizes.push(...[1, 2, 3].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '王小明', note: null }, { id: 'b', name: '李小華', note: null });
  api.db.settings.max_per_person = 1;
  await ready; await tick();
  assert.ok(!doc.querySelector('#drawBtn').disabled);
  click(doc, '連續自動抽');
  await tick(300);
  assert.equal(api.db.draws.length, 2); // 兩個人各中一個就停
  assert.match(doc.querySelector('.note').textContent, /抽獎結束/);
  assert.ok(doc.querySelector('#drawBtn').disabled);
  assert.ok(doc.querySelector('#autoBtn').disabled);

  click(doc, '管理'); await tick();
  const mode = doc.querySelector('#modeIn');
  assert.equal(mode.value, 'once');
  mode.value = 'fair'; mode.dispatchEvent(new doc.defaultView.Event('change'));
  doc.querySelector('#maxIn').value = '2';
  click(doc, '儲存設定'); await tick();
  assert.equal(api.db.settings.max_per_person, 2);
  assert.equal(api.db.settings.prefer_unwon, true);
});

test('倒數與彩帶由 admin 在設定頁控制', async () => {
  const { doc, api, ready } = boot('admin');
  api.db.prizes.push({ id: 'p1', name: '獎1', sort_order: 1 });
  api.db.people.push({ id: 'a', name: '王小明', note: null });
  await ready; await tick();
  click(doc, '管理'); await tick();
  assert.ok(doc.querySelector('#cdIn').checked && doc.querySelector('#confIn').checked);
  doc.querySelector('#cdIn').checked = false;
  click(doc, '儲存設定'); await tick();
  assert.equal(api.db.settings.fx_countdown, false);
  assert.equal(api.db.settings.fx_confetti, true);
});

test('獎項隨機:按抽獎自動挑獎項、不能手動選牌;人數抽完就結束;admin 可關閉', async () => {
  const { doc, api, ready } = boot('admin', { holdMs: 5, flipMs: 0 });
  api.db.settings.random_prize = true;
  api.db.settings.max_per_person = 1;
  api.db.prizes.push(...[1, 2, 3, 4].map((i) => ({ id: `p${i}`, name: `獎${i}`, sort_order: i })));
  api.db.people.push({ id: 'a', name: '甲', note: null }, { id: 'b', name: '乙', note: null });
  await ready; await tick();
  assert.equal(doc.querySelector('.pcard.selected'), null);
  doc.querySelector('.pcard[data-prize="p2"]').click(); // 隨機模式下點牌沒有作用
  assert.equal(doc.querySelector('.pcard.selected'), null);

  click(doc, '連續自動抽'); // 兩人各 1 個名額 → 只會抽出 2 個獎
  await tick(300);
  assert.equal(api.db.draws.length, 2);
  assert.match(doc.querySelector('.note').textContent, /抽獎結束/);

  click(doc, '管理'); await tick();
  doc.querySelector('#randIn').checked = false;
  click(doc, '儲存設定'); await tick();
  assert.equal(api.db.settings.random_prize, false);
});
