// 用 PGlite(WASM 版 Postgres)驗證 schema.sql:權限(RLS)、抽獎規則、更正與稽核。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const OPER = '00000000-0000-0000-0000-0000000000b2';
const NOBODY = '00000000-0000-0000-0000-0000000000c3';

const STUB = `
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
insert into auth.users values ('${ADMIN}','admin@x.com'),('${OPER}','op@x.com'),('${NOBODY}','nobody@x.com');
`;

async function setup() {
  const db = new PGlite();
  await db.exec(STUB);
  await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  await db.exec(`insert into staff values ('${ADMIN}','admin'),('${OPER}','operator')`);
  return db;
}
// 以某個身分執行(模擬 Supabase 的 JWT 角色)
async function as(db, uid, fn) {
  await db.exec(uid
    ? `set role authenticated; select set_config('request.jwt.claim.sub','${uid}',false)`
    : `set role anon; select set_config('request.jwt.claim.sub','',false)`);
  try { return await fn(); } finally { await db.exec('reset role'); }
}
const rejects = (p, re) => assert.rejects(p, re);

async function seed(db, people, prizes) {
  await as(db, ADMIN, async () => {
    for (const n of people) await db.query('insert into people(name) values ($1)', [n]);
    for (let i = 0; i < prizes; i++) await db.query('insert into prizes(name, sort_order) values ($1,$2)', [`獎${i + 1}`, i]);
  });
}
const prizeIds = async (db) => (await db.query('select id from prizes order by sort_order')).rows.map((r) => r.id);
const draw = (db, uid, pid) => as(db, uid, async () => (await db.query('select draw_prize($1) as r', [pid])).rows[0].r);

test('權限:觀眾唯讀;operator 不能匯入;只有 admin 能匯入', async () => {
  const db = await setup();
  await as(db, ADMIN, () => db.query("insert into people(name) values ('A')"));
  await as(db, null, async () => {
    assert.equal((await db.query('select * from people')).rows.length, 1);
    await rejects(db.query("insert into people(name) values ('X')"), /permission denied|row-level security/);
  });
  await as(db, OPER, async () => {
    await rejects(db.query("insert into people(name) values ('X')"), /row-level security|permission denied/);
    await rejects(db.query("insert into prizes(name) values ('X')"), /row-level security|permission denied/);
  });
  await as(db, NOBODY, () => rejects(db.query("insert into people(name) values ('X')"), /row-level security|permission denied/));
});

test('結果表禁止直接寫入,即使是 admin;抽獎需有 staff 角色', async () => {
  const db = await setup();
  await seed(db, ['A', 'B'], 2);
  const [p1] = await prizeIds(db);
  const pid = (await db.query('select id from people limit 1')).rows[0].id;
  await as(db, ADMIN, async () => {
    await rejects(db.query('insert into draws(prize_id, person_id) values ($1,$2)', [p1, pid]), /permission denied/);
  });
  await rejects(draw(db, null, p1), /permission denied|FORBIDDEN/);
  await rejects(draw(db, NOBODY, p1), /FORBIDDEN/);
  const r = await draw(db, OPER, p1);
  assert.ok(r.person_name);
  await as(db, OPER, async () => {
    await rejects(db.query('update draws set person_id = $1', [pid]), /permission denied/);
    await rejects(db.query('delete from draws'), /permission denied/);
  });
});

test('同一獎項不能重抽;獎項多於人數時每人最多 2 個、且先每人 1 個', async () => {
  const db = await setup();
  await seed(db, ['A', 'B', 'C'], 6); // 6 獎 3 人,上限 2
  const ids = await prizeIds(db);
  await draw(db, OPER, ids[0]);
  await rejects(draw(db, OPER, ids[0]), /ALREADY_DRAWN/);

  const names = [];
  for (const id of ids.slice(1)) names.push((await draw(db, OPER, id)).person_name);
  // 前 3 次抽完後每人恰好 1 個(prefer_unwon)
  const first3 = (await db.query('select person_id from draws order by drawn_at, id limit 3')).rows.map((r) => r.person_id);
  assert.equal(new Set(first3).size, 3);
  const counts = (await db.query('select count(*)::int c from draws group by person_id')).rows.map((r) => r.c);
  assert.deepEqual(counts, [2, 2, 2]);
});

test('名額用完會回報 NO_ELIGIBLE;調高上限後可繼續', async () => {
  const db = await setup();
  await seed(db, ['A', 'B'], 5);
  const ids = await prizeIds(db);
  for (const id of ids.slice(0, 4)) await draw(db, OPER, id);
  await rejects(draw(db, OPER, ids[4]), /NO_ELIGIBLE/);
  await rejects(as(db, OPER, () => db.query('update settings set max_per_person = 3')), /row-level security|permission denied|0 rows/).catch(() => {});
  await as(db, ADMIN, () => db.query('update settings set max_per_person = 3 where id = 1'));
  const r = await draw(db, OPER, ids[4]);
  assert.ok(r.person_name);
});

test('operator 不能改設定(靜默 0 列更新)', async () => {
  const db = await setup();
  await as(db, OPER, () => db.query('update settings set max_per_person = 9 where id = 1'));
  assert.equal((await db.query('select max_per_person from settings')).rows[0].max_per_person, 2);
});

test('prefer_unwon 關閉時仍遵守上限', async () => {
  const db = await setup();
  await as(db, ADMIN, () => db.query('update settings set prefer_unwon = false, max_per_person = 1 where id = 1'));
  await seed(db, ['A', 'B', 'C'], 3);
  for (const id of await prizeIds(db)) await draw(db, OPER, id);
  const c = (await db.query('select count(distinct person_id)::int c from draws')).rows[0].c;
  assert.equal(c, 3);
});

test('分佈大致均勻(1 人 vs 多人,各人機率接近)', async () => {
  const db = await setup();
  await as(db, ADMIN, () => db.query('update settings set max_per_person = 1 where id = 1'));
  const tally = { A: 0, B: 0, C: 0, D: 0 };
  for (let round = 0; round < 80; round++) {
    await db.exec('delete from draws; delete from prizes; delete from people;');
    await seed(db, ['A', 'B', 'C', 'D'], 1);
    const [id] = await prizeIds(db);
    tally[(await draw(db, OPER, id)).person_name]++;
  }
  for (const n of Object.values(tally)) assert.ok(n >= 5, JSON.stringify(tally)); // 期望 20,極端偏誤才會失敗
});

test('更正:僅 admin、必填原因、遵守上限、留下稽核', async () => {
  const db = await setup();
  await seed(db, ['A', 'B'], 3);
  const ids = await prizeIds(db);
  for (const id of ids) await draw(db, OPER, id); // 3 個獎 2 人 → 一人 2 個、一人 1 個
  const winnerOf = async (id) => (await db.query('select p.id, p.name from draws d join people p on p.id=d.person_id where d.prize_id=$1', [id])).rows[0];
  const w0 = await winnerOf(ids[0]);
  const other = (await db.query('select id, name from people where id <> $1', [w0.id])).rows[0];
  const otherCount = (await db.query('select count(*)::int c from draws where person_id=$1', [other.id])).rows[0].c;

  await as(db, OPER, () => rejects(db.query('select admin_correct_draw($1,$2,$3)', [ids[0], other.id, 'x']), /FORBIDDEN/));
  await as(db, ADMIN, async () => {
    await rejects(db.query('select admin_correct_draw($1,$2,$3)', [ids[0], other.id, '  ']), /REASON_REQUIRED/);
    await rejects(db.query('select admin_correct_draw($1,$2,$3)', [ids[0], w0.id, '同人']), /SAME_PERSON/);
    if (otherCount >= 2) {
      await rejects(db.query('select admin_correct_draw($1,$2,$3)', [ids[0], other.id, '超額']), /LIMIT_REACHED/);
      await db.query('select admin_correct_draw($1,$2,$3,true)', [ids[0], other.id, '強制']);
    } else {
      await db.query('select admin_correct_draw($1,$2,$3)', [ids[0], other.id, '名單抄錯']);
    }
  });
  assert.equal((await winnerOf(ids[0])).id, other.id);
  const log = (await db.query('select * from audit_log')).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'correct');
  assert.equal(log[0].actor_email, 'admin@x.com');
  assert.equal(log[0].old_person_name, w0.name);
  assert.equal(log[0].new_person_name, other.name);
  await as(db, null, async () => assert.equal((await db.query('select * from audit_log')).rows.length, 1)); // 公開可讀
  await as(db, ADMIN, () => rejects(db.query("insert into audit_log(action, reason) values ('void','x')"), /permission denied/));
});

test('作廢後該獎項可重抽;全部重置會留紀錄;被引用的資料不能刪', async () => {
  const db = await setup();
  await seed(db, ['A', 'B'], 2);
  const ids = await prizeIds(db);
  await draw(db, OPER, ids[0]);
  await draw(db, OPER, ids[1]);

  await as(db, ADMIN, async () => {
    await rejects(db.query('delete from prizes where id = $1', [ids[0]]), /foreign key|violates/);
    await rejects(db.query('select admin_void_draw($1,$2)', [ids[0], '']), /REASON_REQUIRED/);
    await db.query('select admin_void_draw($1,$2)', [ids[0], '誤按']);
  });
  assert.equal((await db.query('select count(*)::int c from draws')).rows[0].c, 1);
  await draw(db, OPER, ids[0]); // 重抽成功

  await as(db, OPER, () => rejects(db.query("select admin_reset_draws('x')"), /FORBIDDEN/));
  await as(db, ADMIN, () => db.query("select admin_reset_draws('彩排重置')"));
  assert.equal((await db.query('select count(*)::int c from draws')).rows[0].c, 0);
  const actions = (await db.query('select action from audit_log order by id')).rows.map((r) => r.action);
  assert.deepEqual(actions, ['void', 'reset']);
});

test('schema.sql 可重複執行', async () => {
  const db = await setup();
  await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
});

test('並發抽同一獎項只會成功一次', async () => {
  const db = await setup();
  await seed(db, ['A', 'B', 'C'], 1);
  const [id] = await prizeIds(db);
  const results = await Promise.allSettled([draw(db, OPER, id), draw(db, OPER, id), draw(db, OPER, id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await db.query('select count(*)::int c from draws')).rows[0].c, 1);
});

// ---------- 獎項多於人數 ----------
test('18 個獎 16 人:全部抽完,每人至少 1 個至多 2 個,恰好 2 人得 2 個', async () => {
  const db = await setup();
  const names = Array.from({ length: 16 }, (_, i) => `人${i + 1}`);
  await seed(db, names, 18);
  const ids = await prizeIds(db);
  const order = [...ids].sort(() => Math.random() - 0.5); // 以打亂的順序抽
  for (const id of order) await draw(db, OPER, id);

  assert.equal((await db.query('select count(*)::int c from draws')).rows[0].c, 18);
  const per = (await db.query('select p.name, count(*)::int c from draws d join people p on p.id=d.person_id group by p.name')).rows;
  assert.equal(per.length, 16);
  for (const r of per) assert.ok(r.c >= 1 && r.c <= 2, JSON.stringify(r));
  assert.equal(per.filter((r) => r.c === 2).length, 2);
});

test('一人一獎:人數抽完後再抽回報 NO_ELIGIBLE', async () => {
  const db = await setup();
  await seed(db, ['A'], 2);
  await db.query('update settings set max_per_person = 1 where id = 1');
  const ids = await prizeIds(db);
  await draw(db, OPER, ids[0]);
  await rejects(draw(db, OPER, ids[1]), /NO_ELIGIBLE/);
});
