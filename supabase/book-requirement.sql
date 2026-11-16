-- Book Distribution: Book Requirement (replaces the old Book Requests admin table).
-- One row per book + language holding the quantity we ordered and the quantity received.

create table if not exists book_requirement (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  language      text not null default '',
  order_qty     integer,
  received_qty  integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (name, language)
);

drop trigger if exists trg_book_requirement_touch on book_requirement;
create trigger trg_book_requirement_touch before update on book_requirement
  for each row execute function touch_updated_at();

alter table book_requirement enable row level security;
drop policy if exists app_all on book_requirement;
create policy app_all on book_requirement for all to anon, authenticated using (true) with check (true);
