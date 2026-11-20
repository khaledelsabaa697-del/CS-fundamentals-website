-- Fix: Allow student submission inserts to work for both file and text submissions
-- This migration is self-contained and includes all required columns from the text_submission migration

-- 1. Create submission_type enum if not exists
do $$ begin
  create type public.submission_type as enum ('file', 'text');
exception when duplicate_object then null; end $$;

-- 2. Create allowed_submission_types enum if not exists
do $$ begin
  create type public.allowed_submission_types as enum ('file', 'text', 'both');
exception when duplicate_object then null; end $$;

-- 3. Add submission_type column to submissions table if not exists
alter table public.submissions
  add column if not exists submission_type public.submission_type not null default 'file';

-- 4. Ensure code_text exists (may already exist from earlier migrations)
alter table public.submissions
  add column if not exists code_text text;

-- 5. Make file_path nullable (text submissions have no file)
alter table public.submissions
  alter column file_path drop not null;

-- 6. Add allowed_submission_types to assignments table if not exists
alter table public.assignments
  add column if not exists allowed_submission_types public.allowed_submission_types not null default 'both';

-- 7. Add submission_type to student insert grant (code explicitly inserts it)
revoke insert on public.submissions from authenticated;
grant insert (assignment_id, student_id, file_path, code_text, submission_type) on public.submissions to authenticated;

-- 7. Backfill existing submissions
update public.submissions
set submission_type = 'file'
where submission_type is null;

-- 8. Notify PostgREST to reload schema
notify pgrst, 'reload schema';