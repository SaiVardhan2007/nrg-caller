-- NRG Caller v2 — Supabase schema
-- Mirrors the Google Sheet tabs 1:1, plus an assignments table
-- (assignment is its own record, never a column on contacts).

-- ============ TABLES ============

-- Sheet: Admin Page
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  s_no        int,
  user_name   text not null unique,
  login_pw    text not null,
  role        text not null default 'Coordinator' check (role in ('Coordinator','Admin','Reception')),
  call_limit  int,                          -- null = no limit
  auto_assign boolean not null default true,
  assigned_count int not null default 0,    -- mirrors "No of Call Assigned by Automation" in Sheets
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table users add column if not exists assigned_count int not null default 0;

-- Sheet: Master Contact
create table if not exists contacts (
  id               uuid primary key default gen_random_uuid(),
  s_no             int,
  mob_no           text not null unique check (mob_no ~ '^[0-9]{10}$'),
  name             text not null,
  pg_name          text,
  profession       text,
  company_name     text,
  ws               text check (ws in ('W','S','NA')),
  gender           text check (gender in ('Male','Female')),
  sessions_count   int not null default 0,      -- auto-maintained by trigger
  calls_count      int not null default 0,      -- auto-maintained by trigger
  admin_remarks    text,
  admin_tag_to_users text,                      -- Don't Call / Janata / Call / Core / Assigned
  admin_tag        text,                        -- LIT / Folk HYD / Focus / ...
  core_cultivation text,                        -- user_name of permanent cultivator
  calling_purpose  text,                        -- event code: GIC / RY / JSTM / ...
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table contacts add column if not exists gender text check (gender in ('Male','Female'));

-- No sheet: live assignment state (erased & rebuilt when admin switches event)
create table if not exists assignments (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts(id) on delete cascade,
  user_name    text not null,
  event_code   text not null,
  status       text not null default 'Not Done',
  submitted_at timestamptz,
  assigned_at  timestamptz not null default now(),
  unique (contact_id, event_code)
);

-- No sheet: per-user assigned-count snapshot, taken right before each wipe so
-- past rounds ("how many did this user get assigned last Rath Yatra") stay
-- answerable for admin analytics even after assignments itself is cleared.
create table if not exists assignment_rounds (
  id              uuid primary key default gen_random_uuid(),
  user_name       text not null,
  event_code      text not null,
  assigned_count  int not null default 0,
  round_ended_at  timestamptz not null default now()
);

-- Sheet: Calling Responce (permanent log, one row per submit)
create table if not exists call_responses (
  id           uuid primary key default gen_random_uuid(),
  ts           timestamptz not null default now(),
  caller_name  text not null,
  contact_name text,
  mob_no       text not null,
  event_code   text,
  remarks      text not null,        -- the chosen status
  addl_remarks text                  -- free text for "Others"
);

-- Sheet: Session Att
create table if not exists session_attendance (
  id         uuid primary key default gen_random_uuid(),
  ts         timestamptz not null default now(),
  mob_no     text not null,
  name       text,
  took_by    text not null,
  event_code text
);



-- Event codes (dropdown source)
create table if not exists events (
  code       text primary key,       -- GIC, RY, JSTM
  name       text not null,          -- full name for display
  created_at timestamptz not null default now()
);

-- Sheet: Body Text E3 + current event + tag filter (single-row config)
create table if not exists settings (
  key   text primary key,
  value text
);

-- ============ TRIGGERS ============

-- keep updated_at fresh
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists trg_users_touch on users;
create trigger trg_users_touch before update on users
  for each row execute function touch_updated_at();

drop trigger if exists trg_contacts_touch on contacts;
create trigger trg_contacts_touch before update on contacts
  for each row execute function touch_updated_at();

-- attendance insert -> contacts.sessions_count + 1 (the "No of Sessions" column)
create or replace function bump_sessions_count() returns trigger language plpgsql as $$
begin
  update contacts set sessions_count = sessions_count + 1 where mob_no = new.mob_no;
  return new;
end $$;

drop trigger if exists trg_attendance_bump on session_attendance;
create trigger trg_attendance_bump after insert on session_attendance
  for each row execute function bump_sessions_count();

-- attendance delete -> contacts.sessions_count - 1 (undo a mistaken mark)
create or replace function unbump_sessions_count() returns trigger language plpgsql as $$
begin
  update contacts set sessions_count = greatest(sessions_count - 1, 0) where mob_no = old.mob_no;
  return old;
end $$;

drop trigger if exists trg_attendance_unbump on session_attendance;
create trigger trg_attendance_unbump after delete on session_attendance
  for each row execute function unbump_sessions_count();

-- call response insert -> contacts.calls_count + 1
create or replace function bump_calls_count() returns trigger language plpgsql as $$
begin
  update contacts set calls_count = calls_count + 1 where mob_no = new.mob_no;
  return new;
end $$;

drop trigger if exists trg_calls_bump on call_responses;
create trigger trg_calls_bump after insert on call_responses
  for each row execute function bump_calls_count();

-- contact calling_purpose change -> delete old assignment
create or replace function handle_contact_calling_purpose_change() returns trigger language plpgsql as $$
begin
  if old.calling_purpose is not null and old.calling_purpose is distinct from new.calling_purpose then
    delete from assignments where contact_id = new.id and event_code = old.calling_purpose;
  end if;
  return new;
end $$;

drop trigger if exists trg_contacts_calling_purpose_change on contacts;
create trigger trg_contacts_calling_purpose_change
  after update of calling_purpose on contacts
  for each row execute function handle_contact_calling_purpose_change();

-- ============ ROW LEVEL SECURITY ============
-- Internal team tool: anon key may read/write app tables.
-- (service_role bypasses RLS and is used only by the Sheets bridge.)

alter table users              enable row level security;
alter table contacts           enable row level security;
alter table assignments        enable row level security;
alter table assignment_rounds  enable row level security;
alter table call_responses     enable row level security;
alter table session_attendance enable row level security;
alter table contact_collection enable row level security;
alter table events             enable row level security;
alter table settings           enable row level security;

do $$ declare t text;
begin
  foreach t in array array['users','contacts','assignments','assignment_rounds','call_responses',
                           'session_attendance','contact_collection','events','settings'] loop
    execute format('drop policy if exists app_all on %I', t);
    execute format('create policy app_all on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ============ REALTIME ============
-- live updates in the app (admin counters, caller lists)
do $$
begin
  begin
    alter publication supabase_realtime add table assignments, contacts, settings, call_responses;
  exception when duplicate_object then null;
  end;
end $$;

-- ============ SEED DATA ============

insert into events (code, name) values
  ('GIC',  'Gita Intro Course (Weekly Session)'),
  ('RY',   'Rath Yatra'),
  ('JSTM', 'Janmashtami')
on conflict (code) do nothing;

insert into settings (key, value) values
  ('current_event', 'GIC'),
  ('tag_filter',    ''),          -- empty = all tags
  ('message_text',  ''),          -- Body Text E3
  ('poster_url',    '')
on conflict (key) do nothing;

-- users from the Admin Page sheet
insert into users (s_no, user_name, login_pw, role, auto_assign) values
  (1,  'SNKD',        '1896',       'Coordinator', false),
  (2,  'Abhinay',     '6302017475', 'Admin',       false),
  (3,  'Anil',        '9553223877', 'Reception',   true),
  (4,  'Arabinda',    '9090984782', 'Coordinator', true),
  (5,  'Aryan',       '7815958506', 'Coordinator', true),
  (6,  'Ashwith',     '9390676851', 'Coordinator', true),
  (7,  'Deepak',      '7487939125', 'Coordinator', true),
  (8,  'Dushmanth',   '8000292970', 'Coordinator', true),
  (9,  'Guruswami',   '9826996727', 'Coordinator', true),
  (10, 'Narendra',    '6300603869', 'Coordinator', true),
  (11, 'Sai Vardhan', '9390927165', 'Coordinator', true),
  (12, 'Shashwat',    '8052521146', 'Coordinator', true),
  (13, 'Snehith',     '9154689543', 'Coordinator', true),
  (14, 'Srinivas',    '9063384390', 'Coordinator', false),
  (15, 'Tej Vardhan', '9110737842', 'Coordinator', true)
on conflict (user_name) do nothing;
