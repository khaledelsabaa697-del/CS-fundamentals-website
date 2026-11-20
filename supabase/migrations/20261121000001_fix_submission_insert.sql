-- Fix: Allow student submission inserts to work for both file and text submissions
-- Issues:
-- 1. file_path was NOT NULL but text submissions have no file
-- 2. Students couldn't insert submission_type (not in column grant) even though it has a default

-- 1. Make file_path nullable (text submissions don't have a file)
alter table public.submissions
  alter column file_path drop not null;

-- 2. Add submission_type to student insert grant (it has a default but code explicitly inserts it)
revoke insert on public.submissions from authenticated;
grant insert (assignment_id, student_id, file_path, code_text, submission_type) on public.submissions to authenticated;

-- 3. Notify PostgREST to reload schema
notify pgrst, 'reload schema';