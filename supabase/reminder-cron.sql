-- Minute-level reminder trigger for a Vercel Hobby project.
--
-- Why this file exists
--   Vercel Hobby only accepts cron expressions that run once per day, so the deployment
--   cannot drive /api/send-due-notifications every minute. This schedules the same call
--   from Supabase instead, which works on the free plan.
--
-- How to use it
--   1. Enable the extensions: Supabase → Database → Extensions → pg_cron and pg_net
--      (or just run the create extension lines below).
--   2. This project uses https://everything-app-zeta.vercel.app and does not currently
--      use CRON_SECRET, so the request below intentionally has no Authorization header.
--   3. Run this whole file in the Supabase SQL editor. Safe to re-run: the old schedule
--      with the same name is removed first.
--
-- Checking it later
--   select jobid, jobname, schedule, active from cron.job;
--   select status_code, content from net._http_response order by created desc limit 5;
--   select cron.unschedule('everything-reminders');   -- to stop it

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'everything-reminders') then
    perform cron.unschedule('everything-reminders');
  end if;
end
$$;

select cron.schedule(
  'everything-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://everything-app-zeta.vercel.app/api/send-due-notifications',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  $$
);
