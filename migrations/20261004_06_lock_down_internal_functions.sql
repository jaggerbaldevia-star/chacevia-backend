-- Applied 2026-10-04 via Supabase MCP (Jagger approved).
-- Supabase advisor: internal trigger/maintenance functions must not be
-- callable through the REST API. Triggers don't check EXECUTE when they fire,
-- so sign-up (handle_new_user) and auto-RLS (rls_auto_enable) keep working.
-- service_role keeps access.
revoke execute on function public.prune_cache()     from public, anon, authenticated;
revoke execute on function public.prune_usage()     from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
