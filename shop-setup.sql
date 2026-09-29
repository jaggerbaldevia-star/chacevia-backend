-- ============================================================
--  COSMETICS SHOP — purchase / equip / unequip RPCs, plus wiring
--  streak milestones in claim_daily to auto-grant the locked cosmetic.
--  Run in Supabase → SQL Editor → New query → Run
--
--  Requires streak-setup.sql to already be applied (streaks,
--  daily_claims, claim_daily, cosmetics, user_cosmetics must all exist).
--
--  Same access caveat as streak-setup.sql: I don't have database access
--  in this session. spend_coins's signature IS confirmed from
--  api/_coins.js — rpc("spend_coins", { p_user_id, p_amount }), and
--  per that file's own comment it "Returns the new balance, or -1 if
--  too few" (does not throw on insufficient funds). purchase_cosmetic
--  below relies on exactly that documented behavior — no new assumption
--  beyond what streak-setup.sql already flagged for add_coins.
--
--  RLS note: cosmetics and user_cosmetics already have the read-only
--  policies this brief asks for (own-rows select on user_cosmetics,
--  world-readable select on cosmetics, no insert/update/delete for
--  regular users) — set up in streak-setup.sql. Every write below goes
--  through a security definer RPC, consistent with that design. Nothing
--  to add on the RLS side.
-- ============================================================

-- 1. PURCHASE_COSMETIC ---------------------------------------------
-- Ownership is granted BEFORE coins move, gated by the unique
-- (user_id, cosmetic_id) constraint on user_cosmetics — the same
-- insert-first-check-row-count pattern claim_daily uses for its own
-- anti-cheat gate. A losing concurrent double-click bails out right
-- here, before it ever calls spend_coins, so it can't double-spend.
-- If the later spend_coins call fails, the exception rolls back this
-- whole transaction — including the insert above — so there is no
-- state where the item is granted but coins weren't deducted, or vice
-- versa. One transaction, one outcome.
create or replace function public.purchase_cosmetic(p_cosmetic_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_cos     public.cosmetics%rowtype;
  v_rows    integer;
  v_balance integer;
begin
  if v_user_id is null then
    raise exception 'purchase_cosmetic: not authenticated';
  end if;

  select * into v_cos from public.cosmetics where id = p_cosmetic_id;
  if not found then
    raise exception 'purchase_cosmetic: cosmetic not found';
  end if;

  if v_cos.unlock_type <> 'purchase' then
    raise exception 'purchase_cosmetic: % is streak-locked, not purchasable', v_cos.name;
  end if;

  insert into public.user_cosmetics (user_id, cosmetic_id, equipped)
  values (v_user_id, p_cosmetic_id, false)
  on conflict (user_id, cosmetic_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    raise exception 'purchase_cosmetic: already owned';
  end if;

  -- ASSUMED SIGNATURE — see streak-setup.sql's note on add_coins;
  -- spend_coins's actual signature is confirmed, not assumed.
  v_balance := public.spend_coins(v_user_id, v_cos.price);
  if v_balance is null or v_balance < 0 then
    raise exception 'purchase_cosmetic: not enough coins';
  end if;

  return jsonb_build_object(
    'new_balance', v_balance,
    'cosmetic', jsonb_build_object(
      'id', v_cos.id,
      'name', v_cos.name,
      'slot', v_cos.slot,
      'sprite_key', v_cos.sprite_key
    )
  );
end;
$$;

revoke execute on function public.purchase_cosmetic(uuid) from public;
revoke execute on function public.purchase_cosmetic(uuid) from anon;
grant execute on function public.purchase_cosmetic(uuid) to authenticated;

-- 2. EQUIP_COSMETIC / UNEQUIP_COSMETIC ------------------------------
-- Two plain UPDATE statements in sequence, not a read-then-write in
-- application code — Postgres's own row-level locking already
-- serializes concurrent equip calls for the same user correctly, no
-- extra locking needed.
create or replace function public.equip_cosmetic(p_cosmetic_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_cos     public.cosmetics%rowtype;
  v_owned   boolean;
begin
  if v_user_id is null then
    raise exception 'equip_cosmetic: not authenticated';
  end if;

  select * into v_cos from public.cosmetics where id = p_cosmetic_id;
  if not found then
    raise exception 'equip_cosmetic: cosmetic not found';
  end if;

  select exists(
    select 1 from public.user_cosmetics
    where user_id = v_user_id and cosmetic_id = p_cosmetic_id
  ) into v_owned;
  if not v_owned then
    raise exception 'equip_cosmetic: not owned';
  end if;

  -- Only one equipped item per slot: unequip whatever else is currently
  -- equipped in this cosmetic's slot before equipping this one.
  update public.user_cosmetics uc
  set equipped = false
  where uc.user_id = v_user_id
    and uc.equipped = true
    and uc.cosmetic_id in (
      select id from public.cosmetics where slot = v_cos.slot
    );

  update public.user_cosmetics
  set equipped = true
  where user_id = v_user_id and cosmetic_id = p_cosmetic_id;

  return jsonb_build_object('equipped_cosmetic_id', p_cosmetic_id, 'slot', v_cos.slot);
end;
$$;

revoke execute on function public.equip_cosmetic(uuid) from public;
revoke execute on function public.equip_cosmetic(uuid) from anon;
grant execute on function public.equip_cosmetic(uuid) to authenticated;

create or replace function public.unequip_cosmetic(p_cosmetic_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_owned   boolean;
begin
  if v_user_id is null then
    raise exception 'unequip_cosmetic: not authenticated';
  end if;

  select exists(
    select 1 from public.user_cosmetics
    where user_id = v_user_id and cosmetic_id = p_cosmetic_id
  ) into v_owned;
  if not v_owned then
    raise exception 'unequip_cosmetic: not owned';
  end if;

  update public.user_cosmetics
  set equipped = false
  where user_id = v_user_id and cosmetic_id = p_cosmetic_id;

  return jsonb_build_object('unequipped_cosmetic_id', p_cosmetic_id);
end;
$$;

revoke execute on function public.unequip_cosmetic(uuid) from public;
revoke execute on function public.unequip_cosmetic(uuid) from anon;
grant execute on function public.unequip_cosmetic(uuid) to authenticated;

-- 3. CLAIM_DAILY — replaced to auto-grant the milestone cosmetic ---
-- Identical to streak-setup.sql's version except for the new block
-- right after the streak update: when a milestone fires, look up the
-- matching streak-locked cosmetic and grant it. That insert is itself
-- gated by the same (user_id, cosmetic_id) unique constraint via
-- ON CONFLICT DO NOTHING, so re-reaching a milestone later (streak
-- resets, then climbs back to 7 again) just silently no-ops instead of
-- erroring or duplicating — they already own it.
create or replace function public.claim_daily(p_timezone text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id           uuid := auth.uid();
  v_today             date;
  v_row               public.streaks%rowtype;
  v_new_streak        integer;
  v_award             integer;
  v_milestone         integer;
  v_total             integer;
  v_balance           integer;
  v_rows              integer;
  v_cos               public.cosmetics%rowtype;
  v_milestone_cosmetic jsonb;
begin
  if v_user_id is null then
    raise exception 'claim_daily: not authenticated';
  end if;

  v_today := (now() at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::date;

  insert into public.streaks (user_id, current_streak, longest_streak, last_active_date, timezone, updated_at)
  values (v_user_id, 0, 0, null, p_timezone, now())
  on conflict (user_id) do nothing;

  select * into v_row from public.streaks where user_id = v_user_id for update;

  if v_row.last_active_date = v_today then
    v_new_streak := v_row.current_streak;
  elsif v_row.last_active_date = v_today - 1 then
    v_new_streak := v_row.current_streak + 1;
  else
    v_new_streak := 1;
  end if;

  v_award := least(50, 25 + 5 * greatest(0, v_new_streak - 1));

  v_milestone := null;
  if v_new_streak = 7 then v_milestone := 100;
  elsif v_new_streak = 30 then v_milestone := 400;
  elsif v_new_streak = 100 then v_milestone := 1000;
  end if;

  v_total := v_award + coalesce(v_milestone, 0);

  insert into public.daily_claims (user_id, claim_date, coins_awarded)
  values (v_user_id, v_today, v_total)
  on conflict (user_id, claim_date) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select coins into v_balance from public.wallets where user_id = v_user_id;
    return jsonb_build_object(
      'current_streak', v_row.current_streak,
      'longest_streak', v_row.longest_streak,
      'coins_awarded', 0,
      'new_balance', coalesce(v_balance, 0),
      'milestone_hit', null,
      'milestone_cosmetic', null
    );
  end if;

  update public.streaks
  set current_streak = v_new_streak,
      longest_streak = greatest(v_row.longest_streak, v_new_streak),
      last_active_date = v_today,
      timezone = p_timezone,
      updated_at = now()
  where user_id = v_user_id;

  -- NEW: auto-grant the streak-locked cosmetic for this milestone, if any.
  v_milestone_cosmetic := null;
  if v_milestone is not null then
    select * into v_cos
    from public.cosmetics
    where unlock_type = 'streak' and unlock_streak = v_new_streak
    limit 1;

    if found then
      insert into public.user_cosmetics (user_id, cosmetic_id, equipped)
      values (v_user_id, v_cos.id, false)
      on conflict (user_id, cosmetic_id) do nothing;

      v_milestone_cosmetic := jsonb_build_object(
        'id', v_cos.id,
        'name', v_cos.name,
        'slot', v_cos.slot,
        'sprite_key', v_cos.sprite_key
      );
    end if;
  end if;

  -- ASSUMED SIGNATURE — see the note in streak-setup.sql.
  v_balance := public.add_coins(v_user_id, v_total);

  return jsonb_build_object(
    'current_streak', v_new_streak,
    'longest_streak', greatest(v_row.longest_streak, v_new_streak),
    'coins_awarded', v_total,
    'new_balance', coalesce(v_balance, 0),
    'milestone_hit', v_milestone,
    'milestone_cosmetic', v_milestone_cosmetic
  );
end;
$$;

revoke execute on function public.claim_daily(text) from public;
revoke execute on function public.claim_daily(text) from anon;
grant execute on function public.claim_daily(text) to authenticated;
