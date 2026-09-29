-- ============================================================
--  STREAK + DAILY COIN ECONOMY (+ cosmetics foundation)
--  Run in Supabase → SQL Editor → New query → Run
--
--  ASSUMPTION — please verify before running:
--  I don't have direct database access in this session, so I could not
--  read the real wallets table or the spend_coins/add_coins RPC
--  definitions. spend_coins's call signature IS confirmed from
--  api/_coins.js: rpc("spend_coins", { p_user_id, p_amount }), returns
--  an integer. add_coins is never referenced anywhere in the codebase I
--  can see, so claim_daily below assumes it mirrors spend_coins exactly:
--
--      add_coins(p_user_id uuid, p_amount int) returns integer
--
--  If the real add_coins has different parameter names, fix the one
--  call inside claim_daily (search "ASSUMED SIGNATURE" below) before
--  running this file — everything else here is independent of it.
-- ============================================================

-- 1. STREAKS ---------------------------------------------------
create table if not exists public.streaks (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  current_streak  integer not null default 0,
  longest_streak  integer not null default 0,
  last_active_date date,
  timezone        text,
  updated_at      timestamptz not null default now()
);

alter table public.streaks enable row level security;

-- Reads only. No insert/update/delete policy for regular users — streaks
-- are an economy ledger, not user-owned content like classes/assignments.
-- The only writer is claim_daily() below (security definer, so it bypasses
-- RLS on purpose). Opening this table to direct client writes the way
-- classes/assignments/reminders are open would let anyone set their own
-- streak by hand and unlock every milestone/cosmetic for free — so this
-- deliberately does NOT match that policy set.
drop policy if exists "own streaks select" on public.streaks;
create policy "own streaks select" on public.streaks
  for select using (auth.uid() = user_id);

-- 2. DAILY CLAIMS ------------------------------------------------
-- One row per user per calendar day they claimed. The UNIQUE constraint
-- is the actual anti-cheat: claim_daily() relies on an atomic
-- "insert ... on conflict (user_id, claim_date) do nothing" against this
-- table to decide whether today was already claimed — never a
-- SELECT-then-INSERT, so two concurrent calls can't both award coins.
create table if not exists public.daily_claims (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  claim_date    date not null,
  coins_awarded integer not null,
  created_at    timestamptz not null default now(),
  unique (user_id, claim_date)
);

create index if not exists daily_claims_user_idx on public.daily_claims (user_id, claim_date);

alter table public.daily_claims enable row level security;

-- Reads only, same reasoning as streaks above — writes go through
-- claim_daily() only.
drop policy if exists "own daily_claims select" on public.daily_claims;
create policy "own daily_claims select" on public.daily_claims
  for select using (auth.uid() = user_id);

-- 3. CLAIM_DAILY RPC ----------------------------------------------
-- Called directly by the client (supabase.rpc("claim_daily", { p_timezone })),
-- using the caller's own session — auth.uid() identifies the user, there's
-- no p_user_id param, so nobody can claim on another user's behalf.
--
-- IMPORTANT (per the brief): this is meant to fire on a real user action
-- (opening the schedule, touching an assignment) — NOT wired to a mount
-- effect. That wiring happens on the frontend later, not in this file.
create or replace function public.claim_daily(p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id    uuid := auth.uid();
  v_today      date;
  v_row        public.streaks%rowtype;
  v_new_streak integer;
  v_award      integer;
  v_milestone  integer;
  v_total      integer;
  v_balance    integer;
  v_rows       integer;
begin
  if v_user_id is null then
    raise exception 'claim_daily: not authenticated';
  end if;

  -- "Today" is computed from the server clock in the caller's timezone.
  -- A client can pass whatever timezone string it wants, but it can't
  -- move the server's clock — it only shifts which calendar day "now()"
  -- falls on, exactly like asking "what day is it where you are."
  v_today := (now() at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::date;

  -- Make sure a streaks row exists, then lock it for the rest of this
  -- transaction so two concurrent calls from the same user serialize here.
  insert into public.streaks (user_id, current_streak, longest_streak, last_active_date, timezone, updated_at)
  values (v_user_id, 0, 0, null, p_timezone, now())
  on conflict (user_id) do nothing;

  select * into v_row from public.streaks where user_id = v_user_id for update;

  -- Streak math (last_active_date was yesterday -> +1, today -> unchanged,
  -- anything older or null -> reset to 1). In normal operation the "today"
  -- branch never actually gets persisted below — the daily_claims unique
  -- constraint is what actually stops a double-claim, this is just the
  -- documented, defensive version of the same rule.
  if v_row.last_active_date = v_today then
    v_new_streak := v_row.current_streak;
  elsif v_row.last_active_date = v_today - 1 then
    v_new_streak := v_row.current_streak + 1;
  else
    v_new_streak := 1;
  end if;

  -- 25 base, +5 per streak day beyond the first, capped at 50/day.
  v_award := least(50, 25 + 5 * greatest(0, v_new_streak - 1));

  v_milestone := null;
  if v_new_streak = 7 then v_milestone := 100;
  elsif v_new_streak = 30 then v_milestone := 400;
  elsif v_new_streak = 100 then v_milestone := 1000;
  end if;

  v_total := v_award + coalesce(v_milestone, 0);

  -- THE anti-cheat gate. Atomic: if another call already claimed today
  -- (or a genuine concurrent duplicate slips in), this inserts zero rows
  -- and we fall through to the no-op branch below. No prior SELECT to
  -- check existence — the constraint itself is the check.
  insert into public.daily_claims (user_id, claim_date, coins_awarded)
  values (v_user_id, v_today, v_total)
  on conflict (user_id, claim_date) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    -- Already claimed today. No-op: award nothing, don't touch the
    -- streak, just report the current state. Must not error.
    select coins into v_balance from public.wallets where user_id = v_user_id;
    return jsonb_build_object(
      'current_streak', v_row.current_streak,
      'longest_streak', v_row.longest_streak,
      'coins_awarded', 0,
      'new_balance', coalesce(v_balance, 0),
      'milestone_hit', null
    );
  end if;

  -- Our insert won the race — this is a real, new claim. Persist the
  -- streak and credit the wallet.
  update public.streaks
  set current_streak = v_new_streak,
      longest_streak = greatest(v_row.longest_streak, v_new_streak),
      last_active_date = v_today,
      timezone = p_timezone,
      updated_at = now()
  where user_id = v_user_id;

  -- ASSUMED SIGNATURE — see the note at the top of this file.
  v_balance := public.add_coins(v_user_id, v_total);

  return jsonb_build_object(
    'current_streak', v_new_streak,
    'longest_streak', greatest(v_row.longest_streak, v_new_streak),
    'coins_awarded', v_total,
    'new_balance', coalesce(v_balance, 0),
    'milestone_hit', v_milestone
  );
end;
$$;

-- Only a logged-in user can call this, and only for themselves.
revoke execute on function public.claim_daily(text) from public;
revoke execute on function public.claim_daily(text) from anon;
grant execute on function public.claim_daily(text) to authenticated;

-- 4. COSMETICS FOUNDATION (tables + seed data only, no equip/purchase logic yet)
create table if not exists public.cosmetics (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slot          text not null check (slot in ('hat', 'eyes', 'audio')),
  price         integer not null default 0,
  unlock_type   text not null check (unlock_type in ('purchase', 'streak')),
  unlock_streak integer,
  sprite_key    text not null,
  created_at    timestamptz not null default now(),
  check (
    (unlock_type = 'purchase' and unlock_streak is null)
    or (unlock_type = 'streak' and unlock_streak is not null)
  )
);

alter table public.cosmetics enable row level security;

-- Catalog is public read (anyone can see what's in the shop, logged in
-- or not) — it's not user data. No write policies: only an admin/service
-- role edits the catalog.
drop policy if exists "cosmetics catalog select" on public.cosmetics;
create policy "cosmetics catalog select" on public.cosmetics
  for select using (true);

create table if not exists public.user_cosmetics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  cosmetic_id uuid not null references public.cosmetics(id) on delete cascade,
  acquired_at timestamptz not null default now(),
  equipped    boolean not null default false,
  unique (user_id, cosmetic_id)
);

create index if not exists user_cosmetics_user_idx on public.user_cosmetics (user_id);

alter table public.user_cosmetics enable row level security;

-- Read-only for now, same reasoning as streaks/daily_claims: granting a
-- cosmetic (an insert here) is a purchase/unlock action that doesn't
-- exist yet. Whatever RPC does that later should be security definer,
-- same shape as claim_daily, so a user can't just insert themselves a
-- free item. Equip/unequip (an update) can likely open up to the owning
-- user later since it has no economic value — deliberately left out for
-- now since that's logic, and this pass is tables only.
drop policy if exists "own user_cosmetics select" on public.user_cosmetics;
create policy "own user_cosmetics select" on public.user_cosmetics
  for select using (auth.uid() = user_id);

-- Seed catalog. sprite_key values are placeholder slugs — sprite art
-- comes later, per the brief. Re-runnable: matches on name, won't
-- duplicate rows.
insert into public.cosmetics (name, slot, price, unlock_type, unlock_streak, sprite_key)
select v.name, v.slot, v.price, v.unlock_type, v.unlock_streak, v.sprite_key
from (
  values
    ('Beanie',       'hat',   60,  'purchase', null::integer, 'beanie'),
    ('Round Glasses','eyes',  60,  'purchase', null::integer, 'round_glasses'),
    ('Cap',          'hat',   180, 'purchase', null::integer, 'cap'),
    ('Visor',        'eyes',  180, 'purchase', null::integer, 'visor'),
    ('Headphones',   'audio', 180, 'purchase', null::integer, 'headphones'),
    ('Top Hat',      'hat',   450, 'purchase', null::integer, 'top_hat'),
    ('Shades',       'eyes',  450, 'purchase', null::integer, 'shades'),
    -- Streak-locked. Names/slots are placeholders — nothing was specified
    -- beyond the streak thresholds, easy to rename before shipping.
    ('Flame Crown',    'hat',   0, 'streak', 7,   'flame_crown'),
    ('Star Shades',    'eyes',  0, 'streak', 30,  'star_shades'),
    ('Legend Headphones', 'audio', 0, 'streak', 100, 'legend_headphones')
) as v(name, slot, price, unlock_type, unlock_streak, sprite_key)
where not exists (
  select 1 from public.cosmetics c where c.name = v.name
);
