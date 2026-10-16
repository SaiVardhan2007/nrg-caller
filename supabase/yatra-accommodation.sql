-- FOLK Yatras: "Accommodation" tab (one row per stay / hotel booking).
-- Total Cost = rooms x cost per room + extra charges, and Balance = total - advance;
-- both are calculated in the app, so they aren't stored.
create table if not exists yatra_accommodation (
  id             uuid primary key default gen_random_uuid(),
  yatra_id       uuid not null references yatras(id) on delete cascade,
  name           text not null,
  contact_person text,
  mobile         text,
  no_of_rooms    numeric,
  checkin_time   timestamp,
  checkout_time  timestamp,
  location       text,
  cost_per_room  numeric,
  extra_charges  numeric,
  booking_date   date,
  advance_paid   numeric,
  remarks        text,
  position       double precision,
  created_at     timestamptz not null default now()
);

create index if not exists yatra_accommodation_yatra_idx on yatra_accommodation(yatra_id);

alter table yatra_accommodation enable row level security;
drop policy if exists app_all on yatra_accommodation;
create policy app_all on yatra_accommodation for all to anon, authenticated using (true) with check (true);
