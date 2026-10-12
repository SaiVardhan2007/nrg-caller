-- NRG Caller — exact-time trigger for the daily full-DB backup email.
--
-- Why: Vercel's cron on the Hobby plan only guarantees the scheduled HOUR
-- ("0 15 * * *" may fire any minute between 15:00 and 15:59 UTC), so the
-- email arrived at a random time after 8:30 PM IST. pg_cron fires to the
-- minute. app/api/cron/db-export.js skips if a backup went out in the last
-- 12h, so leaving the Vercel cron in place as a fallback will NOT double-send.
--
-- BEFORE RUNNING: replace PASTE_CRON_SECRET_HERE with the same value as the
-- CRON_SECRET env var in Vercel, and check the URL is your production domain.
-- pg_cron / pg_net are already enabled on this project.

do $$ begin
  perform cron.unschedule('daily_db_export');
exception when others then null;
end $$;

select cron.schedule(
  'daily_db_export',
  '0 15 * * *',   -- 15:00 UTC = 20:30 IST (pg_cron runs in UTC)
  $job$
  select net.http_get(
    url := 'https://nrg-caller.vercel.app/api/cron/db-export',
    headers := jsonb_build_object('Authorization', 'Bearer PASTE_CRON_SECRET_HERE'),
    timeout_milliseconds := 60000
  );
  $job$
);
