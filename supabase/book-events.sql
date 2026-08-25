-- Book Distribution: Events. Mirrors book_places exactly (name/description/
-- map_link CRUD table) so every book entry (Outward/Sales, Book Requests,
-- Book Expenses) can be tagged with an Event alongside its Place, the same
-- way sold_area/place already works. Named book_events (not "events") to
-- avoid colliding with the existing unrelated `events` table used for
-- calling-purpose/session events.

create table if not exists book_events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  map_link    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists trg_book_events_touch on book_events;
create trigger trg_book_events_touch before update on book_events
  for each row execute function touch_updated_at();

alter table book_events enable row level security;
drop policy if exists app_all on book_events;
create policy app_all on book_events for all to anon, authenticated using (true) with check (true);

alter table book_outward_stock add column if not exists event text;
alter table book_requests      add column if not exists event text;
alter table book_expenses      add column if not exists event text;
