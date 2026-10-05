-- Applied 2026-10-04 via Supabase MCP (Canvas full sync, steps 1-2).
-- Additive and nullable; nothing existing changes.
-- due_at: the real deadline instant for timed Canvas events (null for all-day
-- events and hand-made work). due_date keeps working exactly as before.
-- details: the teacher's description as plain text (~4000 chars max), kept
-- apart from notes, which is the student's own text.
alter table public.assignments
  add column if not exists due_at timestamptz,
  add column if not exists details text;
