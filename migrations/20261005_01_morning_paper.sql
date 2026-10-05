-- The Morning Paper.
--
-- daily_news: one row per edition, shared by everyone. Real headlines from
-- public sources, summarised from what the source says, with a dithered
-- illustration each. Server-only: RLS on, no policies (like canvas_links).
--
-- daily_papers: one row per student per local day, built at 4:30am their time
-- so the paper opens instantly. A student reads only their own rows; only the
-- server writes. Deleting the account deletes the papers (cascade).

create table if not exists public.daily_news (
    edition date primary key,
    stories jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now()
);
alter table public.daily_news enable row level security;

create table if not exists public.daily_papers (
    user_id uuid not null references auth.users (id) on delete cascade,
    local_date date not null,
    content jsonb not null,
    created_at timestamptz not null default now(),
    primary key (user_id, local_date)
);
alter table public.daily_papers enable row level security;

drop policy if exists "read own papers" on public.daily_papers;
create policy "read own papers" on public.daily_papers
    for select to authenticated
    using ((select auth.uid()) = user_id);
