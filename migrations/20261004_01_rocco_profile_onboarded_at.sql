-- Applied 2026-10-04 via Supabase MCP (research-hardening item 1).
-- When this user finished (or skipped through) first-run onboarding.
-- Null means "not yet". Only accounts created after the onboarding launch are
-- walked through it (ONBOARDING_SINCE in the Framer component); existing
-- users' rows are not touched.
alter table public.rocco_profile
  add column if not exists onboarded_at timestamptz;
