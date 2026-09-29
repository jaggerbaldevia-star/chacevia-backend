-- canvas-dedupe.sql
-- DO NOT PASTE SECTION B UNTIL SECTION A's OUTPUT IS CHECKED.
--
-- Section A is read-only and diagnoses why "My classes" shows 16.
-- Section B moves homework off duplicate classes and deletes the duplicates.
-- It only ever touches rows where source = 'canvas' AND a non-Canvas class
-- with the same normalised name exists. If the 16 rows turn out to have some
-- other cause, Section B does nothing at all — which is the point of running A
-- first.

-- =====================================================================
-- A. WHY ARE THERE 16?  (read-only)
-- =====================================================================
-- match_key is the same normalisation the importer now uses: lowercased, with
-- Canvas's " - Teacher" tail removed. Two rows sharing a key are the same real
-- class.
select
    c.id,
    c.name,
    coalesce(c.source, 'manual')                                        as source,
    c.external_id,
    c.period,
    c.days,
    c.sort_order,
    lower(btrim(split_part(c.name, ' - ', 1)))                          as match_key,
    (select count(*) from public.assignments a where a.class_id = c.id) as assignments
from public.classes c
where c.user_id = (select id from auth.users
                    where email = 'jaggerbaldevia@seattleacademy.org')
order by match_key, source, c.name;

-- Same thing summarised: how many rows per real class, and how they split.
select
    lower(btrim(split_part(c.name, ' - ', 1)))                       as match_key,
    count(*)                                                          as rows,
    count(*) filter (where coalesce(c.source,'manual') = 'canvas')    as canvas_rows,
    count(*) filter (where coalesce(c.source,'manual') <> 'canvas')   as other_rows,
    string_agg(c.name || ' [p' || coalesce(c.period,'?') || ']', ' | ' order by c.name) as names
from public.classes c
where c.user_id = (select id from auth.users
                    where email = 'jaggerbaldevia@seattleacademy.org')
group by 1
order by rows desc, 1;

-- =====================================================================
-- B. MERGE  (writes — needs your yes)
-- =====================================================================
-- One transaction. Homework moves to the class you made, then the Canvas copy
-- is deleted. Nothing you created by hand is ever deleted: the delete is
-- restricted to source = 'canvas' rows that have a non-Canvas twin.

begin;

-- The pairs, computed once so the update and the delete can't disagree.
create temporary table canvas_merge_pairs on commit drop as
with mine as (
    select c.id, c.name, coalesce(c.source,'manual') as source,
           lower(btrim(split_part(c.name, ' - ', 1))) as match_key
    from public.classes c
    where c.user_id = (select id from auth.users
                        where email = 'jaggerbaldevia@seattleacademy.org')
),
keep as (
    -- The row to keep per key: the student's own, oldest first for stability.
    select distinct on (match_key) match_key, id as keep_id, name as keep_name
    from mine
    where source <> 'canvas'
    order by match_key, id
)
select d.id as drop_id, d.name as drop_name, k.keep_id, k.keep_name, k.match_key
from mine d
join keep k on k.match_key = d.match_key
where d.source = 'canvas'
  and d.id <> k.keep_id;

-- See exactly what is about to happen before the commit.
select * from canvas_merge_pairs;

update public.assignments a
   set class_id = p.keep_id
  from canvas_merge_pairs p
 where a.class_id = p.drop_id;

delete from public.classes c
 using canvas_merge_pairs p
 where c.id = p.drop_id;

commit;

-- Afterwards: should equal the number of classes you actually have.
select count(*) as classes_now
from public.classes
where user_id = (select id from auth.users
                  where email = 'jaggerbaldevia@seattleacademy.org');
