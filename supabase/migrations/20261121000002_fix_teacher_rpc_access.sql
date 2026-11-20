-- Fix: Allow teachers to use admin RPC functions
-- The admin_assignment_overview() and admin_list_sessions() functions check is_admin()
-- but teachers should also have access to these for the panel pages.

-- 1. Update admin_assignment_overview() to allow teachers
create or replace function public.admin_assignment_overview()
returns table (
  assignment_id uuid,
  attempt_count bigint,
  student_count bigint,
  pending_count bigint,
  graded_count bigint,
  flagged_count bigint,
  average_percent numeric,
  last_submission_at timestamptz,
  class_size bigint
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher_or_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with counts as (
    select s.assignment_id,
           count(*) as attempts,
           count(distinct s.student_id) as students,
           count(*) filter (where s.status = 'pending') as pending,
           count(*) filter (where s.status = 'graded') as graded,
           count(*) filter (where s.status = 'flagged') as flagged,
           max(s.created_at) as last_at
    from public.submissions s
    group by s.assignment_id
  ),
  best as (
    select s.assignment_id,
           s.student_id,
           max(coalesce(s.final_score, s.ai_score)) as best_score
    from public.submissions s
    where coalesce(s.final_score, s.ai_score) is not null
    group by s.assignment_id, s.student_id
  ),
  averages as (
    select b.assignment_id,
           round(avg(b.best_score / nullif(a.max_score, 0)) * 100, 1) as avg_percent
    from best b
    join public.assignments a on a.id = b.assignment_id
    group by b.assignment_id
  )
  select a.id,
         coalesce(c.attempts, 0),
         coalesce(c.students, 0),
         coalesce(c.pending, 0),
         coalesce(c.graded, 0),
         coalesce(c.flagged, 0),
         av.avg_percent,
         c.last_at,
         (select count(*) from public.profiles p where p.role = 'student') as class_size
  from public.assignments a
  left join counts c on c.assignment_id = a.id
  left join averages av on av.assignment_id = a.id
  order by a.deadline asc nulls last, a.created_at desc;
end;
$$;

-- 2. Update admin_list_sessions() to allow teachers
create or replace function public.admin_list_sessions()
returns table (
  id uuid,
  title text,
  session_date date,
  attendance_code text,
  code_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_teacher_or_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
    select s.id, s.title, s.session_date, s.attendance_code, s.code_expires_at
    from public.sessions s
    order by s.session_date desc, s.created_at desc;
end;
$$;

-- 3. Notify PostgREST to reload schema
notify pgrst, 'reload schema';