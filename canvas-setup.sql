-- canvas-setup.sql
-- DO NOT PASTE YET. Four changes, each explained. Approve them first.
--
-- None of this touches a single existing row: three are CREATE/ADD COLUMN and
-- one is a scheduled job. No UPDATE, no DELETE, nothing dropped.

-- =====================================================================
-- 1. The encrypted feed link. One row per user.
-- =====================================================================
-- Holds AES-256-GCM ciphertext, never the link itself. RLS is ON with ZERO
-- policies, which is the strictest useful state: the service role (the backend)
-- bypasses RLS, and every client — anon and authenticated alike — is denied.
-- That is what makes "never send the link back to the app" a property of the
-- database rather than a promise about my code. Same shape as usage_counters.
create table if not exists public.canvas_links (
    user_id         uuid primary key references auth.users(id) on delete cascade,
    feed_ciphertext text        not null,
    feed_iv         text        not null,
    feed_tag        text        not null,
    feed_host       text,                 -- shown in Settings ("connected to x.instructure.com")
    tz              text,                 -- the student's IANA zone, so the nightly cron files a
                                          -- late-evening deadline under the right day
    last_sync_at    timestamptz,
    last_status     text,
    last_error      text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table public.canvas_links enable row level security;

-- =====================================================================
-- 2. Let assignments remember where they came from.
-- =====================================================================
-- external_id is the Canvas UID ("canvas:event-assignment-123@school...").
-- source is 'manual' for everything that exists today, so nothing changes
-- behaviour for current rows.
--
-- The unique constraint is deliberately NOT partial. PostgREST's upsert emits
-- `ON CONFLICT (user_id, external_id)` with no predicate, and Postgres will not
-- infer a partial index from that — a `where external_id is not null` version
-- would make every sync fail. A plain constraint is safe because NULLs are
-- distinct in a unique index, so any number of hand-made assignments coexist.
alter table public.assignments add column if not exists external_id text;
alter table public.assignments add column if not exists source text not null default 'manual';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.assignments'::regclass
       and conname  = 'assignments_user_external_uniq'
  ) then
    alter table public.assignments
      add constraint assignments_user_external_uniq unique (user_id, external_id);
  end if;
end
$$;

-- =====================================================================
-- 3. Same two columns on classes.
-- =====================================================================
-- No unique constraint here: classes are matched by external_id OR by name, so
-- an imported "AP Bio" reuses a class the student already made by hand instead
-- of sitting next to it as a duplicate.
alter table public.classes add column if not exists external_id text;
alter table public.classes add column if not exists source text not null default 'manual';

-- =====================================================================
-- 4. Daily sync. RUN THIS ONE LAST, and only after CANVAS_ENABLED=1.
-- =====================================================================
-- Hourly, syncing at most 10 users whose last sync is over 20 hours old, so
-- every connected account gets one refresh a day without any single run
-- outliving the 60s function limit. The endpoint authenticates the call with
-- the x-cron-secret header.
--
-- VAULT VERSION. The secret is NOT written into cron.job's command text, where
-- it would sit in plaintext readable by anything that can select from cron.job
-- and show up in any schema dump. It goes into Supabase Vault instead, and the
-- job reads it at run time. It still passes through this editor once when you
-- create it — there is no way to load a secret without typing it somewhere —
-- but it is not stored in the clear afterwards.
--
-- Requires pg_cron and pg_net. If the extensions query came back empty, enable
-- them first in Dashboard → Database → Extensions.

-- 4a. Store the secret. Use the SAME value you put in CRON_SECRET in Vercel.
--     Re-running with a name that already exists errors, so update instead:
--       select vault.update_secret(
--         (select id from vault.secrets where name = 'chacevia_cron_secret'),
--         '<CRON_SECRET>');
select vault.create_secret(
    '<CRON_SECRET>',
    'chacevia_cron_secret',
    'Shared secret the Canvas daily sync sends as x-cron-secret'
);

-- 4b. Schedule the job. The secret is fetched per run from the Vault view,
--     which only the postgres role (what pg_cron runs as) can read.
select cron.schedule(
    'chacevia-canvas-daily',
    '17 * * * *',
    $job$
    select net.http_post(
        url     := 'https://chacevia-backend.vercel.app/api/canvas-cron',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'x-cron-secret', (
                select decrypted_secret
                  from vault.decrypted_secrets
                 where name = 'chacevia_cron_secret'
            )
        ),
        body    := '{}'::jsonb
    );
    $job$
);

-- 4c. Verify — this is the one to read back. Confirms the job exists AND that
--     its command carries no literal secret.
select
    jobname,
    schedule,
    active,
    command like '%decrypted_secrets%'                as reads_from_vault,   -- want true
    command like '%' || 'x-cron-secret'' , ''%'       as has_inline_secret   -- want false
from cron.job
where jobname = 'chacevia-canvas-daily';

-- Did a run actually fire and get a 200 back? (after the next :17)
--   select id, status_code, created
--     from net._http_response
--    order by created desc limit 5;
--
-- To remove the job:      select cron.unschedule('chacevia-canvas-daily');
-- To read the secret:     select decrypted_secret from vault.decrypted_secrets
--                          where name = 'chacevia_cron_secret';
