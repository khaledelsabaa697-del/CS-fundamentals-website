-- Fix: Allow teachers to read student profiles for attendance recording
-- The profiles table only allows admins to read all rows, but teachers need this too.

-- 1. Update profiles SELECT policy for admins/teachers
drop policy if exists "profiles_admin_select_all" on public.profiles;
create policy "profiles_staff_select_all" on public.profiles
  for select to authenticated
  using (public.is_teacher_or_admin());

-- 2. Also ensure teachers can read all profiles (for student management, etc.)
-- The column-level grant already allows select, but RLS policy was blocking it.

-- 3. Notify PostgREST to reload schema
notify pgrst, 'reload schema';