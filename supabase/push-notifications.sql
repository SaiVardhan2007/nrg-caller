-- NRG Caller — Web Push notifications.
-- Mirrors sheets-webhooks.sql's pattern: DB trigger -> async HTTP POST to an
-- Edge Function (read from settings so the URL can change without re-running
-- this file). The Edge Function decides who to notify and sends the actual
-- push (it holds the VAPID private key; this file never does).

create extension if not exists pg_net;

-- One row per browser/device a user has granted notification permission on.
create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_name  text not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_subscriptions_user_name on push_subscriptions(user_name);

alter table push_subscriptions enable row level security;
drop policy if exists app_all on push_subscriptions;
create policy app_all on push_subscriptions for all to anon, authenticated using (true) with check (true);

insert into settings (key, value) values ('push_function_url', '')
on conflict (key) do nothing;

create or replace function notify_push_bridge() returns trigger language plpgsql as $$
declare
  push_url text;
begin
  select value into push_url from settings where key = 'push_function_url';
  if push_url is null or push_url = '' then
    return coalesce(new, old);
  end if;

  perform net.http_post(
    url := push_url,
    body := jsonb_build_object('table', TG_TABLE_NAME, 'record', row_to_json(new)),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  );
  return coalesce(new, old);
end $$;

-- Condition: user assigned a contact -> push that caller.
-- STATEMENT-level (not ROW-level): admin.js always assigns as one bulk
-- multi-row INSERT (e.g. 204 contacts to one caller in a single "Assign"
-- click), so a ROW trigger fired once per row -> one push per contact.
-- This groups every row from that one INSERT by user_name via the
-- transition table, so a 204-row bulk assign sends exactly one push per
-- affected caller (with a count), not one per row.
create or replace function notify_push_assignments_batch() returns trigger language plpgsql as $$
declare
  push_url text;
  groups   jsonb;
begin
  select value into push_url from settings where key = 'push_function_url';
  if push_url is null or push_url = '' then
    return null;
  end if;

  select jsonb_agg(jsonb_build_object('user_name', user_name, 'count', cnt))
    into groups
  from (select user_name, count(*) as cnt from inserted group by user_name) g;

  if groups is null then
    return null;
  end if;

  perform net.http_post(
    url := push_url,
    body := jsonb_build_object('table', 'assignments', 'groups', groups),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  );
  return null;
end $$;

drop trigger if exists trg_push_assignments on assignments;
create trigger trg_push_assignments after insert on assignments
  referencing new table as inserted
  for each statement execute function notify_push_assignments_batch();

-- Condition: contact submits a One to One question -> push the admin(s).
drop trigger if exists trg_push_help_requests on help_requests;
create trigger trg_push_help_requests after insert on help_requests
  for each row execute function notify_push_bridge();
