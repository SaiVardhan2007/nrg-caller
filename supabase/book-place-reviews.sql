-- Book Distribution: Place Reviews. Experience notes users leave about a
-- distribution place (prompted after saving sales, or added from the
-- Places page). Admins can edit/delete; regular users can only add.

create table if not exists book_place_reviews (
  id          uuid primary key default gen_random_uuid(),
  place_id    uuid not null references book_places(id) on delete cascade,
  review      text not null,
  user_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_book_place_reviews_place on book_place_reviews(place_id, created_at);

drop trigger if exists trg_book_place_reviews_touch on book_place_reviews;
create trigger trg_book_place_reviews_touch before update on book_place_reviews
  for each row execute function touch_updated_at();

alter table book_place_reviews enable row level security;
drop policy if exists app_all on book_place_reviews;
create policy app_all on book_place_reviews for all to anon, authenticated using (true) with check (true);
