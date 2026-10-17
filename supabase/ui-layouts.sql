-- Shared column-width / PDF-width settings (⇔ Columns and ⇔ PDF columns), so a change made
-- by one user applies for everyone. key = table (and tab) or download name; value = widths and margins.
create table if not exists ui_layouts (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table ui_layouts enable row level security;
drop policy if exists app_all on ui_layouts;
create policy app_all on ui_layouts for all to anon, authenticated using (true) with check (true);
