-- ============================================================
-- 抽獎系統 — Supabase schema
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可(可重複執行)。
--
-- 權限模型
--   觀眾(未登入)   : 只能讀取
--   operator       : 可執行抽獎(draw_prize),不可改結果
--   admin          : 可匯入/刪除獎項與名單、改設定、更正/作廢結果
-- 抽獎結果表 draws 沒有任何直接寫入權限,
-- 一律透過下方 security definer 函式寫入,確保:
--   * 抽獎由伺服器亂數決定(瀏覽器無法作弊)
--   * 一個獎項只會被抽一次(unique)
--   * 每人得獎數不超過上限
--   * 所有更正都留下稽核紀錄
-- ============================================================

-- ---------- 資料表 ----------
create table if not exists public.settings (
  id             int primary key default 1 check (id = 1),
  max_per_person int  not null default 2 check (max_per_person >= 1),
  prefer_unwon   boolean not null default true
);
alter table public.settings add column if not exists fx_countdown boolean not null default true;
alter table public.settings add column if not exists fx_confetti  boolean not null default true;
alter table public.settings add column if not exists random_prize boolean not null default true;
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.people (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  note       text,
  created_at timestamptz not null default now()
);

create table if not exists public.prizes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.draws (
  id        uuid primary key default gen_random_uuid(),
  prize_id  uuid not null unique references public.prizes(id) on delete restrict,
  person_id uuid not null references public.people(id) on delete restrict,
  drawn_at  timestamptz not null default now(),
  drawn_by  uuid
);

create table if not exists public.audit_log (
  id              bigint generated always as identity primary key,
  action          text not null check (action in ('correct', 'void', 'reset')),
  prize_id        uuid,
  prize_name      text,
  old_person_name text,
  new_person_name text,
  reason          text not null,
  actor           uuid,
  actor_email     text,
  at              timestamptz not null default now()
);

create table if not exists public.staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role    text not null check (role in ('operator', 'admin'))
);

-- ---------- 目前登入者的角色 ----------
create or replace function public.staff_role()
returns text
language sql stable security definer
set search_path = public
as $$ select role from public.staff where user_id = auth.uid() $$;

-- ---------- Row Level Security ----------
alter table public.settings  enable row level security;
alter table public.people    enable row level security;
alter table public.prizes    enable row level security;
alter table public.draws     enable row level security;
alter table public.audit_log enable row level security;
alter table public.staff     enable row level security;

drop policy if exists "read all"   on public.settings;
drop policy if exists "admin edit" on public.settings;
create policy "read all"   on public.settings for select using (true);
create policy "admin edit" on public.settings for update
  using (public.staff_role() = 'admin') with check (public.staff_role() = 'admin');

drop policy if exists "read all"    on public.people;
drop policy if exists "admin write" on public.people;
create policy "read all"    on public.people for select using (true);
create policy "admin write" on public.people for all
  using (public.staff_role() = 'admin') with check (public.staff_role() = 'admin');

drop policy if exists "read all"    on public.prizes;
drop policy if exists "admin write" on public.prizes;
create policy "read all"    on public.prizes for select using (true);
create policy "admin write" on public.prizes for all
  using (public.staff_role() = 'admin') with check (public.staff_role() = 'admin');

drop policy if exists "read all" on public.draws;
create policy "read all" on public.draws for select using (true);

drop policy if exists "read all" on public.audit_log;
create policy "read all" on public.audit_log for select using (true);

drop policy if exists "read self" on public.staff;
create policy "read self" on public.staff for select using (user_id = auth.uid());

-- draws / audit_log 完全禁止直接寫入,只能走函式
revoke insert, update, delete, truncate on public.draws     from anon, authenticated;
revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;
revoke insert, update, delete, truncate on public.staff     from anon, authenticated;
revoke insert, delete, truncate         on public.settings  from anon, authenticated;

-- ---------- 抽獎 ----------
-- 規則:排除已達每人上限者;若 prefer_unwon 開啟,先從得獎次數最少的人中抽,
-- 因此獎項多於人數時,會先讓每個人都中一個,再開始抽第二個。
create or replace function public.draw_prize(p_prize_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  v_prize    public.prizes;
  v_settings public.settings;
  v_person   public.people;
  v_draw     public.draws;
begin
  if public.staff_role() is null then raise exception 'FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtext('lottery_draw'));

  select * into v_prize from public.prizes where id = p_prize_id;
  if not found then raise exception 'PRIZE_NOT_FOUND'; end if;
  if exists (select 1 from public.draws where prize_id = p_prize_id) then
    raise exception 'ALREADY_DRAWN';
  end if;

  select * into v_settings from public.settings where id = 1;

  select p.* into v_person
  from public.people p
  cross join lateral (select count(*) as c from public.draws d where d.person_id = p.id) w
  where w.c < v_settings.max_per_person
  order by (case when v_settings.prefer_unwon then w.c else 0 end), gen_random_uuid()
  limit 1;
  if not found then raise exception 'NO_ELIGIBLE'; end if;

  insert into public.draws (prize_id, person_id, drawn_by)
  values (p_prize_id, v_person.id, auth.uid())
  returning * into v_draw;

  return jsonb_build_object(
    'draw_id', v_draw.id, 'prize_id', v_prize.id, 'prize_name', v_prize.name,
    'person_id', v_person.id, 'person_name', v_person.name
  );
end $$;

-- ---------- Admin:更正得獎人 ----------
create or replace function public.admin_correct_draw(
  p_prize_id uuid, p_new_person_id uuid, p_reason text, p_force boolean default false
) returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_draw public.draws; v_old public.people; v_new public.people;
  v_prize public.prizes; v_max int;
begin
  if public.staff_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('lottery_draw'));

  select * into v_draw from public.draws where prize_id = p_prize_id;
  if not found then raise exception 'DRAW_NOT_FOUND'; end if;
  if v_draw.person_id = p_new_person_id then raise exception 'SAME_PERSON'; end if;

  select * into v_new from public.people where id = p_new_person_id;
  if not found then raise exception 'PERSON_NOT_FOUND'; end if;
  select * into v_old   from public.people where id = v_draw.person_id;
  select * into v_prize from public.prizes where id = p_prize_id;
  select max_per_person into v_max from public.settings where id = 1;

  if not coalesce(p_force, false)
     and (select count(*) from public.draws where person_id = p_new_person_id) >= v_max then
    raise exception 'LIMIT_REACHED';
  end if;

  update public.draws set person_id = p_new_person_id where id = v_draw.id;

  insert into public.audit_log (action, prize_id, prize_name, old_person_name, new_person_name,
                                reason, actor, actor_email)
  values ('correct', p_prize_id, v_prize.name, v_old.name, v_new.name, btrim(p_reason),
          auth.uid(), (select email from auth.users where id = auth.uid()));
end $$;

-- ---------- Admin:作廢單一結果(該獎項回到待抽) ----------
create or replace function public.admin_void_draw(p_prize_id uuid, p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_draw public.draws; v_old public.people; v_prize public.prizes;
begin
  if public.staff_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('lottery_draw'));

  select * into v_draw from public.draws where prize_id = p_prize_id;
  if not found then raise exception 'DRAW_NOT_FOUND'; end if;
  select * into v_old   from public.people where id = v_draw.person_id;
  select * into v_prize from public.prizes where id = p_prize_id;

  delete from public.draws where id = v_draw.id;

  insert into public.audit_log (action, prize_id, prize_name, old_person_name, reason, actor, actor_email)
  values ('void', p_prize_id, v_prize.name, v_old.name, btrim(p_reason),
          auth.uid(), (select email from auth.users where id = auth.uid()));
end $$;

-- ---------- Admin:清空全部抽獎結果 ----------
create or replace function public.admin_reset_draws(p_reason text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare v_n int;
begin
  if public.staff_role() is distinct from 'admin' then raise exception 'FORBIDDEN'; end if;
  if p_reason is null or btrim(p_reason) = '' then raise exception 'REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('lottery_draw'));

  select count(*) into v_n from public.draws;
  delete from public.draws where true; -- Supabase 的 safeupdate 禁止沒有 WHERE 的 DELETE

  insert into public.audit_log (action, prize_name, reason, actor, actor_email)
  values ('reset', format('共清除 %s 筆結果', v_n), btrim(p_reason),
          auth.uid(), (select email from auth.users where id = auth.uid()));
end $$;

-- 函式只開放給登入者(函式內還會再檢查 staff 角色)
revoke execute on function public.draw_prize(uuid)                          from public, anon;
revoke execute on function public.admin_correct_draw(uuid, uuid, text, boolean) from public, anon;
revoke execute on function public.admin_void_draw(uuid, text)               from public, anon;
revoke execute on function public.admin_reset_draws(text)                   from public, anon;
grant  execute on function public.draw_prize(uuid)                          to authenticated;
grant  execute on function public.admin_correct_draw(uuid, uuid, text, boolean) to authenticated;
grant  execute on function public.admin_void_draw(uuid, text)               to authenticated;
grant  execute on function public.admin_reset_draws(text)                   to authenticated;

-- ---------- 移除舊版「指定得獎人」功能(舊資料庫重跑時清掉,可重複執行) ----------
drop function if exists public.admin_set_assignment(uuid, uuid);
drop function if exists public.admin_clear_assignment(uuid);
drop table    if exists public.assignments;
alter table public.draws drop column if exists designated;

-- ---------- Realtime(讓觀眾頁面即時更新) ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['people', 'prizes', 'draws', 'audit_log', 'settings'] loop
      begin
        execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null;
      end;
    end loop;
  end if;
end $$;
