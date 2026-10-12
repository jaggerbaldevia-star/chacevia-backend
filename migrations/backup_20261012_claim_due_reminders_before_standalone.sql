-- BACKUP (2026-10-12): claim_due_reminders() exactly as it was in production
-- before migrations/20261012_01_standalone_reminders.sql was applied.
-- To roll back the function: run this file. (Rolling back the table change
-- would also need: delete standalone rows, then
--   alter table public.reminders alter column assignment_id set not null;)
CREATE OR REPLACE FUNCTION public.claim_due_reminders()
 RETURNS TABLE(r_id uuid, r_user uuid, r_assignment uuid, r_title text, r_short text, r_due date, r_done boolean, r_class uuid, r_class_name text, r_class_short text, r_period text, r_days_before integer, r_user_set boolean, r_fire timestamp with time zone, r_tz text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with due as (
    select r.id, r.user_id, r.assignment_id, a.title, a.short_title, a.due_date, a.done,
           a.class_id, c.name as class_name, c.short_name, c.period, r.days_before, r.user_set,
           coalesce(
             r.fire_at,
             ((a.due_date - r.days_before) + r.time_of_day::time)
               at time zone coalesce(nullif(np.tz, ''), nullif(s.timezone, ''), 'UTC')
           ) as fire_time,
           coalesce(nullif(np.tz, ''), nullif(s.timezone, ''), 'UTC') as tz
      from public.reminders r
      join public.assignments a on a.id = r.assignment_id
      left join public.classes c on c.id = a.class_id
      left join public.streaks s on s.user_id = r.user_id
      left join public.notification_prefs np on np.user_id = r.user_id
     where r.sent_at is null
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
