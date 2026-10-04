-- Applied 2026-10-04 via Supabase MCP (research-hardening item 3).
-- See the migration of the same name in Supabase for the exact text; this
-- copy is the record in the repo.

alter table public.reminders
  add column if not exists user_set boolean not null default false,
  add column if not exists fire_at timestamptz;

create table if not exists public.notification_prefs (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  daily_cap     smallint not null default 4 check (daily_cap between 1 and 12),
  after_class   text not null default 'off' check (after_class in ('off', 'each', 'after_school')),
  paused        boolean not null default false,
  paused_at     timestamptz,
  last_seen_at  timestamptz,
  tz            text,
  updated_at    timestamptz not null default now()
);
alter table public.notification_prefs enable row level security;
create policy "own prefs select" on public.notification_prefs for select using (auth.uid() = user_id);
create policy "own prefs insert" on public.notification_prefs for insert with check (auth.uid() = user_id);
create policy "own prefs update" on public.notification_prefs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.notification_log (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('reminder', 'after-class', 'sign-off')),
  reminder_id   uuid,
  assignment_id uuid,
  class_id      uuid,
  template      text,
  body          text,
  local_date    date not null,
  status        text not null default 'sent',
  dedupe_key    text,
  sent_at       timestamptz not null default now(),
  opened_at     timestamptz,
  action        text
);
create index if not exists notification_log_user_sent_idx on public.notification_log (user_id, sent_at desc);
create unique index if not exists notification_log_dedupe_uniq on public.notification_log (user_id, dedupe_key) where dedupe_key is not null;
alter table public.notification_log enable row level security;
create policy "own log select" on public.notification_log for select using (auth.uid() = user_id);

-- touch_activity(p_tz), mark_notification_opened(p_log_id, p_action) and
-- claim_due_reminders() — security definer functions; see Supabase.
