-- FOLK Yatras: "Travel Info" tab (one row per ticket / journey).
create table if not exists yatra_travel (
  id            uuid primary key default gen_random_uuid(),
  yatra_id      uuid not null references yatras(id) on delete cascade,
  journey_date  timestamp,
  ticket_for    text,
  travellers    text,
  pnr_no        text,
  seat_no       text,
  from_place    text,
  to_place      text,
  position      double precision,
  created_at    timestamptz not null default now()
);

create index if not exists yatra_travel_yatra_idx on yatra_travel(yatra_id);

alter table yatra_travel enable row level security;
drop policy if exists app_all on yatra_travel;
create policy app_all on yatra_travel for all to anon, authenticated using (true) with check (true);
