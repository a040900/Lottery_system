// 匯入文字解析與 CSV 匯出(純函式,無 DOM / 網路相依,方便測試)

const HEADER_RE = /^(獎項|獎品|名稱|品項|姓名|名單|name|prize|item)$/i;
export const MAX_QTY = 500;
export const MAX_ROWS = 5000;

/** 以逗號 / Tab / 全形逗號切欄位,支援雙引號包起來的欄位。 */
export function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"' && cur === '') {
      quoted = true;
    } else if (c === ',' || c === '\t' || c === '，') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** 文字 → 資料列。略過空行、# 開頭的註解行與標題列。 */
export function parseRows(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    rows.push({ line: idx + 1, fields: splitLine(line) });
  });
  if (rows.length && HEADER_RE.test(rows[0].fields[0])) rows.shift();
  return rows;
}

/**
 * 獎項:每行「名稱」「名稱,數量」「名稱 x3」「名稱*3」。
 * 數量 > 1 會展開成多個獎項,名稱加上 " #序號"。
 */
export function parsePrizes(text) {
  const prizes = [];
  const errors = [];
  for (const { line, fields } of parseRows(text)) {
    let name = fields[0];
    let qty = 1;
    const m = name.match(/^(.*?)\s*[x×*＊]\s*(\d+)$/i);
    if (fields[1] !== undefined && fields[1] !== '') {
      if (!/^\d+$/.test(fields[1])) { errors.push({ line, msg: `數量「${fields[1]}」不是正整數` }); continue; }
      qty = Number(fields[1]);
    } else if (m && m[1]) {
      name = m[1];
      qty = Number(m[2]);
    }
    if (!name) { errors.push({ line, msg: '獎項名稱是空的' }); continue; }
    if (qty < 1 || qty > MAX_QTY) { errors.push({ line, msg: `數量需介於 1~${MAX_QTY}` }); continue; }
    for (let i = 1; i <= qty; i++) prizes.push({ name: qty === 1 ? name : `${name} #${i}` });
  }
  if (prizes.length > MAX_ROWS) {
    errors.push({ line: 0, msg: `獎項總數超過 ${MAX_ROWS}` });
    return { prizes: [], errors };
  }
  return { prizes, errors };
}

/** 抽獎人:每行「姓名」或「姓名,備註(部門/編號)」。姓名+備註完全相同視為重複並略過。 */
export function parsePeople(text) {
  const people = [];
  const errors = [];
  const seen = new Set();
  let skipped = 0;
  for (const { line, fields } of parseRows(text)) {
    const name = fields[0];
    const note = fields.slice(1).filter(Boolean).join(' ');
    if (!name) { errors.push({ line, msg: '姓名是空的' }); continue; }
    const key = `${name}\u0000${note}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    people.push({ name, note: note || null });
  }
  if (people.length > MAX_ROWS) {
    errors.push({ line: 0, msg: `名單超過 ${MAX_ROWS} 人` });
    return { people: [], skipped, errors };
  }
  return { people, skipped, errors };
}

/** 二維陣列 → CSV(含 BOM 讓 Excel 正確顯示中文;防止公式注入)。 */
export function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}
