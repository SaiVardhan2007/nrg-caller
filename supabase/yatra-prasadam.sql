-- FOLK Yatras: "Prasadam Details" tab (one row per meal order).
-- Total Cost and Balance are calculated in the app, so they aren't stored.
create table if not exists yatra_prasadam (
  id                uuid primary key default gen_random_uuid(),
  yatra_id          uuid not null references yatras(id) on delete cascade,
  meal_date         date not null,
  meal_type         text not null,
  for_how_many      numeric,
  menu              text,
  vendor            text,
  delivery_location text,
  delivery_time     time,
  packing_method    text,
  serving_location  text,
  serving_method    text,
  items_required    text,
  cost_per_plate    numeric,
  advance_payment   numeric,
  remarks           text,
  position          double precision,
  created_at        timestamptz not null default now()
);

create index if not exists yatra_prasadam_yatra_idx on yatra_prasadam(yatra_id);

alter table yatra_prasadam enable row level security;
drop policy if exists app_all on yatra_prasadam;
create policy app_all on yatra_prasadam for all to anon, authenticated using (true) with check (true);
