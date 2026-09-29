-- hardening-cleanup.sql
-- Paste into the Supabase SQL Editor. Read each section before running it; the
-- SELECTs are there so you see what you're about to delete.
--
-- No RLS changes. RLS is enabled on all 18 public tables and no policy lets a
-- user reach another user's rows, so there is nothing to fix.

-- =====================================================================
-- 1. RUN THIS FIRST — account deletion is currently BROKEN for anyone who
--    has ever paid.
-- =====================================================================
-- api/account.js starts by detaching purchase records:
--     update purchases set user_id = null where user_id = <them>
-- If purchases.user_id is still `not null`, that statement fails, the endpoint
-- returns 500 at step "anonymize:purchases", and NOTHING is deleted — so a
-- paying user who asks to be deleted simply can't be. Apple requires that to
-- work.
--
-- account-delete-setup.sql (already in this repo, never run) is what fixes it:
-- it drops the not-null and swaps the foreign key to `on delete set null`.
-- Run that file, then confirm:
select
    a.attnotnull as user_id_still_not_null,   -- want: false
    c.confdeltype as fk_on_delete             -- want: 'n' (set null), not 'c' (cascade)
from pg_attribute a
left join pg_constraint c
       on c.conrelid = a.attrelid
      and a.attnum = any (c.conkey)
      and c.contype = 'f'
where a.attrelid = 'public.purchases'::regclass
  and a.attname = 'user_id';

-- =====================================================================
-- 2. Orphaned rows left behind by deletions that already happened.
-- =====================================================================
-- `history` (legacy AI output: kind, title, content) and `push_sends` (the
-- reminder cron's log, which holds device push tokens) were both outside the
-- deletion path until tonight. Any account deleted before now left its rows
-- behind. The code fix stops new orphans; this clears the existing ones.

-- Look first.
select 'history rows with no surviving user' as what, count(*) as rows
from public.history h
where not exists (select 1 from auth.users u where u.id = h.user_id)
union all
select 'push_sends rows whose token no longer belongs to anyone', count(*)
from public.push_sends s
where not exists (select 1 from public.push_tokens t where t.token = s.token);

-- Then delete. These are the same two conditions, nothing broader.
delete from public.history h
where not exists (select 1 from auth.users u where u.id = h.user_id);

-- Note: this also clears log rows for tokens a CURRENT user has since rotated.
-- That's intended — push_sends is a delivery log, not user-facing history.
delete from public.push_sends s
where not exists (select 1 from public.push_tokens t where t.token = s.token);

-- =====================================================================
-- 3. Nothing to do for the new daily cap.
-- =====================================================================
-- The 100-messages-a-day limit reuses the existing bump_usage(p_user_id,
-- p_bucket, p_endpoint) RPC with a date bucket ('2026-09-28') alongside the
-- hourly one ('2026-09-28T16'). Different strings, so they're separate rows in
-- usage_counters and no migration is needed. To watch it working:
--
--   select user_id, bucket, endpoint, calls
--   from public.usage_counters
--   where endpoint in ('rocco-chat', 'rocco-memory')
--   order by bucket desc limit 40;
--
-- 'rocco-memory' is the second model call each chat message makes. If its
-- volume tracks 'rocco-chat' one-to-one, that's expected — it's why a "100
-- message" day is really up to 200 OpenAI calls.
