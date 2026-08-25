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
  commander   boolean not null default false,
  assigned_count int not null default 0,    -- mirrors "No of Call Assigned by Automation" in Sheets
  sadhana_track boolean not null default false, -- only tracked users show in the FNRG Sadhana "Enter Sadhana" roster
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table users add column if not exists assigned_count int not null default 0;
alter table users add column if not exists commander boolean not null default false;
alter table users add column if not exists sadhana_track boolean not null default false;

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
  gender           text check (gender in ('M','F')),
  sessions_count   int not null default 0,      -- auto-maintained by trigger
  calls_count      int not null default 0,      -- auto-maintained by trigger
  admin_remarks    text,
  admin_tag_to_users text,                      -- Don't Call / Janata / Call / Core / Assigned
  admin_tag        text,                        -- LIT / Folk HYD / Focus / ...
  core_cultivation text,                        -- user_name of permanent cultivator
  calling_purpose  text,                        -- event code: GIC / RY / JSTM / ...
  one_to_one_status boolean not null default false, -- in the One to One (with Prabhu) roster
  gyc_status       text check (gyc_status in ('Intrested GFY','Not Intrested GFY','Attended GFY','Intrested AOMC','Not Intrested AOMC','Attended AOMC')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table contacts add column if not exists gender text check (gender in ('M','F'));
alter table contacts add column if not exists one_to_one_status boolean not null default false;
alter table contacts add column if not exists gyc_status text check (gyc_status in ('Intrested GFY','Not Intrested GFY','Attended GFY','Intrested AOMC','Not Intrested AOMC','Attended AOMC'));
-- Existing databases: see supabase/gfy-aomc-values.sql to migrate the old
-- four-value constraint and its data onto the list above.

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
  called_count    int not null default 0,
  left_count      int not null default 0,
  positive_count  int not null default 0,
  round_ended_at  timestamptz not null default now()
);

-- No sheet: Follow Up Calls. A separate, lightweight hand-off layer — when a
-- contact comes back "Need to Call Again" / "Available on Weekend", the admin
-- can send it to a different caller from Analytics without touching the live
-- `assignments` row (Users & Assignment stays completely unaffected).
create table if not exists follow_up_assignments (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts(id) on delete cascade,
  event_code   text not null,
  user_name    text not null,               -- who should make the follow-up call
  status       text not null default 'Need to Call Again',
  submitted_at timestamptz,
  assigned_at  timestamptz not null default now(),
  unique (contact_id, event_code)
);
alter table follow_up_assignments enable row level security;

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

-- No sheet: One to One (with Prabhu) — a contact's own submitted questions,
-- shown to admin as "Help Asked by the Boy" and to the contact (when logged
-- in as a user) as their own question history.
create table if not exists help_requests (
  id         uuid primary key default gen_random_uuid(),
  mob_no     text not null,
  message    text not null,
  resolved   boolean not null default false,
  response   text,
  created_at timestamptz not null default now()
);
create index if not exists idx_help_requests_mob_no on help_requests(mob_no);

alter table help_requests add column if not exists resolved boolean not null default false;
alter table help_requests add column if not exists response text;

-- No sheet: admin-only remark log for a One to One contact ("Remarks by
-- SNKD") — never shown to the contact/user themselves.
create table if not exists one_to_one_remarks (
  id         uuid primary key default gen_random_uuid(),
  mob_no     text not null,
  remark     text not null,
  admin_name text,
  created_at timestamptz not null default now()
);
create index if not exists idx_one_to_one_remarks_mob_no on one_to_one_remarks(mob_no);

-- Sheet: Contact Collection — leads any logged-in user can submit from the
-- "Contact Collection" dashboard card; admin reviews and promotes them to
-- Master Contact from the New Contacts page.
create table if not exists contact_collection (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  mob_no       text not null check (mob_no ~ '^[0-9]{10}$'),
  profession   text not null,
  gender       text not null check (gender in ('M','F')),
  staying      text,
  collected_by text,
  comment      text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_contact_collection_mob_no on contact_collection(mob_no);

-- This queue now also receives contacts added from Reception and from Master
-- Contact's "+ Add Contact" (nothing writes straight to `contacts` any more),
-- so it carries every field those forms collect and cannot require
-- profession/gender. See supabase/new-contacts-queue.sql for the migration.
alter table contact_collection alter column profession drop not null;
alter table contact_collection alter column gender     drop not null;
alter table contact_collection add column if not exists ws              text;
alter table contact_collection add column if not exists company_name    text;
alter table contact_collection add column if not exists calling_purpose text;
alter table contact_collection add column if not exists gyc_status      text;
alter table contact_collection add column if not exists admin_tag       text;
alter table contact_collection add column if not exists admin_tag_to_users text;
alter table contact_collection add column if not exists core_cultivation   text;
alter table contact_collection add column if not exists source          text;

-- No sheet: Book Distribution > Distribution Places. Admin-managed list of
-- places books get distributed at (a market, a college gate, a station…).
create table if not exists book_places (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  map_link    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- No sheet: Book Distribution > Inward Stock. Users log books coming in.
create table if not exists book_inward_stock (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  language       text,
  purchase_price numeric,
  quantity       integer,
  purchased_from text,
  added_by       text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- No sheet: Book Distribution > Outward Stock. Users log books sold/given out.
create table if not exists book_outward_stock (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  language    text,
  sold_price  numeric,
  quantity    integer,
  sold_area   text,
  sold_by     text,
  realised    boolean not null default false,  -- Commander marks true once payment/books are confirmed collected
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table book_outward_stock add column if not exists realised boolean not null default false;

-- Every Book Distribution "my stock", "score", "latest location" and
-- Analytics query filters book_outward_stock by sold_by and/or a created_at
-- range; there was no index at all on this table before.
create index if not exists idx_book_outward_stock_sold_by_created_at
  on book_outward_stock (sold_by, created_at);
create index if not exists idx_book_outward_stock_created_at
  on book_outward_stock (created_at);

-- Book Distribution > Dashboard. Admin-set standard selling price per book
-- (name+language pair) — separate from the actual sold_price on individual
-- outward entries, which can vary by area/negotiation.
create table if not exists book_standard_prices (
  id                      uuid primary key default gen_random_uuid(),
  book_key                text not null unique,
  name                    text not null,
  language                text,
  standard_selling_price  numeric,
  min_stock               integer,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
alter table book_standard_prices add column if not exists min_stock integer;

-- No sheet: Book Distribution > Book Requests. Anyone can request a book be
-- stocked/brought to a place; admin reviews and marks it fulfilled.
create table if not exists book_requests (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  quantity     integer not null,
  place        text,
  priority     text not null default 'Can Wait' check (priority in ('Immediately','Important','Can Wait')),
  requested_by text,
  fulfilled    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_book_requests_created_at on book_requests(created_at);

-- No sheet: Book Distribution > Expenses. Admin-only ledger of money spent
-- (travel, printing, etc.), who it went to, and the resulting profit/loss.
create table if not exists book_expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null default current_date,
  name          text not null,
  cost          numeric,
  place         text,
  to_users      text[],
  result_profit numeric,
  added_by      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_book_expenses_expense_date on book_expenses(expense_date);

-- No sheet: Book Distribution > Tirtha Nidhi personal contributions. A user
-- logs cash they're handing over to another user; only that recipient can
-- mark it realised (confirmed received), mirroring book_outward_stock.realised.
create table if not exists book_contributions (
  id                 uuid primary key default gen_random_uuid(),
  contribution_date  date not null default current_date,
  amount             numeric not null,
  submitted_by       text not null,
  paid_to            text not null,
  realised           boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_book_contributions_submitted_by on book_contributions(submitted_by);
create index if not exists idx_book_contributions_paid_to on book_contributions(paid_to);

-- No sheet: FNRG Sadhana module. Per-person daily sadhana log.
create table if not exists fnrg_sadhana (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  sadhana_date  date not null default current_date,
  rounds        numeric,
  book_reading  numeric,
  screen_time   numeric,
  detox_time    numeric,
  service       text check (service in ('Yes','No','Na')),
  swadhyaya     text check (swadhyaya in ('Yes','No')),
  added_by      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table fnrg_sadhana add column if not exists service text check (service in ('Yes','No','Na'));
alter table fnrg_sadhana add column if not exists swadhyaya text check (swadhyaya in ('Yes','No'));

-- ============ HELPER FUNCTIONS ============

-- Lets the app's "Download All Data" export discover tables live instead of
-- from a hardcoded JS list, so a table added here later shows up in the
-- export with no app code change (it still needs an RLS policy below, like
-- every other table, or its rows just come back empty to anon/authenticated).
create or replace function list_app_tables() returns text[] language sql stable as $$
  select array_agg(table_name order by table_name)
  from information_schema.tables
  where table_schema = 'public' and table_type = 'BASE TABLE';
$$;
grant execute on function list_app_tables() to anon, authenticated;

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

drop trigger if exists trg_book_places_touch on book_places;
create trigger trg_book_places_touch before update on book_places
  for each row execute function touch_updated_at();

drop trigger if exists trg_book_inward_stock_touch on book_inward_stock;
create trigger trg_book_inward_stock_touch before update on book_inward_stock
  for each row execute function touch_updated_at();

drop trigger if exists trg_book_outward_stock_touch on book_outward_stock;
create trigger trg_book_outward_stock_touch before update on book_outward_stock
  for each row execute function touch_updated_at();

drop trigger if exists trg_book_standard_prices_touch on book_standard_prices;
create trigger trg_book_standard_prices_touch before update on book_standard_prices
  for each row execute function touch_updated_at();

drop trigger if exists trg_book_requests_touch on book_requests;
create trigger trg_book_requests_touch before update on book_requests
  for each row execute function touch_updated_at();

drop trigger if exists trg_fnrg_sadhana_touch on fnrg_sadhana;
create trigger trg_fnrg_sadhana_touch before update on fnrg_sadhana
  for each row execute function touch_updated_at();

drop trigger if exists trg_book_expenses_touch on book_expenses;
create trigger trg_book_expenses_touch before update on book_expenses
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

-- Reception can mark attendance for a phone number before that person is
-- added to Master Contacts (e.g. walk-in logged via session_attendance,
-- added to contacts later via Add All to Master / Sheets sync). When that
-- happens, trg_attendance_bump's UPDATE above matches zero rows because the
-- contact doesn't exist yet, so those sessions are lost once the contact row
-- is created with sessions_count defaulting to 0. Backfill from any
-- already-existing session_attendance rows at contact-insert time so the
-- count is never short.
create or replace function backfill_sessions_count_on_contact_insert() returns trigger language plpgsql as $$
begin
  select count(*) into new.sessions_count from session_attendance where mob_no = new.mob_no;
  return new;
end $$;

drop trigger if exists trg_contact_backfill_sessions on contacts;
create trigger trg_contact_backfill_sessions before insert on contacts
  for each row execute function backfill_sessions_count_on_contact_insert();

-- call response insert -> contacts.calls_count + 1
create or replace function bump_calls_count() returns trigger language plpgsql as $$
begin
  update contacts set calls_count = calls_count + 1 where mob_no = new.mob_no;
  return new;
end $$;

drop trigger if exists trg_calls_bump on call_responses;
create trigger trg_calls_bump after insert on call_responses
  for each row execute function bump_calls_count();

-- call response delete -> contacts.calls_count - 1 (keeps the badge in sync
-- with admin bulk-deletes of call_responses rows)
create or replace function unbump_calls_count() returns trigger language plpgsql as $$
begin
  update contacts set calls_count = greatest(calls_count - 1, 0) where mob_no = old.mob_no;
  return old;
end $$;

drop trigger if exists trg_calls_unbump on call_responses;
create trigger trg_calls_unbump after delete on call_responses
  for each row execute function unbump_calls_count();

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
alter table help_requests      enable row level security;
alter table one_to_one_remarks enable row level security;
alter table book_places           enable row level security;
alter table book_inward_stock     enable row level security;
alter table book_outward_stock    enable row level security;
alter table book_standard_prices  enable row level security;
alter table book_requests         enable row level security;
alter table book_expenses         enable row level security;
alter table book_contributions    enable row level security;

do $$ declare t text;
begin
  foreach t in array array['users','contacts','assignments','assignment_rounds','call_responses',
                           'session_attendance','contact_collection','events','settings',
                           'help_requests','one_to_one_remarks','book_places',
                           'book_inward_stock','book_outward_stock','book_standard_prices',
                           'follow_up_assignments','book_requests','book_expenses',
                           'book_contributions'] loop
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

-- Separate block: if the statement above ever hits duplicate_object on one of
-- its tables, the whole statement no-ops, so a table added later in the same
-- list would silently never get published. Keeping this on its own avoids that.
do $$
begin
  begin
    alter publication supabase_realtime add table follow_up_assignments;
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
  ('gfy_filter',    ''),          -- empty = no GFY Attended/Not Attended filter
  ('message_text',  '')           -- Body Text E3
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

-- Book Distribution sample data — only seeds an empty table, so re-running
-- this file is safe and won't duplicate rows once real data exists.
do $$
begin
  if not exists (select 1 from book_places) then
    insert into book_places (name, description, map_link) values
      ('ISKCON Temple Main Gate',        'Sunday feast crowd, high footfall', null),
      ('Ameerpet Metro Station',         'Evening commuter rush',             null),
      ('Osmania University Campus',      'Student hostel area',               null),
      ('Secunderabad Railway Station',   'Platform 1 entrance',               null),
      ('Kukatpally Housing Board Colony','Residential door-to-door',          null);
  end if;

  if not exists (select 1 from book_inward_stock) then
    insert into book_inward_stock (name, language, purchase_price, quantity, purchased_from, added_by) values
      ('Bhagavad Gita As It Is',      'English', 120, 50, 'BBT Hyderabad', 'Abhinay'),
      ('Bhagavad Gita As It Is',      'Telugu',  100, 30, 'BBT Hyderabad', 'Abhinay'),
      ('Sri Isopanisad',              'English', 60,  40, 'BBT Hyderabad', 'Sai Vardhan'),
      ('Krishna Book',                'Hindi',   150, 20, 'BBT Hyderabad', 'Abhinay'),
      ('Science of Self Realization', 'English', 90,  25, 'BBT Hyderabad', 'Aryan');
  end if;

  if not exists (select 1 from book_outward_stock) then
    insert into book_outward_stock (name, language, sold_price, quantity, sold_area, sold_by) values
      ('Bhagavad Gita As It Is',      'English', 150, 10, 'Ameerpet Metro Station',          'Sai Vardhan'),
      ('Bhagavad Gita As It Is',      'Telugu',  130, 5,  'Osmania University Campus',       'Aryan'),
      ('Sri Isopanisad',              'English', 80,  8,  'Secunderabad Railway Station',    'Deepak'),
      ('Krishna Book',                'Hindi',   180, 4,  'Kukatpally Housing Board Colony', 'Ashwith'),
      ('Science of Self Realization', 'English', 110, 6,  'ISKCON Temple Main Gate',         'Snehith');
  end if;
end $$;
