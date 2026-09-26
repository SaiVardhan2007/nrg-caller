-- NOT YET APPLIED. Run this once on the live database before using the new
-- "Limited Access" admin module (creates logins that can only see specific
-- admin pages).
--
-- allowed_pages holds the list of admin page IDs (e.g. "donations-analytics-
-- section") a "Limited Admin" role login is restricted to. Regular Admin/
-- Coordinator/Reception rows leave this null.

alter table users add column if not exists allowed_pages jsonb;

-- users.role had a CHECK constraint pinned to the original three roles,
-- so inserting/updating a "Limited Admin" row was rejected outright.
alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('Coordinator','Admin','Reception','Limited Admin'));

-- allowed_trip_events narrows the "Trip Expenses" grant (expenses-trip-section
-- in allowed_pages) down to specific trip_events.id values, so a Limited Admin
-- can be handed one trip event without seeing every other one. null means
-- "all trip events" (the default — matches pre-events behavior for anyone
-- already granted the Trip Expenses page).
alter table users add column if not exists allowed_trip_events jsonb;
