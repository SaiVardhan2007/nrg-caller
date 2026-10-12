-- Marks participants added on the spot from Attendance. Run once on the live database.
alter table yatra_participants add column if not exists is_new boolean not null default false;
