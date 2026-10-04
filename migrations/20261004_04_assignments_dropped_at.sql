-- Applied 2026-10-04 via Supabase MCP (research-hardening item 4).
-- "Drop it": stored as done = true plus this timestamp, so every older reader
-- (build 6, Focus Mode, the reminder dispatcher) already treats it as
-- finished, while metrics can still tell "did it" from "dropped it".
alter table public.assignments add column if not exists dropped_at timestamptz;
