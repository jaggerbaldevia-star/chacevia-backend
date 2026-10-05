-- Applied 2026-10-04 via Supabase MCP (Canvas full sync, step 4).
-- What the student's own screenshot said about a Canvas assignment, written
-- only when they confirm it. 'missing' puts it in the neutral "still open"
-- group. No scores or grades are stored anywhere.
alter table public.assignments
  add column if not exists canvas_state text check (canvas_state in ('submitted', 'graded', 'missing', 'not_submitted')),
  add column if not exists canvas_state_at timestamptz;
