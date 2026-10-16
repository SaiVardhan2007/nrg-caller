-- FOLK Yatras: "Travel Check List" and "Trip Itinerary" tabs, plus their starting data
-- (added to the yatra whose name starts with 'Vrindavan', only if it has none yet).
-- Duration in the itinerary is calculated in the app from Start / End Time.

create table if not exists yatra_checklist (
  id         uuid primary key default gen_random_uuid(),
  yatra_id   uuid not null references yatras(id) on delete cascade,
  item       text not null,
  position   double precision,
  created_at timestamptz not null default now()
);

create table if not exists yatra_itinerary (
  id          uuid primary key default gen_random_uuid(),
  yatra_id    uuid not null references yatras(id) on delete cascade,
  day_date    date not null,
  start_time  time not null,
  end_time    time not null,
  details     text not null,
  travel_mode text,
  position    double precision,
  created_at  timestamptz not null default now()
);

create index if not exists yatra_checklist_yatra_idx on yatra_checklist(yatra_id);
create index if not exists yatra_itinerary_yatra_idx on yatra_itinerary(yatra_id);

alter table yatra_checklist enable row level security;
alter table yatra_itinerary enable row level security;
drop policy if exists app_all on yatra_checklist;
create policy app_all on yatra_checklist for all to anon, authenticated using (true) with check (true);
drop policy if exists app_all on yatra_itinerary;
create policy app_all on yatra_itinerary for all to anon, authenticated using (true) with check (true);

do $$
declare yid uuid;
begin
  select id into yid from yatras where name ilike 'Vrindavan%' order by created_at limit 1;
  if yid is null then
    raise notice 'No yatra whose name starts with Vrindavan - tables created, no data added';
    return;
  end if;

  if not exists (select 1 from yatra_checklist where yatra_id = yid) then
    insert into yatra_checklist (yatra_id, item, position) values
      (yid, 'Aadhar Card Original', 1),
      (yid, E'3 pairs of Dhoti, Kurta, chaddar\n1 pairs of Regular Clothes (Shorts not allowed)', 2),
      (yid, 'Back Pack', 3),
      (yid, 'Washroom kit - Bath Soap, Toothpaste, Toothbrush, Coconut Oil, Comb, Shaving set etc.', 4),
      (yid, 'Travel Pillow & Blanket for Journey (for AC coach it will be provided by Railways)', 5),
      (yid, 'Bath Towels - 2', 6),
      (yid, 'Medicines (if you are using any)', 7),
      (yid, 'Workshop Kit', 8);
  end if;

  if not exists (select 1 from yatra_itinerary where yatra_id = yid) then
    insert into yatra_itinerary (yatra_id, day_date, start_time, end_time, details, travel_mode, position) values
      (yid, '2026-10-20', '05:00', '06:00', 'Collect Breakfast, Lunch Prasadam & Snacks from SRLAP Kitchen', null, 1),
      (yid, '2026-10-20', '05:00', '06:00', 'Travel by cabs to Nampally Railway Station', null, 2),
      (yid, '2026-10-20', '06:00', '06:00', 'Board TELANGANA SF EXP (12723) to reach Mathura Jn', null, 3),
      (yid, '2026-10-20', '06:00', '08:00', 'Mangal Aarthi & Hare Krishna Japa', null, 4),
      (yid, '2026-10-20', '08:00', '09:00', 'Breakfast Prasadam', null, 5),
      (yid, '2026-10-20', '09:00', '11:00', 'Declaration Form filling & ID cards issue', null, 6),
      (yid, '2026-10-20', '13:00', '14:00', 'Lunch Prasadam', null, 7),
      (yid, '2026-10-20', '15:00', '15:30', 'Collect Dinner Prasadam from Nagpur Rly Stn', null, 8),
      (yid, '2026-10-20', '18:00', '19:00', 'Sandhya Aarthi & Kirtans', null, 9),
      (yid, '2026-10-20', '19:00', '20:00', 'Dinner Prasadam', null, 10),
      (yid, '2026-10-20', '21:00', '21:00', 'Rest', null, 11);
  end if;
end $$;
