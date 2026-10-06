-- Stale Canvas work. The feed can't see work turned in on paper, so:
--   done_source  why something is done when the student didn't tick it:
--                'canvas_backfill' (already past due when Canvas was connected),
--                'canvas_auto' (asked "did you turn it in?", no answer in 3 days),
--                'clear_old' ("Clear all old" in Still open). Null = ticked by hand.
--                Undoing any of them is done=false + done_source=null.
--   done_at      when it became done that way (for the review list / undo).
--   turnin_asked_at      first time Rocco asked "Did you turn in X?" (client sets it).
--   turnin_snooze_until  "Still working" → don't ask again before this.
-- `source` stays 'canvas': the sync owns that column and re-writes it each run.
alter table public.assignments add column if not exists done_source text;
alter table public.assignments add column if not exists done_at timestamptz;
alter table public.assignments add column if not exists turnin_asked_at timestamptz;
alter table public.assignments add column if not exists turnin_snooze_until timestamptz;

do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'assignments_done_source_check') then
        alter table public.assignments add constraint assignments_done_source_check
            check (done_source is null or done_source in ('canvas_backfill', 'canvas_auto', 'clear_old'));
    end if;
end $$;

-- The hourly auto-done sweep looks for asked-but-unanswered Canvas work.
create index if not exists assignments_turnin_asked_idx
    on public.assignments (turnin_asked_at) where turnin_asked_at is not null and done = false;
