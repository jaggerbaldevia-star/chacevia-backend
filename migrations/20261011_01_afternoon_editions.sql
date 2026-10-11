-- Afternoon Edition history (1.2, Phase 2). FILE ONLY: not applied yet.
--
-- One row per recap the student kept: the finished newspaper page for one
-- class period. Phase 1 keeps editions on the phone only; this table is for
-- the history view later.
--
-- There is deliberately NO transcript column. The transcript lives only in the
-- app's private files and is never stored on the server.
--
-- Additive and re-runnable. A student reads only their own rows; only the
-- server (service role) writes. Deleting the account or the class deletes the
-- editions (cascade), matching "delete this class" in the app.

create table if not exists public.afternoon_editions (
    user_id uuid not null references auth.users (id) on delete cascade,
    -- The app makes the edition id; it is unique per student, not globally.
    id text not null check (char_length(id) between 1 and 64),
    class_id uuid references public.classes (id) on delete cascade,
    date date not null,
    recap jsonb not null,
    created_at timestamptz not null default now(),
    primary key (user_id, id)
);

create index if not exists afternoon_editions_user_date_idx
    on public.afternoon_editions (user_id, date desc);

alter table public.afternoon_editions enable row level security;

do $$ begin
    if not exists (select 1 from pg_policies where schemaname = 'public'
                     and tablename = 'afternoon_editions' and policyname = 'read own afternoon editions') then
        create policy "read own afternoon editions" on public.afternoon_editions
            for select to authenticated
            using ((select auth.uid()) = user_id);
    end if;
end $$;
