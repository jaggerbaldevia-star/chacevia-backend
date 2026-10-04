-- Applied 2026-10-04 via Supabase MCP (research-hardening item 9).
-- Product events (insert-only for students) and admin-only activation views.
--   select * from analytics.activation_summary;   -- the four numbers
--   select * from analytics.user_activation;      -- one row per user

create table if not exists public.events (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null check (name in (
                'app_open', 'onboarding_started', 'schedule_imported',
                'first_assignment_created', 'notification_permission',
                'assignment_created', 'assignment_completed', 'reminder_tapped')),
  props       jsonb not null default '{}'::jsonb,
  client_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists events_name_time_idx on public.events (name, created_at);
create index if not exists events_user_time_idx on public.events (user_id, created_at);
alter table public.events enable row level security;
create policy "insert own events" on public.events for insert to authenticated
  with check (auth.uid() = user_id);

create schema if not exists analytics;
revoke all on schema analytics from public, anon, authenticated;

-- analytics.user_activation and analytics.activation_summary: see Supabase
-- (migration "events_and_activation_metrics") for the full view text.
-- Activity days = app_open events ∪ daily check-ins ∪ assignment creation,
-- so accounts from before events existed still count. Day-1/day-7 rates only
-- include users old enough to have had that day.
