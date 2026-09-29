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
-- the x-cron-secret header, so CRON_SECRET must be set in Vercel first.
--
-- Replace <CRON_SECRET> below with the same value you put in Vercel. If you'd
-- rather that secret not sit in cron.job's command text, say so and I'll switch
-- this to read it from a settings table instead.
--
-- Requires pg_cron and pg_net. Your earlier query tells us whether they're
-- already installed — if not, this needs the Supabase dashboard's Database →
-- Extensions first.
select cron.schedule(
    'chacevia-canvas-daily',
    '17 * * * *',
    $job$
    select net.http_post(
        url     := 'https://chacevia-backend.vercel.app/api/canvas-cron',
        headers := jsonb_build_object(
            'Content-Type',  'application/json',
            'x-cron-secret', '<CRON_SECRET>'
        ),
        body    := '{}'::jsonb
    );
    $job$
);

-- To verify afterwards:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'chacevia-canvas-daily';
-- To remove it:
--   select cron.unschedule('chacevia-canvas-daily');
