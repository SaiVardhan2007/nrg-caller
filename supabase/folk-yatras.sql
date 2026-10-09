-- NOT YET APPLIED. Run this once on the live database to enable the
-- "FOLK Yatras" admin module (a card per yatra; inside each: Dashboard
-- [participant roster + Excel upload], Attendance [meal coupons], Disposables,
-- Cooking / Serving Items, Feedback / Ideas).
--
-- All yatra data lives in its own tables — nothing here touches contacts,
-- users or any other Preaching data.
--
-- NOTE: an earlier draft of this module used yatra_attendees and a different
-- yatra_items / yatra_feedback shape. Those three are dropped and recreated
-- below. They only ever held test data from that draft; if you entered real
-- data into them, export it first.

drop table if exists yatra_attendees cascade;
drop table if exists yatra_items cascade;
drop table if exists yatra_feedback cascade;

create table if not exists yatras (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  yatra_date  date,
  created_at  timestamptz not null default now()
);

-- Roster for one yatra (the Dashboard tab; filled by hand or Excel upload).
-- phone is stored as the normalized 10 digits so Attendance can look a
-- person up by exact match.
create table if not exists yatra_participants (
  id          uuid primary key default gen_random_uuid(),
  yatra_id    uuid not null references yatras(id) on delete cascade,
  name        text not null,
  phone       text not null,
  folk_guide  text,
  tokens      integer,
  created_at  timestamptz not null default now()
);
create unique index if not exists yatra_participants_phone_uniq on yatra_participants(yatra_id, phone);

-- One row per plate. meal: M = morning, L = lunch, D = dinner.
-- kind 'regular' is the single normal coupon (max one per person per meal);
-- kind 'extra' rows are unlimited (typing 3 extra plates inserts 3 rows).
create table if not exists yatra_coupons (
  id             uuid primary key default gen_random_uuid(),
  yatra_id       uuid not null references yatras(id) on delete cascade,
  participant_id uuid not null references yatra_participants(id) on delete cascade,
  coupon_date    date not null,
  meal           text not null check (meal in ('M','L','D')),
  kind           text not null check (kind in ('regular','extra')),
  created_at     timestamptz not null default now()
);
create unique index if not exists yatra_coupons_regular_once
  on yatra_coupons(participant_id, coupon_date, meal) where kind = 'regular';
create index if not exists yatra_coupons_slot_idx on yatra_coupons(yatra_id, coupon_date, meal);

-- One table for both item lists: kind = 'disposable' or 'cooking'
-- (Cooking / Serving Items).
create table if not exists yatra_items (
  id          uuid primary key default gen_random_uuid(),
  yatra_id    uuid not null references yatras(id) on delete cascade,
  kind        text not null check (kind in ('disposable','cooking')),
  name        text not null,
  quantity    numeric,
  status      text not null default 'Not Received' check (status in ('Received','Not Received','Not Available')),
  created_at  timestamptz not null default now()
);

create table if not exists yatra_feedback (
  id          uuid primary key default gen_random_uuid(),
  yatra_id    uuid not null references yatras(id) on delete cascade,
  content     text not null,
  author      text,
  created_at  timestamptz not null default now()
);

create index if not exists yatra_participants_yatra_idx on yatra_participants(yatra_id);
create index if not exists yatra_items_yatra_idx on yatra_items(yatra_id);
create index if not exists yatra_feedback_yatra_idx on yatra_feedback(yatra_id);

alter table yatras enable row level security;
alter table yatra_participants enable row level security;
alter table yatra_coupons enable row level security;
alter table yatra_items enable row level security;
alter table yatra_feedback enable row level security;

drop policy if exists app_all on yatras;
create policy app_all on yatras for all to anon, authenticated using (true) with check (true);
drop policy if exists app_all on yatra_participants;
create policy app_all on yatra_participants for all to anon, authenticated using (true) with check (true);
drop policy if exists app_all on yatra_coupons;
create policy app_all on yatra_coupons for all to anon, authenticated using (true) with check (true);
drop policy if exists app_all on yatra_items;
create policy app_all on yatra_items for all to anon, authenticated using (true) with check (true);
drop policy if exists app_all on yatra_feedback;
create policy app_all on yatra_feedback for all to anon, authenticated using (true) with check (true);
