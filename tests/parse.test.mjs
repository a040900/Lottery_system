import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePrizes, parsePeople, splitLine, toCsv } from '../lib/parse.js';

test('splitLine 支援引號與全形逗號', () => {
  assert.deepEqual(splitLine('a,"b,c",d'), ['a', 'b,c', 'd']);
  assert.deepEqual(splitLine('王小明，行銷部'), ['王小明', '行銷部']);
  assert.deepEqual(splitLine('x\ty'), ['x', 'y']);
  assert.deepEqual(splitLine('"say ""hi""",1'), ['say "hi"', '1']);
});

test('parsePrizes:數量展開、標題列、註解、錯誤', () => {
  const r = parsePrizes('﻿獎項,數量\n# 註解\n雙人住宿券,3\n四人房 x2\n單人券\n壞資料,abc\n零,0\n');
  assert.deepEqual(r.prizes.map((p) => p.name), [
    '雙人住宿券 #1', '雙人住宿券 #2', '雙人住宿券 #3', '四人房 #1', '四人房 #2', '單人券',
  ]);
  assert.equal(r.errors.length, 2);
});

test('parsePrizes:名稱裡的數字不被誤判', () => {
  assert.deepEqual(parsePrizes('2人房住宿券').prizes, [{ name: '2人房住宿券' }]);
  assert.deepEqual(parsePrizes('Hotel 5 star').prizes, [{ name: 'Hotel 5 star' }]);
});

test('parsePeople:備註、去除完全重複、同名不同備註保留', () => {
  const r = parsePeople('姓名,部門\n王小明,行銷\n王小明,行銷\n王小明,工程\n李小華\n');
  assert.equal(r.people.length, 3);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.people[2], { name: '李小華', note: null });
});

test('toCsv:BOM、引號跳脫、公式注入防護', () => {
  const csv = toCsv([['a', 'b,c'], ['=SUM(A1)', 'x"y']]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"b,c"'));
  assert.ok(csv.includes("'=SUM(A1)"));
  assert.ok(csv.includes('"x""y"'));
});
