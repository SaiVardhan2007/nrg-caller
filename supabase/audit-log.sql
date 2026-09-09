-- Security audit trail — records every insert/update/delete on the app's
-- data tables: who did it, from what IP, and exactly what changed. This is
-- separate from activity_log.sql (which logs UI navigation/usage for the
-- weekly review) — this table exists purely for after-the-fact forensics
-- ("what did user1 add/edit/delete yesterday", "did anyone log in as
-- someone else and touch data") and is never read by the app itself.
--
-- Actor identification: this app authenticates with a custom users table,
-- not Supabase Auth, so Postgres has no built-in notion of "who's calling".
-- The client (see app/js/supabaseClient.js) sends the logged-in user's id
-- on every request as the `x-app-user` header, which this trigger reads
-- straight off the request. That id is self-reported by the client (same
-- trust model as activity_log.user_name already had) so it can be spoofed
-- by anyone who knows another user's password — but the IP address below
-- comes from the network layer (Supabase's edge sets x-forwarded-for on
-- every request) and can't be spoofed by app code, so a mismatch between
-- the claimed user and their usual IP is the actual tell.
--
-- No one can read this table through the app (see RLS below) — only a
-- direct DB connection (the pooler) can query it. Rows older than 10 days
-- are purged automatically by the pg_cron job at the bottom.

create table if not exists audit_log (
  id         bigint generated always as identity primary key,
  ts         timestamptz not null default now(),
  table_name text not null,
  op         text not null,          -- INSERT / UPDATE / DELETE
  row_pk     text,                   -- affected row's id (or best-effort key), as text
  actor_id   text,                   -- users.id claimed by the client via x-app-user — spoofable
  actor_ip   text,                   -- x-forwarded-for from Supabase's edge — not spoofable by the app
  changes    jsonb                   -- INSERT/DELETE: full row; UPDATE: {col: {old,new}} for changed cols only
);

create index if not exists audit_log_ts_idx        on audit_log (ts);
create index if not exists audit_log_table_ts_idx   on audit_log (table_name, ts);
create index if not exists audit_log_actor_ts_idx   on audit_log (actor_id, ts);

-- RLS enabled with zero policies: anon/authenticated get no select, insert,
-- update, or delete via the API at all. Only the SECURITY DEFINER trigger
-- function below (which runs as the table owner, bypassing RLS) can write,
-- and only a direct DB connection can read.
alter table audit_log enable row level security;

-- ============ CAPTURE TRIGGER ============

create or replace function audit_log_capture() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  headers  jsonb;
  hdr_user text;
  hdr_ip   text;
  old_j    jsonb;
  new_j    jsonb;
  diff     jsonb := '{}'::jsonb;
  k        text;
  pk       text;
begin
  headers  := nullif(current_setting('request.headers', true), '')::jsonb;
  hdr_user := headers ->> 'x-app-user';
  hdr_ip   := nullif(trim(split_part(coalesce(headers ->> 'x-forwarded-for', ''), ',', 1)), '');

  if TG_OP = 'DELETE' then
    old_j := to_jsonb(old);
    if TG_TABLE_NAME = 'users' then old_j := old_j - 'login_pw'; end if;
    pk := coalesce(old_j ->> 'id', old_j ->> 'code', old_j ->> 'key');
    insert into audit_log (table_name, op, row_pk, actor_id, actor_ip, changes)
    values (TG_TABLE_NAME, TG_OP, pk, hdr_user, hdr_ip, old_j);
    return old;

  elsif TG_OP = 'INSERT' then
    new_j := to_jsonb(new);
    if TG_TABLE_NAME = 'users' then new_j := new_j - 'login_pw'; end if;
    pk := coalesce(new_j ->> 'id', new_j ->> 'code', new_j ->> 'key');
    insert into audit_log (table_name, op, row_pk, actor_id, actor_ip, changes)
    values (TG_TABLE_NAME, TG_OP, pk, hdr_user, hdr_ip, new_j);
    return new;

  else -- UPDATE
    old_j := to_jsonb(old);
    new_j := to_jsonb(new);
    if TG_TABLE_NAME = 'users' then
      old_j := old_j - 'login_pw';
      new_j := new_j - 'login_pw';
    end if;
    pk := coalesce(new_j ->> 'id', new_j ->> 'code', new_j ->> 'key');

    for k in select jsonb_object_keys(new_j) loop
      if old_j -> k is distinct from new_j -> k then
        diff := diff || jsonb_build_object(k, jsonb_build_object('old', old_j -> k, 'new', new_j -> k));
      end if;
    end loop;

    if diff = '{}'::jsonb then
      return new; -- nothing actually changed (e.g. a no-op update / pure updated_at touch) — skip
    end if;

    insert into audit_log (table_name, op, row_pk, actor_id, actor_ip, changes)
    values (TG_TABLE_NAME, TG_OP, pk, hdr_user, hdr_ip, diff);
    return new;
  end if;
end;
$$;

-- ============ ATTACH TO TABLES ============

create or replace function audit_attach(target_table text) returns void
language plpgsql as $$
begin
  execute format('drop trigger if exists trg_audit on %I', target_table);
  execute format('create trigger trg_audit after insert or update or delete on %I for each row execute function audit_log_capture()', target_table);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'users','contacts','assignments','assignment_rounds','follow_up_assignments',
    'call_responses','session_attendance','events','settings',
    'help_requests','one_to_one_remarks','contact_collection',
    'book_places','book_inward_stock','book_outward_stock','book_standard_prices',
    'book_requests','book_expenses','book_contributions','fnrg_sadhana',
    'donation_donors','donation_events','donations'
  ] loop
    perform audit_attach(t);
  end loop;
end $$;

-- ============ 10-DAY RETENTION ============
-- Requires the pg_cron extension enabled once via the Supabase dashboard
-- (Database -> Extensions -> pg_cron), then this script schedules the job.

create extension if not exists pg_cron;

do $$
begin
  perform cron.unschedule('audit_log_purge');
exception when others then
  null; -- job didn't exist yet — fine
end $$;

select cron.schedule(
  'audit_log_purge',
  '0 3 * * *', -- daily, 03:00 UTC
  $$delete from audit_log where ts < now() - interval '10 days'$$
);
