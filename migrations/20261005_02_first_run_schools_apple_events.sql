-- First-run overhaul (backend). Additive only.
--
-- schools: school name/region <-> Canvas HOST (never a feed URL, never who is
--   there). Server-only: RLS on, no policies, like canvas_links. match_key is
--   the same idea as the draft ~/Desktop/chacevia-schools.sql, with name and
--   region kept apart by '|'; api/_schools.js schoolMatchKey must match it.
-- apple_tokens: the sealed Sign in with Apple refresh token (api/_canvas.js
--   sealSecret — same AES-GCM key as Canvas feed links), so account deletion
--   can revoke it with Apple. Server-only, cascades with the account.
-- events: the new first-run event names.
-- analytics.activation_summary: two new columns on the end (install -> home,
--   install -> first assignment), existing columns unchanged.

create table if not exists public.schools (
    id          uuid primary key default gen_random_uuid(),
    name        text not null check (char_length(name) between 3 and 120),
    region      text check (region is null or char_length(region) <= 80),
    match_key   text generated always as (
                    lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]+', '', 'g'))
                    || '|' ||
                    lower(regexp_replace(coalesce(region, ''), '[^a-zA-Z0-9]+', '', 'g'))
                ) stored,
    canvas_host text check (canvas_host is null or char_length(canvas_host) <= 253),
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);
create unique index if not exists schools_match_key_idx on public.schools (match_key);
alter table public.schools enable row level security;

create table if not exists public.apple_tokens (
    user_id           uuid primary key references auth.users (id) on delete cascade,
    refresh_token_enc text not null,
    created_at        timestamptz not null default now()
);
alter table public.apple_tokens enable row level security;

-- A check constraint can't be altered in place; replace it in one statement so
-- there is no moment without it. Only ADDS allowed names.
do $$
begin
    if exists (select 1 from pg_constraint
                where conrelid = 'public.events'::regclass
                  and conname = 'events_name_check'
                  and pg_get_constraintdef(oid) not like '%home_reached%') then
        execute $sql$
            alter table public.events
                drop constraint events_name_check,
                add constraint events_name_check check (name in (
                    'app_open', 'onboarding_started', 'schedule_imported',
                    'first_assignment_created', 'notification_permission',
                    'assignment_created', 'assignment_completed', 'reminder_tapped',
                    'signed_in', 'tutorial_step', 'tutorial_done',
                    'canvas_connected', 'home_reached'))
        $sql$;
    end if;
end $$;

-- Existing columns verbatim, two appended. Each user's FIRST event of that
-- name, with props.seconds_since_install a number (null = unknown install time).
create or replace view analytics.activation_summary as
select count(*) as users,
    round(100.0 * avg(case when assignment_day1 then 1 else 0 end), 1) as pct_assignment_day1,
    percentile_cont(0.5::double precision) within group (order by (secs_to_first_assignment::double precision))
        filter (where secs_to_first_assignment is not null) as median_secs_to_first_assignment,
    round(100.0 * avg(case when returned_d1 then 1 else 0 end) filter (where d1_measurable), 1) as pct_return_d1,
    round(100.0 * avg(case when returned_d7 then 1 else 0 end) filter (where d7_measurable), 1) as pct_return_d7,
    count(*) filter (where d1_measurable) as d1_cohort,
    count(*) filter (where d7_measurable) as d7_cohort,
    (select percentile_cont(0.5) within group (order by x.s)
       from (select distinct on (e.user_id) (e.props ->> 'seconds_since_install')::double precision as s
               from public.events e
              where e.name = 'home_reached'
                and jsonb_typeof(e.props -> 'seconds_since_install') = 'number'
              order by e.user_id, e.created_at) x) as median_secs_install_to_home,
    (select percentile_cont(0.5) within group (order by x.s)
       from (select distinct on (e.user_id) (e.props ->> 'seconds_since_install')::double precision as s
               from public.events e
              where e.name = 'first_assignment_created'
                and jsonb_typeof(e.props -> 'seconds_since_install') = 'number'
              order by e.user_id, e.created_at) x) as median_secs_install_to_first_assignment
from analytics.user_activation;
