-- Applied 2026-10-04 via Supabase MCP (research-hardening item 2).
-- Quick add: optional notes and type behind "more", and repeating
-- assignments ("every Monday" / "every time this class meets").

alter table public.assignments
  add column if not exists notes text,
  add column if not exists kind text,
  add column if not exists series_id uuid;

create table if not exists public.assignment_series (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  class_id    uuid references public.classes(id) on delete set null,
  title       text not null,
  kind        text,
  notes       text,
  rule        text not null check (rule in ('weekly', 'class')),
  weekday     smallint check (weekday between 0 and 6),
  reminders   jsonb not null default '[]'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.assignments
  drop constraint if exists assignments_series_id_fkey,
  add constraint assignments_series_id_fkey
    foreign key (series_id) references public.assignment_series(id) on delete set null;

create unique index if not exists assignments_series_due_uniq
  on public.assignments (series_id, due_date) where series_id is not null;
create index if not exists assignment_series_user_idx on public.assignment_series (user_id) where active;

alter table public.assignment_series enable row level security;
create policy "own series select" on public.assignment_series for select using (auth.uid() = user_id);
create policy "own series insert" on public.assignment_series for insert with check (auth.uid() = user_id);
create policy "own series update" on public.assignment_series for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own series delete" on public.assignment_series for delete using (auth.uid() = user_id);
