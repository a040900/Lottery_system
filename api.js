// Supabase 資料層。UI(app.js)只透過這個介面存取資料,方便測試時替換。
import { MAX_ROWS } from './lib/parse.js';

const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
const PAGE = 1000; // Supabase 單次查詢預設上限
const CHUNK = 500;

export async function createApi(url, key) {
  if (!url || !key || /YOUR_/.test(`${url}${key}`)) return { configured: false };
  const { createClient } = await import(CDN);
  const sb = createClient(url, key);

  const must = async (query) => {
    const { data, error } = await query;
    if (error) throw error;
    return data;
  };

  async function fetchAll(table, orderCols) {
    const rows = [];
    for (let from = 0; from < MAX_ROWS * 2; from += PAGE) {
      let q = sb.from(table).select('*');
      for (const c of orderCols) q = q.order(c);
      const part = await must(q.range(from, from + PAGE - 1));
      rows.push(...part);
      if (part.length < PAGE) break;
    }
    return rows;
  }

  async function insertChunks(table, rows) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await must(sb.from(table).insert(rows.slice(i, i + CHUNK)));
    }
  }

  const NIL = '00000000-0000-0000-0000-000000000000';

  return {
    configured: true,

    async user() {
      const { data } = await sb.auth.getSession();
      return data.session?.user ?? null;
    },
    onAuth(cb) {
      sb.auth.onAuthStateChange((_event, session) => cb(session?.user ?? null));
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    },
    async signOut() { await sb.auth.signOut(); },
    async role() {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      const rows = await must(sb.from('staff').select('role').limit(1));
      return rows[0]?.role ?? null;
    },

    async loadAll() {
      const [prizes, people, draws, settings, audit] = await Promise.all([
        fetchAll('prizes', ['sort_order', 'created_at', 'id']),
        fetchAll('people', ['created_at', 'id']),
        fetchAll('draws', ['drawn_at', 'id']),
        must(sb.from('settings').select('*').eq('id', 1).single()),
        must(sb.from('audit_log').select('*').order('id', { ascending: false }).limit(200)),
      ]);
      return { prizes, people, draws, settings, audit };
    },

    subscribe(onChange) {
      const channel = sb
        .channel('lottery')
        .on('postgres_changes', { event: '*', schema: 'public' }, onChange)
        .subscribe();
      return () => sb.removeChannel(channel);
    },

    async importPrizes(list, startOrder) {
      await insertChunks('prizes', list.map((p, i) => ({ name: p.name, sort_order: startOrder + i })));
    },
    async importPeople(list) {
      await insertChunks('people', list.map((p) => ({ name: p.name, note: p.note })));
    },
    async updateSettings({ max_per_person, prefer_unwon, fx_countdown, fx_confetti, random_prize }) {
      await must(sb.from('settings').update({ max_per_person, prefer_unwon, fx_countdown, fx_confetti, random_prize }).eq('id', 1));
    },
    async deletePrize(id) { await must(sb.from('prizes').delete().eq('id', id)); },
    async deletePerson(id) { await must(sb.from('people').delete().eq('id', id)); },
    async clearPrizes() { await must(sb.from('prizes').delete().neq('id', NIL)); },
    async clearPeople() { await must(sb.from('people').delete().neq('id', NIL)); },

    drawPrize: (prizeId) => must(sb.rpc('draw_prize', { p_prize_id: prizeId })),
    async correctDraw(prizeId, personId, reason, force) {
      await must(sb.rpc('admin_correct_draw', {
        p_prize_id: prizeId, p_new_person_id: personId, p_reason: reason, p_force: !!force,
      }));
    },
    async voidDraw(prizeId, reason) {
      await must(sb.rpc('admin_void_draw', { p_prize_id: prizeId, p_reason: reason }));
    },
    async resetDraws(reason) {
      await must(sb.rpc('admin_reset_draws', { p_reason: reason }));
    },
  };
}
