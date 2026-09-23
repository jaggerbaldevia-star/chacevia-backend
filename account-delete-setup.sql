-- ============================================================================
--  Chacevia — make purchase records survive account deletion
--  Run in Supabase → SQL Editor. Safe to re-run.
--
--  purchases.user_id was created as:
--      user_id uuid not null references auth.users(id) on delete cascade
--
--  Both halves of that are a problem for account deletion:
--
--    on delete cascade — deleting the auth user takes the payment records with
--      it. The privacy policy says purchase records are retained for
--      accounting, and they are also what makes a later refund or chargeback
--      reconcilable against Stripe.
--
--    not null — so the row cannot simply be detached from the person.
--
--  api/account.js nulls user_id itself before deleting the auth user, so it
--  does not depend on the constraint being migrated. This makes the database
--  agree with that intent rather than quietly undoing it: with `set null`, a
--  user deleted by any other route (the Supabase dashboard, a future admin
--  tool) also leaves the records behind instead of erasing them.
-- ============================================================================


-- ── 0. Preflight ────────────────────────────────────────────────────────────
do $preflight$
begin
  if to_regclass('public.purchases') is null then
    raise exception 'No public.purchases table. Run pro-setup.sql first.';
  end if;
  raise notice 'purchases found — migrating the auth.users foreign key.';
end
$preflight$;


-- ── 1. Let a purchase outlive its buyer ─────────────────────────────────────
alter table public.purchases alter column user_id drop not null;


-- ── 2. Swap cascade for set null ────────────────────────────────────────────
-- The constraint name is whatever Postgres generated, so it is looked up
-- rather than assumed: a hardcoded purchases_user_id_fkey would silently match
-- nothing if this table was ever created by hand.
do $fk$
declare
  v_name text;
begin
  select con.conname
    into v_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'purchases'
     and con.contype = 'f'
     and con.confrelid = 'auth.users'::regclass
   limit 1;

  if v_name is null then
    raise notice 'No foreign key from purchases to auth.users — nothing to swap.';
  else
    execute format('alter table public.purchases drop constraint %I', v_name);
    raise notice 'Dropped %', v_name;
  end if;

  alter table public.purchases
    add constraint purchases_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete set null;

  raise notice 'purchases.user_id now ON DELETE SET NULL.';
end
$fk$;


-- ── 3. Verify ───────────────────────────────────────────────────────────────
-- confdeltype should be 'n' (set null). 'c' means cascade and this didn't take.
--   select con.conname, con.confdeltype
--     from pg_constraint con
--     join pg_class rel on rel.oid = con.conrelid
--    where rel.relname = 'purchases' and con.contype = 'f';
--
-- Should be 'YES':
--   select is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'purchases'
--      and column_name = 'user_id';
