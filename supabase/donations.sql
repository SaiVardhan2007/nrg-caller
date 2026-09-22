-- Donations module. Donors are a curated subset of Master Contact
-- (contacts) — explicitly added one at a time from the Dashboard's
-- phone-number search, never the full roster ("the users will be from
-- preaching but not all"). donation_donors is that curated set;
-- donations is the per-transaction log against it; donation_events is its
-- own small table (not `events`) so it doesn't collide with the existing
-- calling-purpose `events` table, same reasoning as book_events.

create table if not exists donation_donors (
  id       uuid primary key default gen_random_uuid(),
  mob_no   text not null unique check (mob_no ~ '^[0-9]{10}$'),
  name     text not null,
  added_at timestamptz not null default now()
);

create table if not exists donation_events (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists donations (
  id            uuid primary key default gen_random_uuid(),
  mob_no        text not null references donation_donors(mob_no) on delete cascade,
  name          text not null,
  amount        numeric not null check (amount > 0),
  event         text,
  added_by      text,
  donation_date date not null default current_date,
  created_at    timestamptz not null default now()
);
create index if not exists idx_donations_mob_no on donations(mob_no);

-- donation_date (the actual date the donation was made, editable — distinct
-- from created_at/"Time Stamp", which is when the row was entered into the
-- system) was added after the table already existed live, so backfill it
-- from each row's created_at date rather than trusting the column default
-- (which would otherwise stamp every pre-existing row with today's date).
alter table donations add column if not exists donation_date date;
update donations set donation_date = created_at::date where donation_date is null;
alter table donations alter column donation_date set default current_date;
alter table donations alter column donation_date set not null;

-- Utilised/remarks: how much of a donation has been spent so far, and an
-- optional note on what for. Nullable-free (default 0) so existing rows and
-- the dashboard/analytics net-total math (amount - utilised) never see nulls.
alter table donations add column if not exists utilised numeric not null default 0;
alter table donations add column if not exists remarks text;

alter table donation_donors enable row level security;
alter table donation_events enable row level security;
alter table donations       enable row level security;

drop policy if exists app_all on donation_donors;
create policy app_all on donation_donors for all to anon, authenticated using (true) with check (true);

drop policy if exists app_all on donation_events;
create policy app_all on donation_events for all to anon, authenticated using (true) with check (true);

drop policy if exists app_all on donations;
create policy app_all on donations for all to anon, authenticated using (true) with check (true);
