-- Lightweight, weekly-rotated activity log — records section visits and a
-- few high-stakes write actions (call submissions) so an admin can review
-- usage patterns after the fact and confirm nothing was silently lost.
--
-- Deliberately NOT added to the supabase_realtime publication — it must
-- never trigger a realtime broadcast to every open session the way
-- assignments/follow_up_assignments do.
--
-- The client batches events and flushes them in one insert every ~25s (see
-- app/js/activityLog.js), so this table's write volume is far lower than
-- "one row per click" would suggest. The weekly-activity-report Edge
-- Function (supabase/functions/weekly-activity-report) reads this table
-- once a week, emails a summary + any submissions it couldn't cross-check
-- against call_responses, then deletes the rows it processed — this table
-- is meant to stay small, not accumulate.

create table if not exists activity_log (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  user_name  text not null,
  role       text,
  session_id text,          -- groups one app load's events together
  action     text not null, -- e.g. 'nav_section', 'submit_call'
  section    text,          -- which screen this happened in
  target     text,          -- short label, e.g. an assignment/contact id
  meta       jsonb          -- small structured extra info, not full row payloads
);

create index if not exists activity_log_ts_idx on activity_log (ts);
create index if not exists activity_log_user_ts_idx on activity_log (user_name, ts);

-- Every other table in this app uses a single permissive "app_all" policy
-- (schema.sql) since authorization is handled client-side by the custom
-- login system, not RLS. This table is deliberately narrower — insert-only
-- for the anon key, so a compromised client can add noise but can never read
-- back, edit, or delete the log. The weekly Edge Function reads/deletes using
-- the service-role key, which bypasses RLS entirely, so no read/delete
-- policy is needed for that side.
alter table activity_log enable row level security;

drop policy if exists activity_log_insert_only on activity_log;
create policy activity_log_insert_only on activity_log
  for insert
  to anon, authenticated
  with check (true);
