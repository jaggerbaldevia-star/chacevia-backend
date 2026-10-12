-- Standalone reminders ("remind me to sharpen my pencil during lunch").
-- NOT APPLIED — Jagger runs this himself (Supabase dashboard → SQL editor).
--
-- Today every reminder must belong to an assignment (assignment_id NOT NULL)
-- and the scheduler (claim_due_reminders) INNER JOINs assignments. This lets a
-- reminder stand on its own: a title + an exact fire_at, optionally a class.
-- Existing reminders are untouched and behave exactly as before.

begin;

-- 1. A reminder no longer needs an assignment.
alter table public.reminders alter column assignment_id drop not null;

-- 2. What a standalone reminder says, and (optionally) which class it's about.
alter table public.reminders add column if not exists title text;
alter table public.reminders add column if not exists class_id uuid references public.classes(id) on delete set null;

-- 3. Either it belongs to an assignment, or it has its own title and exact time.
do $$ begin
    if not exists (select 1 from pg_constraint where conname = 'reminders_standalone_shape') then
        alter table public.reminders add constraint reminders_standalone_shape
            check (assignment_id is not null
                   or (title is not null and length(btrim(title)) between 1 and 200 and fire_at is not null));
    end if;
end $$;

-- 4. The scheduler: LEFT JOIN assignments so standalone reminders are claimed
--    too. Same return columns as before (the dispatcher reads them by name):
--    for a standalone reminder r_assignment and r_due are null, r_title is the
--    reminder's own title, r_done is false, and the class comes from the
--    reminder itself.
create or replace function public.claim_due_reminders()
 returns table(r_id uuid, r_user uuid, r_assignment uuid, r_title text, r_short text, r_due date, r_done boolean, r_class uuid, r_class_name text, r_class_short text, r_period text, r_days_before integer, r_user_set boolean, r_fire timestamp with time zone, r_tz text)
 language sql
 security definer
 set search_path to 'public'
as $function$
  with due as (
    select r.id, r.user_id, r.assignment_id,
           coalesce(a.title, r.title) as title,
           a.short_title,
           a.due_date,
           coalesce(a.done, false) as done,
           coalesce(a.class_id, r.class_id) as class_id,
           c.name as class_name, c.short_name, c.period, r.days_before, r.user_set,
           coalesce(
             r.fire_at,
             ((a.due_date - r.days_before) + r.time_of_day::time)
               at time zone coalesce(nullif(np.tz, ''), nullif(s.timezone, ''), 'UTC')
           ) as fire_time,
           coalesce(nullif(np.tz, ''), nullif(s.timezone, ''), 'UTC') as tz
      from public.reminders r
      left join public.assignments a on a.id = r.assignment_id
      left join public.classes c on c.id = coalesce(a.class_id, r.class_id)
      left join public.streaks s on s.user_id = r.user_id
      left join public.notification_prefs np on np.user_id = r.user_id
     where r.sent_at is null
       and (r.assignment_id is null or a.id is not null)   -- an assignment reminder whose assignment is gone is skipped, as before
       and (r.fire_at is not null
            or (a.due_date is not null and r.time_of_day ~ '^[0-9]{1,2}:[0-9]{2}$'))
  ),
  claimed as (
    update public.reminders t
       set sent_at = now()
      from due
     where t.id = due.id
       and t.sent_at is null
       and due.fire_time <= now()
    returning t.id
  )
  select due.id, due.user_id, due.assignment_id, due.title, due.short_title, due.due_date,
         due.done, due.class_id, due.class_name, due.short_name, due.period, due.days_before,
         due.user_set, due.fire_time, due.tz
    from due join claimed on claimed.id = due.id
   order by due.fire_time;
$function$;

commit;
