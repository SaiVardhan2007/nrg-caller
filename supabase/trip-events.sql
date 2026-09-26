-- NOT YET APPLIED. Run this once on the live database to enable Trip
-- Expenses' new "Events" grouping (Preaching/Residency Expenses are
-- untouched — they stay flat ledgers).
--
-- trip_events is a real row (not a text tag like donation_events) because
-- trip_expenses/budget_transactions rows need a stable event_id to group and
-- sum by, and so a deleted event can cleanly take its own data with it.

create table if not exists trip_events (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

alter table trip_events enable row level security;
drop policy if exists app_all on trip_events;
create policy app_all on trip_events for all to anon, authenticated using (true) with check (true);

-- on delete cascade: deleting an event's card is meant to take its expenses
-- and budget entries with it (the app warns with counts before deleting).
alter table trip_expenses add column if not exists event_id uuid references trip_events(id) on delete cascade;
alter table budget_transactions add column if not exists event_id uuid references trip_events(id) on delete cascade;

-- One-time migration: every trip_expenses/budget_transactions("trip") row
-- that predates this feature gets bucketed into a single default event so
-- existing data isn't orphaned. Guarded so re-running this file is a no-op
-- once it's already been done.
insert into trip_events (name)
select 'Mysore-Banglore Trip'
where not exists (select 1 from trip_events)
  and (exists (select 1 from trip_expenses) or exists (select 1 from budget_transactions where category = 'trip'));

update trip_expenses set event_id = (select id from trip_events order by created_at asc limit 1)
where event_id is null;

update budget_transactions set event_id = (select id from trip_events order by created_at asc limit 1)
where category = 'trip' and event_id is null;
