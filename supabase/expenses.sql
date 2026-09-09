-- Expenses module (admin only). Three independent flat ledgers — Trip,
-- Preaching, Residency — same shape as book_expenses but standalone (no
-- to_users/result_profit tie-in to book sales), so each gets its own table
-- instead of a single table with a category column.

create table if not exists trip_expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null default current_date,
  description   text not null,
  amount        numeric not null check (amount > 0),
  place         text,
  added_by      text,
  created_at    timestamptz not null default now()
);

create table if not exists preaching_expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null default current_date,
  description   text not null,
  amount        numeric not null check (amount > 0),
  place         text,
  added_by      text,
  created_at    timestamptz not null default now()
);

create table if not exists residency_expenses (
  id            uuid primary key default gen_random_uuid(),
  expense_date  date not null default current_date,
  description   text not null,
  amount        numeric not null check (amount > 0),
  place         text,
  added_by      text,
  created_at    timestamptz not null default now()
);

alter table trip_expenses      enable row level security;
alter table preaching_expenses enable row level security;
alter table residency_expenses enable row level security;

drop policy if exists app_all on trip_expenses;
create policy app_all on trip_expenses for all to anon, authenticated using (true) with check (true);

drop policy if exists app_all on preaching_expenses;
create policy app_all on preaching_expenses for all to anon, authenticated using (true) with check (true);

drop policy if exists app_all on residency_expenses;
create policy app_all on residency_expenses for all to anon, authenticated using (true) with check (true);

-- Total budget per category, no history — "Add Budget" just tops this up in
-- place instead of writing a log entry.
create table if not exists expense_budgets (
  category      text primary key,
  total_budget  numeric not null default 0 check (total_budget >= 0),
  updated_at    timestamptz not null default now()
);

insert into expense_budgets (category) values ('trip'), ('preaching'), ('residency')
  on conflict (category) do nothing;

alter table expense_budgets enable row level security;
drop policy if exists app_all on expense_budgets;
create policy app_all on expense_budgets for all to anon, authenticated using (true) with check (true);
