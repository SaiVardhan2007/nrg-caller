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

-- Legacy: a single mutable total_budget per category, no history. Superseded
-- by budget_transactions below (kept only so the one-time migration has
-- something to carry forward — the app no longer reads or writes this).
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

-- Budget transactions: every "Add Budget" click records a dated, described
-- line item here (same shape as the expense ledgers) instead of just
-- topping up a single number — the Total Budget stat is the sum of a
-- category's transactions, and clicking it shows this history.
create table if not exists budget_transactions (
  id                uuid primary key default gen_random_uuid(),
  category          text not null check (category in ('trip','preaching','residency')),
  transaction_date  date not null default current_date,
  description       text not null,
  amount            numeric not null check (amount > 0),
  added_by          text,
  created_at        timestamptz not null default now()
);

alter table budget_transactions enable row level security;
drop policy if exists app_all on budget_transactions;
create policy app_all on budget_transactions for all to anon, authenticated using (true) with check (true);

-- One-time migration: carry forward any existing lump-sum total_budget as an
-- opening-balance transaction so totals already set aren't lost. Guarded so
-- re-running this file never duplicates it.
insert into budget_transactions (category, description, amount)
select category, 'Opening balance', total_budget
from expense_budgets
where total_budget > 0
  and not exists (select 1 from budget_transactions bt where bt.category = expense_budgets.category);
