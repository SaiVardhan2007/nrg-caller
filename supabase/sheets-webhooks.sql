-- NRG Caller — outbound sync (Supabase -> Sheets).
-- Fires an async HTTP POST to the Apps Script Web App on every relevant
-- insert/update. The target URL is read from settings.apps_script_webhook_url
-- so it can be updated later without re-running this file.

create extension if not exists pg_net;

insert into settings (key, value) values ('apps_script_webhook_url', '')
on conflict (key) do nothing;

create or replace function notify_sheets_bridge() returns trigger language plpgsql as $$
declare
  webhook_url text;
begin
  select value into webhook_url from settings where key = 'apps_script_webhook_url';
  if webhook_url is null or webhook_url = '' then
    return coalesce(new, old);
  end if;

  perform net.http_post(
    url := webhook_url,
    body := jsonb_build_object('table', TG_TABLE_NAME, 'record', row_to_json(new)),
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 25000
  );
  return coalesce(new, old);
end $$;

drop trigger if exists trg_notify_users on users;
create trigger trg_notify_users after insert or update on users
  for each row execute function notify_sheets_bridge();

drop trigger if exists trg_notify_contacts on contacts;
create trigger trg_notify_contacts after insert or update on contacts
  for each row execute function notify_sheets_bridge();

drop trigger if exists trg_notify_settings on settings;
create trigger trg_notify_settings after insert or update on settings
  for each row execute function notify_sheets_bridge();

drop trigger if exists trg_notify_call_responses on call_responses;
create trigger trg_notify_call_responses after insert on call_responses
  for each row execute function notify_sheets_bridge();

drop trigger if exists trg_notify_session_attendance on session_attendance;
create trigger trg_notify_session_attendance after insert on session_attendance
  for each row execute function notify_sheets_bridge();

drop trigger if exists trg_notify_contact_collection on contact_collection;
create trigger trg_notify_contact_collection after insert on contact_collection
  for each row execute function notify_sheets_bridge();
