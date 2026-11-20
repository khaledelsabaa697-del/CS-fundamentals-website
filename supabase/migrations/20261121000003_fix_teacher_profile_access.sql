-- Fix: Allow teachers to read student profiles for attendance recording
-- The profiles table only allows admins to read all rows, but teachers need this too.

-- 1. Drop both old and new policy names if they exist
drop policy if exists "profiles_admin_select_all" on public.profiles;
drop policy if exists "profiles_staff_select_all" on public.profiles;

-- 2. Create the updated policy for teachers + admins
create policy "profiles_staff_select_all" on public.profiles
  for select to authenticated
  using (public.is_teacher_or_admin());

-- 3. Notify PostgREST to reload schema
notify pgrst, 'reload schema';