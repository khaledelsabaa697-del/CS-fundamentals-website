-- Fix: Allow anon to look up email by username for login flow
-- The login flow needs to convert username -> email before calling signInWithPassword,
-- but RLS on profiles blocks anon from reading the email column.
-- This SECURITY DEFINER function runs with elevated privileges and returns only the email.

-- 1. Create a unique index on lower(username) for fast case-insensitive lookups
-- (username is already constrained to lowercase, but this ensures no case-duplicates exist)
do $$
begin
  if not exists (
    select 1 from pg_indexes where indexname = 'profiles_username_lower_idx'
  ) then
    create unique index profiles_username_lower_idx on public.profiles (lower(username));
  end if;
exception when duplicate_object then null;
end $$;

-- 2. Create the lookup function
create or replace function public.get_email_by_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select email
  from public.profiles
  where lower(username) = lower(trim(p_username))
  limit 1;
$$;

-- 3. Revoke from public, grant only to anon and authenticated
revoke all on function public.get_email_by_username(text) from public;
grant execute on function public.get_email_by_username(text) to anon, authenticated;

-- 4. Notify PostgREST to reload schema
notify pgrst, 'reload schema';