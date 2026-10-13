-- Feedback entries get a category.
alter table yatra_feedback add column if not exists category text;

-- Categories added by users from the Add Feedback form (the built-in ones live in the app).
create table if not exists yatra_feedback_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz not null default now()
);
alter table yatra_feedback_categories enable row level security;
drop policy if exists app_all on yatra_feedback_categories;
create policy app_all on yatra_feedback_categories for all to anon, authenticated using (true) with check (true);
