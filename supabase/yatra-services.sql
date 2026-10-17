-- FOLK Yatras: "Service List" tab (one row per service, with its owner(s) as a numbered list).
create table if not exists yatra_services (
  id            uuid primary key default gen_random_uuid(),
  yatra_id      uuid not null references yatras(id) on delete cascade,
  service_owner text,
  service_name  text not null,
  description   text,
  position      double precision,
  created_at    timestamptz not null default now()
);

create index if not exists yatra_services_yatra_idx on yatra_services(yatra_id);

alter table yatra_services enable row level security;
drop policy if exists app_all on yatra_services;
create policy app_all on yatra_services for all to anon, authenticated using (true) with check (true);
