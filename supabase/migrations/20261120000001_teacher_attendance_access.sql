-- Fix: Allow teachers (not just admins) to view/manage attendance
-- The page uses requireTeacher() but RLS only allowed admins via is_admin()

-- 1. Create helper function: checks if user is admin OR teacher
create or replace function public.is_teacher_or_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role in ('admin'::public.user_role, 'teacher'::public.user_role)
  );
$$;

revoke all on function public.is_teacher_or_admin() from public;
grant execute on function public.is_teacher_or_admin() to authenticated;

-- 2. Update attendance SELECT policy (was: attendance_admin_select_all)
drop policy if exists "attendance_admin_select_all" on public.attendance;
create policy "attendance_staff_select_all" on public.attendance
  for select to authenticated
  using (public.is_teacher_or_admin());

-- 3. Update attendance INSERT policy (was: attendance_admin_insert)
drop policy if exists "attendance_admin_insert" on public.attendance;
create policy "attendance_staff_insert" on public.attendance
  for insert to authenticated
  with check (public.is_teacher_or_admin());

-- 4. Update attendance UPDATE policy (was: attendance_admin_update)
drop policy if exists "attendance_admin_update" on public.attendance;
create policy "attendance_staff_update" on public.attendance
  for update to authenticated
  using (public.is_teacher_or_admin())
  with check (public.is_teacher_or_admin());

-- 5. Update attendance DELETE policy (was: attendance_admin_delete)
drop policy if exists "attendance_admin_delete" on public.attendance;
create policy "attendance_staff_delete" on public.attendance
  for delete to authenticated
  using (public.is_teacher_or_admin());

-- 6. Also fix sessions policies for consistency (teachers should manage sessions too)
drop policy if exists "sessions_admin_insert" on public.sessions;
create policy "sessions_staff_insert" on public.sessions
  for insert to authenticated
  with check (public.is_teacher_or_admin());

drop policy if exists "sessions_admin_update" on public.sessions;
create policy "sessions_staff_update" on public.sessions
  for update to authenticated
  using (public.is_teacher_or_admin())
  with check (public.is_teacher_or_admin());

drop policy if exists "sessions_admin_delete" on public.sessions;
create policy "sessions_staff_delete" on public.sessions
  for delete to authenticated
  using (public.is_teacher_or_admin());